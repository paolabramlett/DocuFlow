import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Component tests never make a real Supabase/Resend call — every Server Action a rendered
// component might transitively import is mocked per-test — but importing a "use client" module
// still evaluates every module in its import graph, including ones that read these env vars at
// top level (e.g. src/lib/supabase/env.ts, reached through @/components/app-shell ->
// @/features/auth/actions -> @/lib/supabase/server). Dummy values here exist only to satisfy
// those top-level `required(...)` checks so an unrelated component's import graph doesn't crash a
// test that never calls the real function.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:0';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'component-test-placeholder';
process.env.RESEND_API_KEY ??= 'component-test-placeholder';
process.env.APP_ORIGIN ??= 'http://localhost:3000';

// Unmounts every rendered tree after each test — without this, component state (and any DOM
// nodes) leaks across tests in the same file, matching @testing-library/react's own documented
// requirement for a framework that doesn't clean up automatically like Jest's globalSetup does.
afterEach(() => {
  cleanup();
});
