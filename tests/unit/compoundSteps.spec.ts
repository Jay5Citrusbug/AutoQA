import { test, expect } from '@playwright/test';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { parsePositionHint } from '@/core/discovery/elementDiscovery';
import { extractInitials, isProfileTarget } from '@/core/discovery/strategies';
import { shouldRetryAfterReuse } from '@/core/execution/loginFlow';
import { ParsedStep } from '@/types/testCase';
import { StepExecutionResult } from '@/types/execution';

const parser = new TestCaseParser();

test.describe('TestCaseParser — a numbered sequence pasted onto one line', () => {
  // Steps arrive from spreadsheets and tickets as a single cell. Before this,
  // only the first item ran and the rest was silently swallowed as one step.
  const LINE =
    '1.Navigate to https://stage.optevo.com/desktop/home 2. Click JR icon button right top 3. Click Logout4. Click Yes';

  test('expands into one step per numbered item', () => {
    const steps = parser.parse([LINE]);
    expect(steps.map((s) => s.action)).toEqual(['navigate', 'click', 'click', 'click']);
    expect(steps[0].value).toBe('https://stage.optevo.com/desktop/home');
    expect(steps[1].targetField).toBe('JR icon button right top');
    expect(steps[2].targetField).toBe('Logout');
    expect(steps[3].targetField).toBe('Yes');
  });

  test('numbers the expanded steps sequentially', () => {
    expect(parser.parse([LINE]).map((s) => s.stepIndex)).toEqual([1, 2, 3, 4]);
  });

  test('splits even when a marker is glued to the previous word', () => {
    // "Logout4." — no space before the marker, which is how people actually type.
    const steps = parser.parse(['1. Click Logout2. Click Yes']);
    expect(steps).toHaveLength(2);
    expect(steps[1].targetField).toBe('Yes');
  });

  test('a sequence that does not start at 1 still splits', () => {
    const steps = parser.parse(['2. Click Save 3. Click Close']);
    expect(steps.map((s) => s.targetField)).toEqual(['Save', 'Close']);
  });
});

test.describe('TestCaseParser — leaves ordinary lines unsplit', () => {
  const unchanged = (line: string, expected: number) => {
    const steps = parser.parse([line]);
    expect(steps, `"${line}" should yield ${expected} step(s)`).toHaveLength(expected);
    return steps;
  };

  test('a decimal is not a step marker', () => {
    const [s] = unchanged('wait 2.5 seconds', 1);
    expect(s.action).toBe('wait');
  });

  test('digits inside a URL are not step markers', () => {
    const [s] = unchanged('navigate to http://1.2.3.4/login', 1);
    expect(s.value).toBe('http://1.2.3.4/login');
  });

  test('a version number is not a step marker', () => {
    unchanged('enter version 1.2 into Build field', 1);
  });

  test('a single leading number is stripped, not split', () => {
    const [s] = unchanged('1. click Submit', 1);
    expect(s.action).toBe('click');
    expect(s.targetField).toBe('Submit');
  });

  test('non-consecutive numbers do not form a sequence', () => {
    unchanged('1. Click Save 7. Click Close', 1);
  });
});

test.describe('TestCaseParser — expected-result prose', () => {
  test('a redirection sentence asserts both the route and the quoted text', () => {
    const steps = parser.parse([
      'User is redirected to Login page where "Welcome Back!" heading and login details text are visible',
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ type: 'validation', validation: 'url', value: '/login' });
    expect(steps[1]).toMatchObject({ type: 'validation', validation: 'visible', value: 'Welcome Back!' });
  });

  test('"Verify Login page" becomes a route assertion, not a body-text search', () => {
    // "Login" as body text appears on pages that are not /login, so the routing
    // claim is the one worth checking.
    expect(parser.parse(['Verify Login page'])[0]).toMatchObject({
      type: 'validation',
      validation: 'url',
      value: '/login',
    });
  });

  test('a multi-word page name is not turned into a guessed slug', () => {
    // "/quick-notes" would be invented, so this falls through to a text assertion.
    const s = parser.parse(['Verify Quick Notes page'])[0];
    expect(s.value).not.toBe('/quick-notes');
  });

  test('declarative visibility without a leading verb is understood', () => {
    const steps = parser.parse(['"Welcome Back!" heading and login details text are visible']);
    expect(steps[0]).toMatchObject({ validation: 'visible', value: 'Welcome Back!' });
  });

  test('every quoted phrase gets its own assertion', () => {
    const steps = parser.parse(['"Dashboard" and "Sign out" are visible']);
    expect(steps.map((s) => s.value)).toEqual(['Dashboard', 'Sign out']);
  });

  test('a restated assertion is not run twice', () => {
    const steps = parser.parse(['Verify Login page', 'User is redirected to Login page']);
    expect(steps).toHaveLength(1);
  });

  test('prose that states no checkable claim is still reported as unparsed', () => {
    expect(parser.parse(['the user thinks about it'])[0].type).toBe('unparsed');
  });
});

