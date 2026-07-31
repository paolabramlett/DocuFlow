"use server";

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, type ActionResult } from "@/application/errors";

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const SIGNUP_COOLDOWN_SECONDS = 60;

function isExpectedNeutralSignupError(error: { status?: number }): boolean {
  // Rate-limit-shaped errors from Supabase's own GoTrue-level throttling are an expected outcome
  // under abuse, not a genuine operational failure worth alerting on.
  return error.status === 429;
}

export async function signUpAction(email: string): Promise<ActionResult<null>> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return ok(null); // neutral even on malformed input

  const normalizedEmail = parsed.data;
  const admin = createAdminClient();

  const { data: claimed, error: cooldownError } = await admin.rpc("claim_signup_attempt", {
    signup_email: normalizedEmail,
    cooldown_seconds: SIGNUP_COOLDOWN_SECONDS,
  });
  if (cooldownError || !claimed) return ok(null); // neutral even when cooldown-limited

  // The cooldown is consumed BEFORE calling auth.signUp(), intentionally. If GoTrue then fails
  // transiently, the caller waits out the same cooldown before their next attempt — preferable to
  // releasing the claim and letting repeated failures become a spam vector of their own.
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password: randomBytes(32).toString("base64url"),
  });

  if (error && !isExpectedNeutralSignupError(error)) {
    // Never the email, password, or token — matches this codebase's existing audit-metadata
    // discipline (src/features/audit/record.ts's FORBIDDEN_METADATA_KEYS).
    console.error("signUp failed", { code: error.code, status: error.status });
  }
  return ok(null);
}
