import { type EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Exchanges an invite/recovery email link's token for a real session, server-side, before the
 * browser ever sees a page. Supabase's own hosted verify link returns the session in a URL
 * fragment (the implicit flow) — the fragment never reaches the server, and this app's
 * cookie-based `@supabase/ssr` client does not consume it on the client either, so a fragment-only
 * link left whatever session already existed in the browser untouched. That silently let a
 * visitor who was already signed in as someone else (e.g. the inviting owner testing their own
 * link) submit /set-password's form against their OWN account instead of the invited one's.
 *
 * Routing the email templates through this handler instead (token_hash + type, not a fragment)
 * lets verifyOtp() run here, where the server client can write the resulting session directly to
 * the response cookies — so by the time /set-password loads, the correct session is already the
 * only one that exists.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/set-password";

  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      redirect(next);
    }
  }

  redirect("/set-password");
}