test.describe('parsePositionHint — location wording steers the search', () => {
  test('reads "right top" and strips it from the text', () => {
    const { cleaned, hint } = parsePositionHint('JR icon button right top');
    expect(hint).toEqual({ vertical: 'top', horizontal: 'right' });
    expect(cleaned).toBe('JR icon button');
  });

  test('reads "top-right corner"', () => {
    expect(parsePositionHint('profile top-right corner').hint).toEqual({ vertical: 'top', horizontal: 'right' });
  });

  test('reads "bottom left"', () => {
    expect(parsePositionHint('bottom left menu').hint).toEqual({ vertical: 'bottom', horizontal: 'left' });
  });

  test('a lone direction word stays part of the label', () => {
    // "Left" here names the control; treating it as a location would break the match.
    const { cleaned, hint } = parsePositionHint('Left panel');
    expect(hint).toBeNull();
    expect(cleaned).toBe('Left panel');
  });
});

test.describe('avatar targets', () => {
  test('bare initials are recognised', () => {
    expect(extractInitials('JR')).toBe('JR');
    expect(extractInitials('JR icon')).toBe('JR');
    expect(extractInitials('JR icon button')).toBe('JR');
  });

  test('a real label is not mistaken for initials', () => {
    expect(extractInitials('Login')).toBeNull();
    expect(extractInitials('Save changes')).toBeNull();
  });

  test('profile vocabulary is recognised', () => {
    expect(isProfileTarget('profile icon')).toBe(true);
    expect(isProfileTarget('account avatar')).toBe(true);
    expect(isProfileTarget('Login button')).toBe(false);
  });
});

test.describe('shouldRetryAfterReuse — one retry, and only when it could help', () => {
  const step = (over: Partial<ParsedStep>): ParsedStep =>
    ({ stepIndex: 1, rawText: 'x', type: 'action', targetField: 'x', ...over }) as ParsedStep;

  const failed = (s: ParsedStep, pageUrl?: string): StepExecutionResult[] => [
    { stepIndex: 1, step: s, status: 'failed', durationMs: 1, logs: [], pageUrl },
  ];

  test('does not retry a parse error', () => {
    const v = shouldRetryAfterReuse(failed(step({ type: 'unparsed' })));
    expect(v.worthRetrying).toBe(false);
  });

  test('does not retry an assertion that failed on an authenticated page', () => {
    // The real case: the app lands on /desktop/home and the test expects
    // /dashboard. That disagreement survives any number of fresh logins.
    const s = step({ type: 'validation', validation: 'url', value: '/dashboard' });
    expect(shouldRetryAfterReuse(failed(s, 'https://stage.optevo.com/desktop/home')).worthRetrying).toBe(false);
  });

  test('does retry when the app bounced back to the login screen', () => {
    const s = step({ type: 'validation', validation: 'url', value: '/dashboard' });
    expect(shouldRetryAfterReuse(failed(s, 'https://stage.optevo.com/login')).worthRetrying).toBe(true);
  });

  test('does retry an action failure — the element may be missing because we were logged out', () => {
    const s = step({ type: 'action', action: 'click', targetField: 'Logout' });
    expect(shouldRetryAfterReuse(failed(s, 'https://stage.optevo.com/desktop/home')).worthRetrying).toBe(true);
  });

  test('does not retry when nothing failed', () => {
    expect(shouldRetryAfterReuse([]).worthRetrying).toBe(false);
  });
});
