import { test, expect } from '@playwright/test';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import {
  detectLoginPrologue,
  containsLogout,
  usesInvalidCredentials,
  hasLoginSteps,
} from '@/core/execution/loginFlow';
import { computeSessionKey } from '@/core/execution/sessionManager';

const parser = new TestCaseParser();
const steps = (...lines: string[]) => parser.parse(lines);

const LOGIN = [
  'Navigate to "https://stage.optevo.com/login"',
  'Enter valid credentials',
  'Click the login button',
];

test.describe('detectLoginPrologue — recognises a skippable login', () => {
  test('detects the combined "valid credentials" login flow', () => {
    const s = steps(...LOGIN, 'Click on Create Task', 'Verify that url contains /tasks');
    const prologue = detectLoginPrologue(s);

    expect(prologue).not.toBeNull();
    expect(prologue!.length).toBe(3);
    expect(prologue!.rest.map((r) => r.rawText)).toEqual(['Click on Create Task', 'Verify that url contains /tasks']);
  });

  test('detects discrete username + password fills', () => {
    const s = steps(
      'Navigate to "https://the-internet.herokuapp.com/login"',
      'Enter "tomsmith" into input "username"',
      'Enter "SuperSecretPassword!" into input "password"',
      'Click the login button',
      'Verify that text "Secure Area" is visible',
    );
    const prologue = detectLoginPrologue(s);

    expect(prologue).not.toBeNull();
    expect(prologue!.length).toBe(4);
    expect(prologue!.rest).toHaveLength(1);
  });

  test('allows a "remember me" checkbox inside the login flow', () => {
    const s = steps(...LOGIN.slice(0, 2), 'Check the "Remember me" checkbox', 'Click the login button', 'Click Profile');
    const prologue = detectLoginPrologue(s);

    expect(prologue).not.toBeNull();
    expect(prologue!.length).toBe(4);
  });

  test('a test case that only asserts the landing page is still eligible', () => {
    // "login -> verify url contains /dashboard" is the most common TC shape in a
    // module. Restoring a session and landing on the dashboard satisfies it, so it
    // must reuse; a post-login assertion that genuinely needs a real login is
    // recovered by the runner's retry, not excluded up front.
    const s = steps(...LOGIN, 'verify url contains /dashboard');
    const prologue = detectLoginPrologue(s);

    expect(prologue).not.toBeNull();
    expect(prologue!.rest).toHaveLength(1);
  });
});

test.describe('hasLoginSteps — can a test case log itself in?', () => {
  test('true for the credentials shorthand and for discrete password fills', () => {
    expect(hasLoginSteps(steps(...LOGIN))).toBe(true);
    expect(
      hasLoginSteps(steps('fill Email field with a@b.com', 'fill Password field with Secret1')),
    ).toBe(true);
  });

  test('false for a continuation test case that jumps into an authenticated page', () => {
    const s = steps(
      'navigate to https://stage.optevo.com/desktop/home',
      'Click on Profile',
      'verify that text "Settings" is visible',
    );
    expect(hasLoginSteps(s)).toBe(false);
  });
});

