import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { StepEscalator } from '@/core/ai/stepEscalation';
import type { ParsedStep } from '@/types/testCase';

/**
 * The escalator decides whether a step gets a second chance. Its dangerous
 * failure mode is the generous one: escalation quietly succeeding, or being
 * attempted when it should not be, would convert a real defect into a pass.
 * Every test here pins the conservative direction.
 */

const STEP: ParsedStep = {
  stepIndex: 1,
  rawText: 'Verify the dashboard is displayed',
  type: 'unparsed',
  targetField: '',
};

function request(page: Page) {
  return {
    page,
    step: STEP,
    stepIndex: 1,
    deterministicError: 'Step could not be parsed',
    testCaseTitle: 'TC01',
    totalSteps: 2,
    previousSteps: [],
    log: () => {},
  };
}

/** A page stub. Escalation must bail out before ever touching it. */
const unusablePage = {
  url: () => 'https://app.example.com',
  context: () => {
    throw new Error('context() must not be reached when escalation is disabled');
  },
} as unknown as Page;

test.describe('StepEscalator — when escalation is allowed', () => {
  const original = process.env.ANTHROPIC_API_KEY;
  test.afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
  });

  test('is disabled in deterministic mode even with a key set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const e = new StepEscalator({ mode: 'deterministic', outputDir: '.' });
    expect(e.isEnabled()).toBe(false);
  });

  test('is disabled without an API key even in auto mode', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const e = new StepEscalator({ mode: 'auto', outputDir: '.' });
    expect(e.isEnabled()).toBe(false);
  });

  test('is enabled in auto and ai mode once a key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(new StepEscalator({ mode: 'auto', outputDir: '.' }).isEnabled()).toBe(true);
    expect(new StepEscalator({ mode: 'ai', outputDir: '.' }).isEnabled()).toBe(true);
  });

  test('returns null without touching the page when disabled', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const e = new StepEscalator({ mode: 'auto', outputDir: '.' });

    // null means "no fallback happened" — the caller keeps the deterministic
    // failure. If this ever returned a result, a step nothing executed would pass.
    expect(await e.escalate(request(unusablePage))).toBeNull();
  });

  test('gives up for the rest of the run once attaching fails', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const e = new StepEscalator({ mode: 'auto', outputDir: '.' });

    let contextCalls = 0;
    const brokenPage = {
      url: () => 'https://app.example.com',
      context: () => {
        contextCalls += 1;
        throw new Error('browser context is gone');
      },
    } as unknown as Page;

    expect(await e.escalate(request(brokenPage))).toBeNull();
    expect(await e.escalate(request(brokenPage))).toBeNull();
    expect(await e.escalate(request(brokenPage))).toBeNull();

    // Retrying a broken session on every step would cost seconds per step and
    // flood the log with the same error.
    expect(contextCalls).toBe(1);
  });

  test('reports the model it will escalate to', () => {
    expect(new StepEscalator({ mode: 'auto', outputDir: '.' }).getModel()).toBe('claude-opus-5');
    expect(
      new StepEscalator({ mode: 'auto', outputDir: '.', model: 'claude-sonnet-5' }).getModel(),
    ).toBe('claude-sonnet-5');
  });

  test('disposing without any session is safe', async () => {
    await new StepEscalator({ mode: 'auto', outputDir: '.' }).dispose();
  });
});
