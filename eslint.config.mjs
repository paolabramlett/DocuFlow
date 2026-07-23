import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Vendored agent skills and generated artifacts. Not our code, and linting it drowns real
    // findings in third-party noise.
    ".agents/**",
    ".claude/**",
    "src/types/database.ts",

    // Supabase Edge Functions run on Deno, not Node — different globals, jsr: imports, and .ts
    // extensions. They are typechecked by the Supabase CLI / Deno, not this config.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
