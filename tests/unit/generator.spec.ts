import { test, expect } from '@playwright/test';
import { PlaywrightGenerator } from '@/core/generator/playwrightGenerator';
import { ExecutionContext, StepExecutionResult } from '@/types/execution';
import { ParsedStep } from '@/types/testCase';

const gen = new PlaywrightGenerator();

function ctx(results: StepExecutionResult[]): ExecutionContext {
  return {
    runId: 'run_unit_test_0001',
    url: 'https://example.com/login',
    browser: 'chromium',
    deviceMode: 'desktop',
    status: 'completed',
    startTime: new Date(0).toISOString(),
    locatorMap: {},
    stepResults: results,
    consoleLogs: [],
    networkErrors: [],
  };
}

function step(partial: Partial<ParsedStep> & { stepIndex: number; type: ParsedStep['type'] }): ParsedStep {
  return { rawText: 'raw', targetField: '', ...partial } as ParsedStep;
}

function result(s: ParsedStep, resolvedSelector?: string): StepExecutionResult {
  return { stepIndex: s.stepIndex, step: s, status: 'passed', durationMs: 1, logs: [], resolvedSelector };
}

test('navigate emits an absolute goto URL', () => {
  const code = gen.buildSpecCode(
    ctx([result(step({ stepIndex: 1, type: 'action', action: 'navigate', value: 'https://example.com/login' }))]),
  );
  expect(code).toContain("await page.goto('https://example.com/login'");
});

test('fill uses .first() and env-substitutes {{variables}} instead of embedding secrets', () => {
  const s = step({ stepIndex: 1, type: 'action', action: 'fill', targetField: 'email', value: '{{qa_valid_username}}' });
  const code = gen.buildSpecCode(ctx([result(s, '#email')]));
  expect(code).toContain(".first().fill(");
  expect(code).toContain('process.env.QA_VALID_USERNAME');
  expect(code).not.toContain('{{qa_valid_username}}'); // template resolved, not literal
});

test('credential step emits env-driven fills, never plaintext', () => {
  const s = step({ stepIndex: 1, type: 'action', action: 'fill', targetField: 'credentials', value: 'valid' });
  const code = gen.buildSpecCode(ctx([result(s, '#user & #pass')]));
  expect(code).toContain('process.env.QA_VALID_USERNAME');
  expect(code).toContain('process.env.QA_VALID_PASSWORD');
});

test('click on a reliable selector uses .first()', () => {
  const s = step({ stepIndex: 1, type: 'action', action: 'click', targetField: 'login' });
  const code = gen.buildSpecCode(ctx([result(s, '#login')]));
  expect(code).toContain("page.locator('#login').first().click()");
});

test('never emits a bare page.locator(\'button\') guess', () => {
  const s = step({ stepIndex: 1, type: 'action', action: 'click', targetField: 'login' });
  const code = gen.buildSpecCode(ctx([result(s, 'button')]));
  expect(code).not.toContain("page.locator('button')");
  expect(code).toContain('TODO'); // downgraded to a TODO instead of a blind guess
});

test('unparsed step is skipped with an explanatory comment', () => {
  const s = step({ stepIndex: 1, type: 'unparsed', parseWarning: 'could not understand' });
  const code = gen.buildSpecCode(ctx([result(s)]));
  expect(code).toContain('SKIPPED (unparsed step)');
});

test('a value with an apostrophe is safely escaped', () => {
  const s = step({ stepIndex: 1, type: 'action', action: 'fill', targetField: 'name', value: "O'Brien" });
  const code = gen.buildSpecCode(ctx([result(s, '#name')]));
  expect(code).toContain("O\\'Brien");
});
