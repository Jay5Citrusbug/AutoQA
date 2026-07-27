import { test, expect } from '@playwright/test';
import { matchUrlLiterally, matchUrlSemantically, roleOf } from '@/core/validation/urlMatcher';
import { TestCaseParser } from '@/core/parser/testCaseParser';

test.describe('matchUrlLiterally — tolerant about spelling, strict about the page', () => {
  const hit = (expected: string, actual: string) => matchUrlLiterally(expected, actual);

  test('a plain substring still matches', () => {
    expect(hit('/dashboard', 'https://app.com/dashboard').tier).toBe('exact');
  });

  test('trailing slashes and case do not matter', () => {
    expect(hit('/Dashboard/', 'https://app.com/dashboard').matched).toBe(true);
    expect(hit('/dashboard', 'https://app.com/Dashboard/').matched).toBe(true);
  });

  test('a query string does not break the match', () => {
    expect(hit('/dashboard', 'https://app.com/app/dashboard?tab=recent&x=1').matched).toBe(true);
  });

  test('a hash fragment does not break the match', () => {
    expect(hit('/dashboard', 'https://app.com/dashboard#widgets').matched).toBe(true);
  });

  test('a differing host or subdomain does not break the match', () => {
    // A test case written against one environment should still run on another.
    const r = hit('https://app.com/dashboard', 'https://stage.app.com/dashboard?x=1');
    expect(r.matched).toBe(true);
    expect(r.tier).toBe('segment');
  });

  test('a multi-segment fragment must appear contiguously', () => {
    expect(hit('/desktop/home', 'https://app.com/desktop/home').matched).toBe(true);
    expect(hit('/desktop/home', 'https://app.com/desktop/x/home').matched).toBe(false);
  });

  test('genuinely different pages do not match literally', () => {
    expect(hit('/dashboard', 'https://stage.optevo.com/desktop/home').matched).toBe(false);
  });
});

test.describe('roleOf — recognising the kind of page a path names', () => {
  test('landing-page vocabulary', () => {
    for (const p of ['/dashboard', '/home', '/desktop/home', '/overview', '/portal', '/workspace']) {
      expect(roleOf(p), p).toBe('landing');
    }
  });

  test('sign-in vocabulary', () => {
    for (const p of ['/login', '/signin', '/sign-in', '/auth']) {
      expect(roleOf(p), p).toBe('auth');
    }
  });

  test('everything else has no role, and so stays strict', () => {
    for (const p of ['/settings', '/billing', '/users/42', '/reports/export']) {
      expect(roleOf(p), p).toBeNull();
    }
  });

  test('a role word must be a whole segment', () => {
    expect(roleOf('/user-dashboard-settings')).toBeNull();
  });
});

test.describe('matchUrlSemantically — the real case, and its limits', () => {
  test('accepts /dashboard against an app whose landing page is /desktop/home', () => {
    // Exactly the reported scenario: Optevo has no "dashboard", its post-login
    // page is /desktop/home, and the test case says /dashboard.
    const r = matchUrlSemantically('/dashboard/', 'https://stage.optevo.com/desktop/home', true);
    expect(r.matched).toBe(true);
    expect(r.tier).toBe('semantic');
    expect(r.role).toBe('landing');
  });

  test('the pass explains itself and names both routes', () => {
    const r = matchUrlSemantically('/dashboard', 'https://stage.optevo.com/desktop/home', true);
    expect(r.note).toContain('/dashboard');
    expect(r.note).toContain('desktop/home');
    expect(r.note).toContain('NOT verified literally');
  });

  test('REFUSES without corroboration that the page is a signed-in view', () => {
    // A failed login parked on something like /home must not pass.
    expect(matchUrlSemantically('/dashboard', 'https://app.com/home', false).matched).toBe(false);
  });

  test('REFUSES across different page roles', () => {
    expect(matchUrlSemantically('/dashboard', 'https://app.com/login', true).matched).toBe(false);
  });

  test('REFUSES when the expected page has no well-known role', () => {
    // /settings vs /billing are genuinely different claims and stay strict.
    expect(matchUrlSemantically('/settings', 'https://app.com/billing', true).matched).toBe(false);
    expect(matchUrlSemantically('/reports', 'https://app.com/desktop/home', true).matched).toBe(false);
  });

  test('REFUSES to excuse a landing page that is actually an error page', () => {
    expect(matchUrlSemantically('/dashboard', 'https://app.com/error', true).matched).toBe(false);
    expect(matchUrlSemantically('/dashboard', 'https://app.com/maintenance', true).matched).toBe(false);
  });

  test('sign-in pages are equivalent across naming conventions', () => {
    expect(matchUrlSemantically('/login', 'https://app.com/signin', true).matched).toBe(true);
  });
});

test.describe('verify url is exactly X — opting back into a literal route', () => {
  const parser = new TestCaseParser();

  test('"exactly" sets the strict flag and is not swallowed into the value', () => {
    const s = parser.parse(['verify url is exactly /desktop/home'])[0];
    expect(s.strict).toBe(true);
    expect(s.value).toBe('/desktop/home');
  });

  test('an ordinary url assertion is not strict', () => {
    const s = parser.parse(['verify url contains /dashboard'])[0];
    expect(s.strict).toBeUndefined();
    expect(s.value).toBe('/dashboard');
  });
});
