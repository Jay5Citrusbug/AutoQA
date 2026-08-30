import { test, expect } from '@playwright/test';
import type Anthropic from '@anthropic-ai/sdk';
import { executeStepWithAgent } from '@/core/ai/agentExecutor';
import { ActionRecorder } from '@/core/ai/actionRecorder';
import { RunBudget } from '@/core/ai/budget';
import type { McpBrowserSession, McpToolResult } from '@/core/ai/mcpAdapter';
import type { StepPromptContext } from '@/core/ai/prompts';

/**
 * The agent loop decides whether a step passed. Its failure modes are quiet and
 * expensive — a malformed verdict read as "passed" hides a real defect, and a
 * loop that never terminates burns the run budget — so they are pinned here.
 * The Anthropic client and the MCP session are both injected, so these run with
 * no API key and no browser.
 */

const CONTEXT: StepPromptContext = {
  stepText: 'Verify the dashboard is displayed',
  stepNumber: 2,
  totalSteps: 3,
  testCaseTitle: 'Login smoke test',
  currentUrl: 'https://app.example.com/dashboard',
  handoffReason: 'the parser did not understand this step',
};

/** Builds an assistant turn the way the API would return one. */
function assistantTurn(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message['stop_reason'] = 'tool_use',
): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 } as Anthropic.Usage,
  } as Anthropic.Message;
}

function toolUse(name: string, input: unknown, id = `tu_${name}`): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as Anthropic.ContentBlock;
}

function verdictBlock(input: unknown): Anthropic.ContentBlock {
  return toolUse('report_step_result', input, 'tu_verdict');
}

/** A client that replays a fixed script of turns and records what it was sent. */
function fakeClient(turns: Anthropic.Message[]) {
  const sent: Anthropic.MessageCreateParams[] = [];
  let i = 0;
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        // The executor keeps appending to the same `messages` array, so store a
        // snapshot — otherwise every captured request shows the final state.
        sent.push({ ...params, messages: [...(params.messages ?? [])] });
        const turn = turns[Math.min(i, turns.length - 1)];
        i += 1;
        return { finalMessage: async () => turn };
      },
    },
  } as unknown as Anthropic;
  return { client, sent, callCount: () => i };
}

function fakeSession(
  onCall?: (name: string, args: Record<string, unknown>) => McpToolResult,
): McpBrowserSession & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const session = {
    calls,
    getTools: () => [
      { name: 'browser_snapshot', description: 'snapshot', inputSchema: { type: 'object' } },
      { name: 'browser_click', description: 'click', inputSchema: { type: 'object' } },
    ],
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return (
        onCall?.(name, args) ?? {
          text: '### Ran Playwright code\n```js\nawait page.click();\n```',
          code: 'await page.click();',
          isError: false,
        }
      );
    },
    async close() {},
  };
  return session as unknown as McpBrowserSession & { calls: typeof calls };
}

function run(
  turns: Anthropic.Message[],
  opts: { session?: ReturnType<typeof fakeSession>; budget?: RunBudget } = {},
) {
  const session = opts.session ?? fakeSession();
  const recorder = new ActionRecorder();
  const budget = opts.budget ?? new RunBudget('claude-opus-5');
  const { client, sent } = fakeClient(turns);
  return {
    session,
    recorder,
    budget,
    sent,
    result: executeStepWithAgent({
      session,
      recorder,
      budget,
      context: CONTEXT,
      stepIndex: 1,
      client,
    }),
  };
}

