/**
 * prompts.ts — The QA semantics the agent executes under.
 *
 * The system prompt is deliberately constant for a whole run: it is the cached
 * prefix (tools → system → messages), so anything varying per step belongs in
 * the user message instead. Putting the step text or the URL in here would
 * invalidate the cache on every single step.
 */

/**
 * The one rule that matters most is the last one. An agent rewarded for "the
 * step succeeded" will find a way to make steps succeed — navigating directly
 * past a broken menu, retrying until a flake passes, or calling a missing
 * element a pass. Every one of those turns a real defect into a green run,
 * which is worse than no test at all, so the prompt is explicit that reporting
 * failure is a correct outcome rather than a failure of the agent.
 */
export const SYSTEM_PROMPT = `You are the execution engine of AutoQA, an automated QA platform. You operate a real browser to carry out one test step at a time against a real application, and report a verdict on each.

## How you work

1. Look at the page with \`browser_snapshot\` (or \`browser_find\` when you only need to locate one thing — it is much cheaper).
2. Take the smallest action that carries out the step, using the element refs from the snapshot.
3. Confirm the result actually happened by looking at the page again.
4. Call \`report_step_result\` exactly once. This ends the step. Do not call it until you have either done the step or established that you cannot.

## Judging a step

A step is one of two kinds, and they are judged differently.

**An action** ("click Login", "enter the email") passes when the action was carried out and the page responded. If the element genuinely is not there, the step fails.

**A check** ("verify the dashboard loads", "the error message should appear") passes only when you have positively observed the expected thing in the page. Not finding evidence is a FAIL, never a pass. "The page probably loaded" is not an observation.

Compare what you observe against what the step expects, and say both in your reasoning: what was expected, and what was actually there.

## Rules

- **Report what happened, not what should have happened.** A failing step is a correct and valuable result — it is very often the exact bug the test exists to catch. Never adjust your verdict to make a run look better.
- **Never work around the application.** If a button does not work, that is the finding. Do not navigate directly to the destination URL, do not retry a failed action hoping for a different outcome, and do not use a different route to reach the same state. Doing so hides the defect.
- **Stay on the step you were given.** Do not perform later steps, and do not fix up earlier ones.
- **Do not invent data.** If a step needs a value it does not supply, use the test data you were given. If there is none, fail the step and say which value was missing.
- **Prefer meaningful locators.** Target elements by their role and accessible name rather than by position, so the recorded script survives a layout change.
- **If the page is not what you expected**, say so in your reasoning and fail the step. An unexpected page is a finding, not an obstacle to route around.`;

export interface StepPromptContext {
  /** The step as the QA author wrote it. */
  stepText: string;
  /** 1-based position, for the reader's benefit. */
  stepNumber: number;
  totalSteps: number;
  /** Test case title, so the agent knows the wider intent. */
  testCaseTitle: string;
  /** Where the browser currently is. */
  currentUrl: string;
  /** Steps already done in this test case, for continuity. */
  previousSteps?: Array<{ text: string; status: 'passed' | 'failed' }>;
  /** Resolved test-data variables the step may need (secrets already substituted). */
  testData?: Record<string, string>;
  /** Why this step reached the agent rather than the deterministic engine. */
  handoffReason: string;
}

/**
 * Builds the per-step user message.
 *
 * Everything that varies lives here rather than in the system prompt, so the
 * cached prefix stays intact across every step of a run.
 */
export function buildStepPrompt(ctx: StepPromptContext): string {
  const parts: string[] = [];

  parts.push(`Test case: ${ctx.testCaseTitle}`);
  parts.push(`Step ${ctx.stepNumber} of ${ctx.totalSteps}.`);
  parts.push(`The browser is currently at: ${ctx.currentUrl}`);

  if (ctx.previousSteps?.length) {
    const history = ctx.previousSteps
      .map((s, i) => `  ${i + 1}. [${s.status}] ${s.text}`)
      .join('\n');
    parts.push(`Steps already carried out:\n${history}`);
  }

  if (ctx.testData && Object.keys(ctx.testData).length > 0) {
    const data = Object.entries(ctx.testData)
      .map(([k, v]) => `  ${k} = ${v}`)
      .join('\n');
    parts.push(`Test data available to you:\n${data}`);
  }

  // Stated plainly because it changes what a sensible agent should try. A step
  // that already failed deterministically needs a different approach, not a
  // louder repeat of the same one.
  parts.push(`(Routed to you because: ${ctx.handoffReason})`);

  parts.push(`\n--- THE STEP TO CARRY OUT ---\n${ctx.stepText}`);

  return parts.join('\n\n');
}

/**
 * The tool that ends a step. Defined here rather than in the executor so the
 * wording the model reads sits beside the prompt that frames it.
 */
export const REPORT_STEP_RESULT_TOOL = {
  name: 'report_step_result',
  description:
    'Report the verdict for the current step. Call this exactly once, when you have either carried out the step or established that you cannot. This ends the step.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        enum: ['passed', 'failed'],
        description:
          'passed only if you positively observed the expected outcome. If you could not verify it, that is failed.',
      },
      expected: {
        type: 'string',
        description: 'What the step said should happen, in your own words.',
      },
      actual: {
        type: 'string',
        description:
          'What you actually observed on the page. Be concrete — quote text or name elements you saw.',
      },
      reasoning: {
        type: 'string',
        description:
          'Why this verdict follows from what you observed. One or two sentences.',
      },
    },
    required: ['status', 'expected', 'actual', 'reasoning'],
    additionalProperties: false,
  },
};
