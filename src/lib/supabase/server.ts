import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 *
 * `cookies()` is async in Next 16. The client reads the session from the request cookies and
 * writes refreshed cookies back where it can. Every query runs as the signed-in principal under
 * RLS — this is the anon key, never the service role.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` was called from a Server Component, where cookies are read-only. The proxy
          // (proxy.ts) refreshes the session cookie on every request, so this is safe to ignore.
        }
      },
    },
  });
}
