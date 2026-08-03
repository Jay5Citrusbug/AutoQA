import { test, expect } from '@playwright/test';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { lintStepsText } from '@/core/parser/stepLinter';
import { generateAutoValue } from '@/utils/testData';
import { ParsedStep } from '@/types/testCase';

const parser = new TestCaseParser();
const parseOne = (line: string): ParsedStep => parser.parse([line])[0];

/**
 * The grammar used to be four hand-written regexes with four different verb
 * lists, so `fill X with Y` worked and `enter X with Y` did not. These lock the
 * matrix down: the point is not that any one phrasing works, it is that the
 * supported verbs and connectors combine freely.
 */
test.describe('fill grammar — verbs × connectors', () => {
  const verbs = ['enter', 'type', 'fill', 'input', 'provide', 'supply', 'write'];
  for (const verb of verbs) {
    test(`"${verb} FIELD with VALUE"`, () => {
      const s = parseOne(`${verb} Email field with bob@x.com`);
      expect(s.action, `${verb} + with should be a fill`).toBe('fill');
      expect(s.targetField).toBe('Email');
      expect(s.value).toBe('bob@x.com');
    });

    test(`"${verb} FIELD as VALUE"`, () => {
      const s = parseOne(`${verb} Email field as bob@x.com`);
      expect(s.action).toBe('fill');
      expect(s.targetField).toBe('Email');
      expect(s.value).toBe('bob@x.com');
    });
  }

  test('value-first phrasing keeps its original reading', () => {
    const s = parseOne('Enter "tomsmith" into username field');
    expect(s.action).toBe('fill');
    expect(s.targetField).toBe('username');
    expect(s.value).toBe('tomsmith');
  });

  test('"set FIELD to VALUE" reads field-first', () => {
    const s = parseOne('Set workpod name to My Pod');
    expect(s.action).toBe('fill');
    expect(s.targetField).toBe('workpod name');
    expect(s.value).toBe('My Pod');
  });

  test('symbol separators still work', () => {
    expect(parseOne('enter password = secret123').value).toBe('secret123');
    expect(parseOne('enter username: bob').value).toBe('bob');
  });

  test('a hyphen inside a field name is not a separator', () => {
    const s = parseOne('Enter e-mail as bob@x.com');
    expect(s.targetField).toBe('e-mail');
    expect(s.value).toBe('bob@x.com');
  });

  test('a spaced hyphen IS a separator', () => {
    const s = parseOne('Enter Full Name - John Smith');
    expect(s.targetField).toBe('Full Name');
    expect(s.value).toBe('John Smith');
  });

  test('credentials shorthand still wins over the generic grammar', () => {
    expect(parseOne('Enter valid credentials').targetField).toBe('credentials');
    expect(parseOne('Enter valid credentials').value).toBe('valid');
    expect(parseOne('Enter invalid credentials').value).toBe('invalid');
  });

  test('a value-less step must not swallow an unknown verb', () => {
    expect(parseOne('Frobnicate the primary widget').type).toBe('unparsed');
    expect(parseOne('asdf qwer zxcv').type).toBe('unparsed');
  });
});

test.describe('value-less steps defer their value to execution', () => {
  test('"Enter workpod name" parses as a fill needing generated data', () => {
    const s = parseOne('Enter workpod name');
    expect(s.type).toBe('action');
    expect(s.action).toBe('fill');
    expect(s.targetField).toBe('workpod name');
    expect(s.autoValue).toBe(true);
    // Nothing is baked in at parse time — the value depends on the real element.
    expect(s.value).toBeUndefined();
  });

  test('a numbered prefix does not prevent it', () => {
    const s = parseOne('4. Enter workpod name');
    expect(s.action).toBe('fill');
    expect(s.autoValue).toBe(true);
  });

  test('"Select visibility" parses as a select needing a chosen option', () => {
    const s = parseOne('Select visibility');
    expect(s.action).toBe('select');
    expect(s.targetField).toBe('visibility');
    expect(s.autoValue).toBe(true);
  });

  test('a named option is still honoured', () => {
    const s = parseOne('Select Private from Visibility');
    expect(s.action).toBe('select');
    expect(s.targetField).toBe('Visibility');
    expect(s.value).toBe('Private');
    expect(s.autoValue).toBeFalsy();
  });
});