test.describe('detectLoginPrologue — declines when reuse would be unsafe', () => {
  test('never reuses a session for a negative-login test case', () => {
    const s = steps('Navigate to "https://stage.optevo.com/login"', 'Enter invalid credentials', 'Click the login button', 'Verify that an error message is visible');

    expect(usesInvalidCredentials(s)).toBe(true);
    expect(detectLoginPrologue(s)).toBeNull();
  });

  test('recognises a negative login written with literal wrong values', () => {
    // No "invalid credentials" keyword — the intent shows in the assertion. Without
    // this, the runner would treat the rejected login as a cacheable flow.
    const s = steps(
      'navigate to https://stage.optevo.com/login',
      'fill Email field with wrong@example.com',
      'fill Password field with WrongPass',
      'click Login button',
      'verify "Incorrect Email or Password" is visible',
    );

    expect(usesInvalidCredentials(s)).toBe(true);
    expect(detectLoginPrologue(s)).toBeNull();
  });

  test('never reuses a session for a test case that logs out', () => {
    const s = steps(...LOGIN, 'Click the Logout button', 'Verify that url contains /login');

    expect(containsLogout(s)).toBe(true);
    expect(detectLoginPrologue(s)).toBeNull();
  });

  test('declines when an assertion sits inside the login sequence', () => {
    const s = steps(
      'Navigate to "https://stage.optevo.com/login"',
      'Enter valid credentials',
      'Verify that the login button is enabled',
      'Click the login button',
      'Click Profile',
    );

    expect(detectLoginPrologue(s)).toBeNull();
  });

  test('declines when a non-submit click interrupts the login', () => {
    const s = steps('Navigate to "https://stage.optevo.com/login"', 'Enter valid credentials', 'Click on Forgot Password', 'Click the login button');

    expect(detectLoginPrologue(s)).toBeNull();
  });

  test('declines a test case with no login at all', () => {
    const s = steps('Navigate to "https://example.com/search"', 'Enter "laptop" into search box', 'Click Search');

    expect(detectLoginPrologue(s)).toBeNull();
  });
});

test.describe('parseTestSuites — session directives', () => {
  const MODULE = [
    'TC01: Login shows the welcome banner',
    ...LOGIN,
    'page should contain "Welcome"',
    '',
    'TC02: Create a task @fresh-login',
    ...LOGIN,
    'Click on Create Task',
    '',
    'TC03: Dashboard KPIs',
    '@reuse-session',
    ...LOGIN,
    'Verify that text "KPI" is visible',
  ].join('\n');

  const suites = parser.parseTestSuites(MODULE);

  test('splits into three suites', () => {
    expect(suites.map((s) => s.id)).toEqual(['TC01', 'TC02', 'TC03']);
  });

  test('@fresh-login on the TC header flags the suite', () => {
    expect(suites.find((s) => s.id === 'TC02')?.freshLogin).toBe(true);
    expect(suites.find((s) => s.id === 'TC01')?.freshLogin).toBeUndefined();
  });

  test('@reuse-session on its own line flags the suite without becoming a step', () => {
    const tc03 = suites.find((s) => s.id === 'TC03')!;
    expect(tc03.forceReuse).toBe(true);
    expect(tc03.steps.some((s) => s.type === 'unparsed')).toBe(false);
    expect(tc03.steps.some((s) => s.rawText.includes('@'))).toBe(false);
  });

  test('directives never leak into a step value', () => {
    suites.forEach((s) => s.steps.forEach((step) => expect(step.value ?? '').not.toContain('@reuse')));
  });
});

test.describe('computeSessionKey — isolates sessions that must not be shared', () => {
  const login = steps(...LOGIN);
  const base = { url: 'https://stage.optevo.com/login', browser: 'chromium' as const, deviceMode: 'desktop' as const, loginSteps: login };

  test('identical login flows share a key', () => {
    expect(computeSessionKey(base)).toBe(computeSessionKey({ ...base, loginSteps: steps(...LOGIN) }));
  });

  test('a different browser engine gets its own session', () => {
    expect(computeSessionKey({ ...base, browser: 'firefox' })).not.toBe(computeSessionKey(base));
  });

  test('a different device profile gets its own session', () => {
    expect(computeSessionKey({ ...base, deviceMode: 'mobile-android' })).not.toBe(computeSessionKey(base));
  });

  test('a different target site gets its own session', () => {
    expect(computeSessionKey({ ...base, url: 'https://prod.optevo.com/login' })).not.toBe(computeSessionKey(base));
  });

  test('a different user gets its own session', () => {
    const asAdmin = steps(
      'Navigate to "https://stage.optevo.com/login"',
      'Enter {{qa_admin_username}} into email field',
      'Enter {{qa_admin_password}} into password field',
      'Click the login button',
    );
    expect(computeSessionKey({ ...base, loginSteps: asAdmin })).not.toBe(computeSessionKey(base));
  });
});
