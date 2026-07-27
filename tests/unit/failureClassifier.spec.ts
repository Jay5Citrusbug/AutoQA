import { test, expect } from '@playwright/test';
import { classifyFailure } from '@/core/reporting/failureClassifier';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { ParsedStep } from '@/types/testCase';
import { StepExecutionResult } from '@/types/execution';

const step = (over: Partial<ParsedStep>): ParsedStep =>
  ({ stepIndex: 3, rawText: 'a step', type: 'action', targetField: 'Save', ...over }) as ParsedStep;

const failedWith = (s: ParsedStep, error: string): StepExecutionResult[] => [
  { stepIndex: 1, step: step({ type: 'action', action: 'navigate' }), status: 'passed', durationMs: 1, logs: [] },
  { stepIndex: 3, step: s, status: 'failed', durationMs: 1, logs: [], error },
];

test.describe('classifyFailure — only the application gets blamed for the application', () => {
  test('a passing run has no verdict', () => {
    expect(classifyFailure([{ stepIndex: 1, step: step({}), status: 'passed', durationMs: 1, logs: [] }])).toBeNull();
  });

  test('a failed assertion is a product defect and is filed', () => {
    // The step ran, the app answered, the answer was wrong.
    const v = classifyFailure(
      failedWith(
        step({ type: 'validation', validation: 'url' }),
        'URL validation failed after 15s. Expected URL to contain "/dashboard", but actual URL was "https://stage.optevo.com/desktop/home".',
      ),
    );
    expect(v?.kind).toBe('product-defect');
    expect(v?.fileAsBug).toBe(true);
  });

  test('an unreadable step is an automation gap and is NOT filed', () => {
    const v = classifyFailure(failedWith(step({ type: 'unparsed' }), 'Step could not be understood: "..."'));
    expect(v?.kind).toBe('automation-gap');
    expect(v?.fileAsBug).toBe(false);
  });

  test('an unresolvable locator is an automation gap and is NOT filed', () => {
    const v = classifyFailure(
      failedWith(step({ action: 'click', targetField: 'JR icon' }), 'Element not found for "JR icon" (best confidence 12%, need 35%).'),
    );
    expect(v?.kind).toBe('automation-gap');
    expect(v?.fileAsBug).toBe(false);
    expect(v?.reason).toContain('JR icon');
  });

  test('an unsupported action is an automation gap and is NOT filed', () => {
    const v = classifyFailure(failedWith(step({ action: 'click' }), 'Unsupported action: "hover"'));
    expect(v?.kind).toBe('automation-gap');
    expect(v?.fileAsBug).toBe(false);
  });

  test('missing test data is an automation gap and is NOT filed', () => {
    const v = classifyFailure(failedWith(step({ action: 'fill' }), 'Unresolved test-data variable(s): QA_TOKEN'));
    expect(v?.kind).toBe('automation-gap');
    expect(v?.fileAsBug).toBe(false);
  });

  test('a browser or network failure is an environment issue and is NOT filed', () => {
    for (const err of [
      'Browser launch/context error: Executable does not exist',
      'page.goto: net::ERR_NAME_NOT_RESOLVED',
      'Execution cancelled by user before browser started.',
    ]) {
      const v = classifyFailure(failedWith(step({ action: 'navigate' }), err));
      expect(v?.kind, err).toBe('environment');
      expect(v?.fileAsBug, err).toBe(false);
    }
  });

  test('an interaction that never completed is an automation gap by default', () => {
    // An overlay covering a button is a timing problem far more often than a
    // broken feature, so it is not raised against the product on its own.
    const v = classifyFailure(failedWith(step({ action: 'click' }), 'locator.click: Timeout 15000ms exceeded.'));
    expect(v?.kind).toBe('automation-gap');
    expect(v?.fileAsBug).toBe(false);
  });

  test('a server error during that same interaction makes it a product defect', () => {
    const v = classifyFailure(failedWith(step({ action: 'click' }), 'locator.click: Timeout 15000ms exceeded.'), {
      hasServerError: true,
    });
    expect(v?.kind).toBe('product-defect');
    expect(v?.fileAsBug).toBe(true);
  });

  test('an uncaught page exception makes it a product defect', () => {
    const v = classifyFailure(failedWith(step({ action: 'click' }), 'locator.click: Timeout 15000ms exceeded.'), {
      hasUncaughtError: true,
    });
    expect(v?.kind).toBe('product-defect');
  });

  test('app evidence never rescues a step that was never runnable', () => {
    // Nothing was asked of the application, so nothing can be concluded about it.
    const v = classifyFailure(failedWith(step({ type: 'unparsed' }), 'Step could not be understood'), {
      hasServerError: true,
    });
    expect(v?.kind).toBe('automation-gap');
    expect(v?.fileAsBug).toBe(false);
  });

  test('every verdict tells the reader what to do next', () => {
    const v = classifyFailure(failedWith(step({ type: 'validation' }), 'assertion failed'));
    expect(v?.nextStep.length).toBeGreaterThan(20);
  });
});

