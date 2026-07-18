/**
 * testData.ts — Environment-driven test data resolution.
 *
 * Test steps may reference variables as {{var_name}} (e.g. "Enter {{qa_valid_username}} into email").
 * Variables resolve from process.env after normalizing the name to UPPER_SNAKE_CASE.
 * Only env vars prefixed with QA_ or TEST_ can be referenced, so steps can never
 * read unrelated secrets from the server environment.
 */

export const VAR_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_\-.]*)\s*\}\}/g;
const ALLOWED_PREFIXES = ['QA_', 'TEST_'];

/** Normalizes a step variable name to its env var name: "qa valid-username" -> "QA_VALID_USERNAME" */
export function toEnvName(varName: string): string {
  return varName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export interface SubstitutionResult {
  text: string;
  /** Variables that could not be resolved (missing or disallowed prefix) */
  missing: string[];
  /** True when at least one substitution was applied */
  substituted: boolean;
}

/**
 * Replaces every {{var}} occurrence with its env value.
 * Unresolvable variables are left in place and reported in `missing`.
 */
export function substituteVariables(text: string): SubstitutionResult {
  const missing: string[] = [];
  let substituted = false;

  const result = text.replace(VAR_PATTERN, (raw, varName: string) => {
    const envName = toEnvName(varName);
    if (!ALLOWED_PREFIXES.some((p) => envName.startsWith(p))) {
      missing.push(`${varName} (only QA_* / TEST_* variables are allowed)`);
      return raw;
    }
    const value = process.env[envName];
    if (value === undefined || value === '') {
      missing.push(`${varName} (set ${envName} in .env)`);
      return raw;
    }
    substituted = true;
    return value;
  });

  return { text: result, missing, substituted };
}

export interface Credentials {
  username: string;
  password: string;
}

/**
 * Resolves the credential pair used by "enter valid/invalid credentials" steps.
 * Valid credentials MUST be configured; invalid ones fall back to harmless dummies.
 */
export function getCredentials(kind: 'valid' | 'invalid'): Credentials {
  if (kind === 'valid') {
    const username = process.env.QA_VALID_USERNAME;
    const password = process.env.QA_VALID_PASSWORD;
    if (!username || !password) {
      throw new Error(
        'Valid test credentials are not configured. Set QA_VALID_USERNAME and QA_VALID_PASSWORD in .env (see .env.example).',
      );
    }
    return { username, password };
  }

  return {
    username: process.env.QA_INVALID_USERNAME || 'invalid_user@example.com',
    password: process.env.QA_INVALID_PASSWORD || 'WrongPassword123!',
  };
}