test.describe('executeStepWithAgent — reaching a verdict', () => {
  test('returns the verdict the agent reported', async () => {
    const h = run([
      assistantTurn([
        verdictBlock({
          status: 'passed',
          expected: 'the dashboard',
          actual: 'heading "Dashboard" was visible',
          reasoning: 'The dashboard heading and left menu were both present.',
        }),
      ]),
    ]);

    const result = await h.result;
    expect(result.status).toBe('passed');
    expect(result.expected).toBe('the dashboard');
    expect(result.actual).toBe('heading "Dashboard" was visible');
    expect(result.incomplete).toBeFalsy();
  });

  test('acts on the page, then reports — recording only the executed code', async () => {
    const h = run([
      assistantTurn([toolUse('browser_click', { target: 'e5' })]),
      assistantTurn([
        verdictBlock({
          status: 'passed',
          expected: 'x',
          actual: 'y',
          reasoning: 'done',
        }),
      ]),
    ]);

    const result = await h.result;
    expect(result.status).toBe('passed');
    expect(h.session.calls.map((c) => c.name)).toEqual(['browser_click']);
    expect(result.toolCallCount).toBe(1);

    const trail = h.recorder.getActions();
    expect(trail).toHaveLength(1);
    expect(trail[0].code).toBe('await page.click();');
    expect(trail[0].executedBy).toBe('ai');
    expect(trail[0].stepIndex).toBe(1);
  });

  test('keeps a failed tool call out of the recorded trail', async () => {
    // A generated spec that replays an action which never worked is worse than
    // no spec: it fails on replay and looks like an application regression.
    const session = fakeSession(() => ({
      text: '### Error\nElement not found.',
      isError: true,
    }));
    const h = run(
      [
        assistantTurn([toolUse('browser_click', { target: 'e9' })]),
        assistantTurn([
          verdictBlock({ status: 'failed', expected: 'a', actual: 'b', reasoning: 'missing' }),
        ]),
      ],
      { session },
    );

    const result = await h.result;
    expect(result.status).toBe('failed');
    expect(h.recorder.getActions()).toHaveLength(0);
  });

  test('returns every tool result in a single user message', async () => {
    // Splitting them across messages silently teaches the model to stop
    // calling tools in parallel.
    const h = run([
      assistantTurn([
        toolUse('browser_snapshot', {}, 'tu_a'),
        toolUse('browser_click', { target: 'e1' }, 'tu_b'),
      ]),
      assistantTurn([
        verdictBlock({ status: 'passed', expected: 'a', actual: 'b', reasoning: 'ok' }),
      ]),
    ]);
    await h.result;

    const secondRequest = h.sent[1];
    const toolResultMessages = (secondRequest.messages as Anthropic.MessageParam[]).filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => (b as { type: string }).type === 'tool_result'),
    );
    expect(toolResultMessages).toHaveLength(1);
    expect((toolResultMessages[0].content as unknown[]).length).toBe(2);
  });
});

test.describe('executeStepWithAgent — refusing to turn a broken run green', () => {
  test('treats an unrecognised status as failed, never passed', async () => {
    const h = run([
      assistantTurn([
        verdictBlock({ status: 'inconclusive', expected: 'a', actual: 'b', reasoning: 'unsure' }),
      ]),
    ]);
    expect((await h.result).status).toBe('failed');
  });

  test('treats a missing status as failed', async () => {
    const h = run([assistantTurn([verdictBlock({ reasoning: 'looked fine' })])]);
    expect((await h.result).status).toBe('failed');
  });

  test('stops at the turn limit and reports the step incomplete', async () => {
    // Without this the loop would keep snapshotting and clicking forever.
    const budget = new RunBudget('claude-opus-5', { maxTurnsPerStep: 3 });
    const h = run([assistantTurn([toolUse('browser_snapshot', {})])], { budget });

    const result = await h.result;
    expect(result.status).toBe('failed');
    expect(result.incomplete).toBe(true);
    expect(result.reasoning).toContain('3 attempts');
    expect(budget.getUsage().modelTurns).toBe(3);
  });

  test('reports a refusal as an incomplete step rather than a pass', async () => {
    const h = run([assistantTurn([], 'refusal')]);
    const result = await h.result;
    expect(result.status).toBe('failed');
    expect(result.incomplete).toBe(true);
    expect(result.reasoning).toContain('declined');
  });

  test('nudges once when the model answers without calling a tool', async () => {
    const h = run([
      assistantTurn([{ type: 'text', text: 'The dashboard looks fine.' } as Anthropic.ContentBlock], 'end_turn'),
      assistantTurn([
        verdictBlock({ status: 'passed', expected: 'a', actual: 'b', reasoning: 'ok' }),
      ]),
    ]);

    expect((await h.result).status).toBe('passed');
    const nudge = (h.sent[1].messages as Anthropic.MessageParam[]).at(-1);
    expect(String(nudge?.content)).toContain('did not call a tool');
  });
});

test.describe('executeStepWithAgent — request shape', () => {
  test('sends a cacheable system prompt and both MCP and verdict tools', async () => {
    const h = run([
      assistantTurn([
        verdictBlock({ status: 'passed', expected: 'a', actual: 'b', reasoning: 'ok' }),
      ]),
    ]);
    await h.result;

    const req = h.sent[0];
    expect(req.model).toBe('claude-opus-5');
    // The system prompt is the cached prefix; without this every step pays full price.
    expect((req.system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({
      type: 'ephemeral',
    });
    const toolNames = (req.tools ?? []).map((t) => ('name' in t ? t.name : ''));
    expect(toolNames).toContain('browser_click');
    expect(toolNames).toContain('report_step_result');
  });

  test('charges the run budget for every turn', async () => {
    const h = run([
      assistantTurn([toolUse('browser_snapshot', {})]),
      assistantTurn([
        verdictBlock({ status: 'passed', expected: 'a', actual: 'b', reasoning: 'ok' }),
      ]),
    ]);
    await h.result;

    const usage = h.budget.getUsage();
    expect(usage.modelTurns).toBe(2);
    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(100);
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
  });
});
