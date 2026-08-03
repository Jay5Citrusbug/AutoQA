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

// ---------------------------------------------------------------------------
// AUTO-SUPPLIED VALUES
//
// For steps that name a field but no value ("Enter workpod name"). The runner
// invents something plausible rather than refusing to run, and always reports
// what it used.
//
// Two properties matter more than realism:
//
//   • it must SUIT THE FIELD. Typing "WorkPod 1204-3312" into an email input
//     fails client-side validation and produces a confusing failure that looks
//     like an application defect. The field's own type and name decide the shape.
//   • it must be UNIQUE PER RUN. Create-flows routinely reject a duplicate name,
//     so a fixed value would pass the first time and fail every time after —
//     the single worst failure mode for a regression suite, because it looks
//     like a real regression appearing out of nowhere.
// ---------------------------------------------------------------------------

/** Short run-scoped token: distinct between runs, stable and readable within one. */
function uniqueToken(): string {
  const now = new Date();
  const stamp =
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  return stamp;
}

/** Describes the field an auto-value is being generated for. */
export interface AutoValueContext {
  /** The field name as written in the step ("workpod name"). */
  fieldName: string;
  /** The DOM input type, when the element has been resolved ("email", "number"…). */
  inputType?: string;
  /** The element's own placeholder, which often reveals the expected format. */
  placeholder?: string;
}

/**
 * Produces a value appropriate to the field, preferring the DOM's own evidence
 * (input type) over the wording of the step, since the browser will validate
 * against the former.
 */
export function generateAutoValue(ctx: AutoValueContext): string {
  const token = uniqueToken();
  const name = (ctx.fieldName || 'value').toLowerCase();
  const type = (ctx.inputType || '').toLowerCase();
  const hint = `${name} ${ctx.placeholder ?? ''}`.toLowerCase();

  const looksLike = (...words: string[]) => words.some((w) => hint.includes(w));

  if (type === 'email' || looksLike('email', 'e-mail')) return `qa.auto.${token.replace(/-/g, '')}@example.com`;
  if (type === 'password' || looksLike('password')) return `QaAuto!${token.replace(/-/g, '')}`;
  if (type === 'tel' || looksLike('phone', 'mobile', 'telephone')) return `+15550${token.replace(/\D/g, '').slice(-6)}`;
  if (type === 'url' || looksLike('website', 'url', 'link')) return `https://example.com/qa-${token}`;
  if (type === 'number' || looksLike('quantity', 'amount', 'count', 'age')) {
    return String((Number(token.replace(/\D/g, '').slice(-3)) || 1) % 100 || 7);
  }
  if (type === 'date' || looksLike('date')) {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Default: a readable label derived from the field itself, so the created
  // record is obviously test data when a human later finds it in the app.
  const label = (ctx.fieldName || 'QA Value')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `${label || 'QA Value'} ${token}`;
}