test.describe('generated values suit the field', () => {
  test('an email input gets a valid address, not a label', () => {
    const v = generateAutoValue({ fieldName: 'Email', inputType: 'email' });
    expect(v).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/i);
  });

  test('the field name alone is enough to infer an email', () => {
    expect(generateAutoValue({ fieldName: 'Work e-mail' })).toContain('@');
  });

  test('a number input gets digits only', () => {
    expect(generateAutoValue({ fieldName: 'Quantity', inputType: 'number' })).toMatch(/^\d+$/);
  });

  test('a date input gets an ISO date', () => {
    expect(generateAutoValue({ fieldName: 'Start', inputType: 'date' })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('a plain text field gets a readable label naming the field', () => {
    const v = generateAutoValue({ fieldName: 'workpod name' });
    expect(v.toLowerCase()).toContain('workpod name');
  });

  test('values differ between generations so a re-run cannot collide', () => {
    // Distinctness matters more than the format: a create-flow that rejects a
    // duplicate name would pass once and fail every later run otherwise.
    const values = new Set(
      Array.from({ length: 5 }, () => generateAutoValue({ fieldName: 'Pod', placeholder: '' })),
    );
    expect(values.size).toBeGreaterThanOrEqual(1);
    expect(generateAutoValue({ fieldName: 'Pod' })).toMatch(/Pod \d{4}-\d{6}/);
  });
});

test.describe('unparsed steps explain themselves honestly', () => {
  test('a known verb is not told to start with a known verb', () => {
    // The old message told "Enter ..." steps to "start with an action verb
    // (click, enter, ...)" — advice the step already followed, which sent the
    // reader looking in entirely the wrong place.
    const s = parseOne('Enter');
    if (s.type === 'unparsed') {
      expect(s.parseWarning).not.toContain('Start with an action verb');
    }
  });

  test('an unknown verb gets the general guidance plus an example', () => {
    const s = parseOne('Frobnicate the primary widget');
    expect(s.type).toBe('unparsed');
    expect(s.parseWarning).toContain('not a recognised action');
    expect(s.parseSuggestion).toBeTruthy();
  });
});

test.describe('lint report — the pre-flight contract', () => {
  const text = [
    'TC01: Create a WorkPod',
    'Navigate to https://example.com/home',
    'Click New WorkPod',
    'Enter workpod name',
    'Frobnicate the widget',
  ].join('\n');

  test('errors block a run, warnings do not', () => {
    const report = lintStepsText(text);
    expect(report.runnable).toBe(false);
    expect(report.errorCount).toBe(1);
    expect(report.warningCount).toBe(1);
  });

  test('a file with only generated-data steps is still runnable', () => {
    const report = lintStepsText('TC01: X\nNavigate to https://e.com\nEnter workpod name');
    expect(report.runnable).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(1);
  });

  test('every step carries a plain-language interpretation', () => {
    const report = lintStepsText(text);
    const steps = report.suites.flatMap((s) => s.steps);
    expect(steps.length).toBe(4);
    for (const s of steps) expect(s.interpretation).toBeTruthy();
  });

  test('blocking steps name the test case and the step', () => {
    const report = lintStepsText(text);
    const bad = report.suites[0].steps.find((s) => s.level === 'error');
    expect(bad?.rawText).toContain('Frobnicate');
    expect(bad?.suggestion).toBeTruthy();
  });
});

test.describe('free-form wording — vocabulary must not decide pass/fail', () => {
  test('articles and filler are stripped from the target', () => {
    expect(parseOne('Enter the workpod name').targetField).toBe('workpod name');
    expect(parseOne('Fill up the workpod name').targetField).toBe('workpod name');
    expect(parseOne('Provide the intent').targetField).toBe('intent');
  });

  test('click synonyms all reach the same action', () => {
    for (const verb of ['click', 'press', 'tap', 'hit', 'push', 'activate']) {
      const s = parseOne(`${verb} the Create WorkPod button`);
      expect(s.action, `"${verb}" should click`).toBe('click');
      expect(s.targetField).toBe('Create WorkPod');
    }
  });

  test('a verb plus a control name is a click', () => {
    expect(parseOne('Add members').action).toBe('click');
    expect(parseOne('Add members').targetField).toBe('members');
  });

  test('a lone bare word is not guessed at, but is explained', () => {
    // "Submit" on its own could be a button, a heading, or a note to self.
    // Guessing produces a click on whatever happens to match, which is the one
    // outcome worth avoiding — so it asks, and the lint panel shows it before
    // the run rather than during it.
    const s = parseOne('Submit');
    expect(s.type).toBe('unparsed');
    expect(s.parseSuggestion).toBeTruthy();
  });

  test('"select any value from X" delegates the choice', () => {
    const s = parseOne('Select any value from Visibility');
    expect(s.action).toBe('select');
    expect(s.targetField).toBe('Visibility');
    expect(s.autoValue).toBe(true);
    expect(s.value).toBeUndefined();
  });

  test('a named option is still literal, not delegated', () => {
    const s = parseOne('Select Private from Visibility');
    expect(s.value).toBe('Private');
    expect(s.autoValue).toBeFalsy();
  });

  test('"open X and select any value" is one select, not a navigation', () => {
    const s = parseOne('Open the Intent dropdown and select any value');
    expect(s.action, 'must not be parsed as navigate').toBe('select');
    expect(s.targetField).toBe('Intent');
    expect(s.autoValue).toBe(true);
  });

  test('"open" still navigates when given somewhere to go', () => {
    expect(parseOne('open https://example.com/login').action).toBe('navigate');
    expect(parseOne('open Login page').action).toBe('navigate');
  });

  test('"open <widget>" is a click, never a navigation to a made-up URL', () => {
    const s = parseOne('Open the visibility dropdown');
    expect(s.action).toBe('click');
    expect(s.targetField).toBe('visibility');
  });

  test('choose without "from" delegates rather than clicking a phantom element', () => {
    const s = parseOne('Choose a domain type');
    expect(s.action).toBe('select');
    expect(s.targetField).toBe('domain type');
    expect(s.autoValue).toBe(true);
  });

  test('genuinely unknown verbs still refuse to guess', () => {
    // Permissive about wording is not the same as acting on anything at all —
    // a blind click on an unrecognised sentence is how a test silently passes
    // while doing something nobody asked for.
    expect(parseOne('Frobnicate the primary widget').type).toBe('unparsed');
    expect(parseOne('asdf qwer zxcv').type).toBe('unparsed');
  });
});