test.describe('TestCaseParser — steps that used to be silently mis-executed', () => {
  const parser = new TestCaseParser();

  test('an assertion mentioning credentials is not turned into a login', () => {
    // This previously matched the "invalid credentials" shorthand and typed
    // credentials into the form instead of checking the error message.
    const s = parser.parse(['System displays "Invalid credentials" message'])[0];
    expect(s.type).toBe('validation');
    expect(s.value).toBe('Invalid credentials');
  });

  test('the credentials shorthand still works when it is an instruction', () => {
    const s = parser.parse(['Enter valid credentials'])[0];
    expect(s).toMatchObject({ type: 'action', action: 'fill', targetField: 'credentials', value: 'valid' });
  });

  test('"Click on the X button" targets X, not the word "the"', () => {
    expect(parser.parse(['Click on the "Save" button'])[0].targetField).toBe('Save');
    expect(parser.parse(['Click the Login button'])[0].targetField).toBe('Login');
    expect(parser.parse(['click Login button'])[0].targetField).toBe('Login');
  });

  test('"No X is displayed" asserts absence, not the presence of "No X"', () => {
    expect(parser.parse(['No error message is displayed'])[0]).toMatchObject({
      validation: 'not_visible',
      targetField: 'error message',
    });
  });

  test('a keystroke is not treated as a click on an element named after the key', () => {
    const s = parser.parse(['Press Enter'])[0];
    expect(s.type).toBe('unparsed');
    expect(s.parseWarning).toContain('Unsupported action');
  });

  test('a real but unimplemented action says so instead of blaming the wording', () => {
    for (const line of ['Refresh the page', 'Hover over the Members avatar', 'Scroll down to the WorkPods section', 'Go back']) {
      const s = parser.parse([line])[0];
      expect(s.parseWarning, line).toContain('Unsupported action');
    }
  });

  test('common expected-result prose is understood rather than failing the run', () => {
    const cases: Array<[string, string]> = [
      ['The user can see the WorkHub menu', 'WorkHub'],
      ['User sees "Task created successfully"', 'Task created successfully'],
      ['Error message "Incorrect Email or Password" appears', 'Incorrect Email or Password'],
      ['A confirmation dialog appears', 'confirmation dialog'],
      ['The profile menu opens', 'profile menu'],
    ];
    for (const [line, expected] of cases) {
      const s = parser.parse([line])[0];
      expect(s.type, line).toBe('validation');
      expect(s.value, line).toBe(expected);
    }
  });

  test('"The Create Task button is enabled" is an enabled assertion', () => {
    expect(parser.parse(['The Create Task button is enabled'])[0]).toMatchObject({
      type: 'validation',
      validation: 'enabled',
    });
  });

  test('genuinely ambiguous prose stays unparsed rather than guessing', () => {
    // A wrong guess here would report a product defect that does not exist,
    // which is worse than admitting the step could not be read.
    expect(parser.parse(['Task count increases by 1'])[0].type).toBe('unparsed');
  });
});
