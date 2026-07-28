function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

export const SUPABASE_URL = required('NEXT_PUBLIC_SUPABASE_URL');
export const SUPABASE_ANON_KEY = required('NEXT_PUBLIC_SUPABASE_ANON_KEY');
export const RESEND_API_KEY = required('RESEND_API_KEY');

/**
 * Reads the service role key, and refuses to do so anywhere a browser could reach.
 *
 * The key bypasses RLS entirely, so the guard is a hard failure rather than a lint rule.
 */
export function serviceRoleKey(): string {
  if (typeof window !== 'undefined') {
    throw new Error('The service role key must never be read in the browser');
  }
  return required('SUPABASE_SERVICE_ROLE_KEY');
}
