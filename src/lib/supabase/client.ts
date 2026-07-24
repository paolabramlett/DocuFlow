"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

/**
 * Supabase client for Client Components. Carries the anon key and the user's session cookie, so
 * every query runs as the signed-in principal under RLS — never the service role.
 *
 * The NEXT_PUBLIC_* vars are referenced statically here on purpose: Next inlines them into the
 * browser bundle only for static `process.env.X` access, not the dynamic lookup used server-side.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
