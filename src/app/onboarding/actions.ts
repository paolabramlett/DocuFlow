"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getStaffContext, resolveOnboardingRedirect } from "@/features/auth/context";
import { passwordsAreValid } from "@/features/auth/password";
import { ValidationError, parseInput } from "@/lib/validation/parse";
import { fail, ok, type ActionResult } from "@/application/errors";

const completeOnboardingSchema = z.object({
  organizationName: z.string().trim().min(1).max(200),
  organizationIndustry: z.enum(["notary", "accounting", "legal", "insurance", "hr", "other"]),
});

export async function completeOnboardingAction(input: {
  password: string;
  passwordConfirmation: string;
  organizationName: string;
  organizationIndustry: string;
}): Promise<ActionResult<{ organizationId: string }>> {
  // Guard without redirecting: this action must always return an ActionResult (the page owns
  // navigation), so it cannot call requireOnboarding() directly — that helper calls redirect()
  // when the caller is already staff, which would both violate that contract and break the
  // idempotent-retry case below (a resubmit after the organization already exists must succeed
  // with the existing organizationId, not throw a NEXT_REDIRECT). resolveOnboardingRedirect is
  // the pure decision Task 3 built for exactly this: same state matrix, no redirect() call.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let staffContext;
  try {
    staffContext = user !== null ? await getStaffContext() : null;
  } catch (error) {
    // getStaffContext() throws on a genuine query failure (not "no membership yet") — this action
    // must never throw across the client boundary, so surface it as a normal ActionResult instead.
    return fail(error);
  }
  const redirectTarget = resolveOnboardingRedirect(user !== null, staffContext !== null);

  if (redirectTarget === "/login") {
    return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
  }
  if (redirectTarget === "/cases" && staffContext) {
    // Already onboarded (e.g. a resubmit after a prior call already succeeded) — idempotent
    // no-op, matching complete_onboarding's own idempotency rather than erroring or redirecting.
    return ok({ organizationId: staffContext.organizationId });
  }

  if (!passwordsAreValid(input.password, input.passwordConfirmation)) {
    return { ok: false, reason: "validation", message: "Revisa tu contraseña." };
  }
  let parsed;
  try {
    parsed = parseInput(completeOnboardingSchema, {
      organizationName: input.organizationName,
      organizationIndustry: input.organizationIndustry,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, reason: "validation", message: "Revisa los datos de tu organización.", issues: error.issues };
    }
    throw error;
  }

  // Order is load-bearing: password MUST be set before the organization exists. If this were
  // reversed and failed between steps, the account would have an organization but no way to ever
  // learn its password — a lock with no key. This order self-heals instead: if step 2 fails, the
  // user can still log in (their real password is already set) and requireStaff() routes them
  // straight back here to retry, since they still have no organization.
  const { error: passwordError } = await supabase.auth.updateUser({ password: input.password });
  if (passwordError) {
    return { ok: false, reason: "unexpected", message: "No pudimos guardar tu contraseña. Intenta de nuevo." };
  }

  const { data: organizationId, error: orgError } = await supabase.rpc("complete_onboarding", {
    organization_name: parsed.organizationName.trim(),
    organization_industry: parsed.organizationIndustry.trim(),
  });
  // No non-null assertion: "no error but no UUID either" must never be read as success, even
  // though the SQL function's own `returns uuid` makes it look like that combination can't
  // happen — the generated client type is nullable, and this is exactly the kind of anomaly
  // worth surfacing rather than silently trusting.
  if (orgError || !organizationId) {
    return {
      ok: false,
      reason: "unexpected",
      message: "Tu contraseña se guardó, pero no pudimos crear la organización. Intenta nuevamente.",
    };
  }

  return ok({ organizationId });
}
