/**
 * loginFlow.ts — Recognises the login prologue at the front of a test case.
 *
 * A module written by a QA engineer normally repeats the same opening steps in
 * every TC:
 *
 *   TC02: Create a task
 *     Navigate to "https://stage.example.com/login"
 *     Enter valid credentials
 *     Click the login button
 *     ...the steps that actually test something...
 *
 * Those leading steps are the "login prologue". When a cached authenticated
 * session is available the prologue can be replaced by injecting the stored
 * storageState, which removes one full UI login per test case.
 *
 * Detection is deliberately conservative: anything ambiguous returns null so the
 * suite runs its login normally. A false negative costs a few seconds; a false
 * positive would silently skip real steps.
 */
import { ParsedStep } from '@/types/testCase';

/** Fields that identify the password input of a login form. */
const PASSWORD_FIELD = /pass(word|wd)?$|^pwd/i;
/** Fields that identify the username/email input of a login form. */
const USERNAME_FIELD = /user\s*name|username|^user$|email|login\s*id|^id$/i;
/** Clickable labels that submit a login form. */
const SUBMIT_LABEL = /log\s*-?\s*in|sign\s*-?\s*in|signin|login|submit|continue|next|enter/i;
/** Clickable labels (or any step text) that end the session. */
const LOGOUT_LABEL = /log\s*-?\s*out|logout|sign\s*-?\s*out|signout/i;
/**
 * Wording that marks a test case as a NEGATIVE login — one that expects the login
 * to be rejected. Matched against assertions, because that is where the intent is
 * unambiguous: a negative login test asserts an error, not a landing page.
 */
const REJECTED_LOGIN_TEXT =
  /invalid|incorrect|wrong|not\s+match|mismatch|failed|failure|unauthori[sz]ed|denied|must\s+be|required/i;

export interface LoginPrologue {
  /** Leading steps that perform the login — replaceable by a cached session. */
  steps: ParsedStep[];
  /** Number of leading steps the prologue covers (steps[0..length-1]). */
  length: number;
  /** Remaining steps that must always execute for real. */
  rest: ParsedStep[];
}

/** True when the step is a credential fill using the *invalid* credential set. */
function isInvalidCredentialStep(step: ParsedStep): boolean {
  return (
    step.type === 'action' &&
    step.action === 'fill' &&
    step.targetField === 'credentials' &&
    step.value !== 'valid'
  );
}

/** True when the step fills a password-like field (either the combined credential step or a discrete field). */
function isPasswordFill(step: ParsedStep): boolean {
  if (step.type !== 'action' || step.action !== 'fill') return false;
  if (step.targetField === 'credentials') return step.value === 'valid';
  return PASSWORD_FIELD.test(step.targetField || '');
}

/** True when the step fills a username/email field. */
function isUsernameFill(step: ParsedStep): boolean {
  if (step.type !== 'action' || step.action !== 'fill') return false;
  if (step.targetField === 'credentials') return step.value === 'valid';
  return USERNAME_FIELD.test(step.targetField || '');
}

/**
 * True when any step in the suite logs the user out. Such a suite must own its
 * session: a server-side logout can invalidate the token that parallel suites
 * are relying on, so it always performs its own login instead of reusing one.
 */
export function containsLogout(steps: ParsedStep[]): boolean {
  return steps.some((s) => LOGOUT_LABEL.test(s.targetField || '') || LOGOUT_LABEL.test(s.rawText || ''));
}

/**
 * True when the suite exercises a negative-login path — never reuse an
 * authenticated session for it, and never treat its credentials as a login flow
 * worth caching.
 *
 * Two forms are recognised:
 *   • the `enter invalid credentials` shorthand, and
 *   • a login that asserts a rejection ("verify \"Incorrect Email or Password\" is
 *     visible"), which is how a negative case is written when the wrong values are
 *     typed literally.
 */
export function usesInvalidCredentials(steps: ParsedStep[]): boolean {
  if (steps.some(isInvalidCredentialStep)) return true;

  return steps.some(
    (s) =>
      s.type === 'validation' &&
      (s.validation === 'error_msg' ||
        REJECTED_LOGIN_TEXT.test(s.value || '') ||
        REJECTED_LOGIN_TEXT.test(s.targetField || '')),
  );
}

/**
 * True when the suite enters credentials at all (valid or invalid).
 *
 * A suite WITHOUT login steps either assumes an already-authenticated browser
 * ("navigate to /desktop/home, open the profile menu…") or deliberately tests the
 * logged-out state. The runner uses this to decide whether a suite can recover on
 * its own when a cached session turns out to be unusable.
 */
export function hasLoginSteps(steps: ParsedStep[]): boolean {
  return steps.some(
    (s) =>
      s.type === 'action' &&
      s.action === 'fill' &&
      (s.targetField === 'credentials' || PASSWORD_FIELD.test(s.targetField || '')),
  );
}

/**
 * Extracts the login prologue from the front of a step list, or returns null
 * when the suite does not open with a recognisable login.
 *
 * The prologue runs from step 0 up to and including the click that submits the
 * login form. Every step in that range must be a plain action (navigate / fill /
 * click / wait / check) — if an assertion sits inside the login sequence we
 * decline to skip it, since skipping would silently drop that coverage.
 */
export function detectLoginPrologue(steps: ParsedStep[]): LoginPrologue | null {
  if (steps.length < 2) return null;
  if (usesInvalidCredentials(steps) || containsLogout(steps)) return null;

  const passwordIdx = steps.findIndex(isPasswordFill);
  if (passwordIdx === -1) return null;

  // A login needs an identity too — either the combined "valid credentials" step
  // (which fills both) or a discrete username/email fill before the password.
  const combined = steps[passwordIdx].targetField === 'credentials';
  if (!combined && !steps.slice(0, passwordIdx).some(isUsernameFill)) return null;

  // The submit click must directly follow the credential fills.
  let submitIdx = -1;
  for (let i = passwordIdx + 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'action' && s.action === 'click') {
      if (!SUBMIT_LABEL.test(s.targetField || '')) return null; // clicked something else first
      submitIdx = i;
      break;
    }
    // Fills/waits between the password and submit are fine (e.g. "check Remember me").
    if (s.type !== 'action') return null;
    if (!['fill', 'wait', 'check', 'uncheck', 'select'].includes(s.action || '')) return null;
  }
  if (submitIdx === -1) return null;

  // Every prologue step must be a plain action — no assertions get skipped.
  const prologue = steps.slice(0, submitIdx + 1);
  if (prologue.some((s) => s.type !== 'action')) return null;

  // A prologue that never navigates has no anchor URL of its own; the runner's
  // base URL covers that case, so this is allowed.
  return { steps: prologue, length: prologue.length, rest: steps.slice(submitIdx + 1) };
}
