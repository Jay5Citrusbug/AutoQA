/**
 * agentExecutor.ts — The observe → act → verify loop for one test step.
 *
 * This is the "AI" half of hybrid execution. The deterministic engine handles
 * every step it understands; a step arrives here only when it could not (see
 * the handoff triggers in playwrightRunner). The agent drives the SAME browser
 * context the deterministic engine was using, via McpBrowserSession, so the
 * session, the video and every evidence listener carry straight through.
 *
 * A manual loop rather than the SDK's tool runner: the tool list is built at
 * run time from MCP, and every tool call has to be intercepted to record the
 * executed Playwright code and to charge the run budget. Owning the loop is
 * simpler than bending a helper around both.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { McpBrowserSession } from './mcpAdapter';
import type { ActionRecorder } from './actionRecorder';
import { RunBudget, describeStop } from './budget';
import { SYSTEM_PROMPT, REPORT_STEP_RESULT_TOOL, buildStepPrompt, type StepPromptContext } from './prompts';
import { logger } from '@/utils/logger';

/**
 * Default model.
 *
 * Opus is the default because a wrong verdict is the expensive outcome here:
 * a false pass hides a real defect and a false fail sends someone chasing a
 * bug that does not exist. Override with AUTOQA_AI_MODEL to trade accuracy for
 * cost — that is a deliberate choice, not one to make silently.
 */
const DEFAULT_MODEL = 'claude-opus-5';

export interface AgentStepResult {
  status: 'passed' | 'failed';
  /** The agent's own account of the verdict, shown in the report. */
  reasoning: string;
  expected?: string;
  actual?: string;
  /** Set when the loop ended without a verdict (budget, timeout, error). */
  incomplete?: boolean;
  /** Tool calls made, for the run log. */
  toolCallCount: number;
}

export interface ExecuteStepOptions {
  session: McpBrowserSession;
  recorder: ActionRecorder;
  budget: RunBudget;
  context: StepPromptContext;
  /** Matches StepExecutionResult.stepIndex, for the recorded trail. */
  stepIndex: number;
  /** Streams progress into the run's live log. */
  log?: (message: string) => void;
  /** Cancellation — checked between turns so a cancelled run stops promptly. */
  isCancelled?: () => boolean;
  model?: string;
  client?: Anthropic;
}

/** Thrown when the agent is asked to run without an API key configured. */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'ANTHROPIC_API_KEY is not set, so AI execution is unavailable. ' +
        'Set it in .env, or run in Deterministic mode.',
    );
    this.name = 'MissingApiKeyError';
  }
}

export function isAiExecutionAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Runs one step to a verdict.
 *
 * Always resolves — a thrown error, an exhausted budget and a refusal all come
 * back as a failed step with an explanation, because a step that cannot report
 * a verdict is itself a result the report must show.
 */
export async function executeStepWithAgent(
  options: ExecuteStepOptions,
): Promise<AgentStepResult> {
  const { session, recorder, budget, context, stepIndex, log, isCancelled } = options;

  if (!isAiExecutionAvailable() && !options.client) throw new MissingApiKeyError();

  const model = options.model ?? process.env.AUTOQA_AI_MODEL ?? DEFAULT_MODEL;
  const client = options.client ?? new Anthropic();

  const tools: Anthropic.Tool[] = [
    ...session.getTools().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    })),
    REPORT_STEP_RESULT_TOOL as Anthropic.Tool,
  ];

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildStepPrompt(context) },
  ];

  const startedAt = Date.now();
  let turns = 0;
  let toolCallCount = 0;

  try {
    for (;;) {
      if (isCancelled?.()) {
        return incomplete('Execution cancelled by user.', toolCallCount);
      }

      const stop = budget.checkStop(turns, startedAt);
      if (stop) {
        return incomplete(describeStop(stop, budget.getLimits()), toolCallCount);
      }

      // Streamed because an agentic turn with a large max_tokens can otherwise
      // exceed the SDK's HTTP timeout.
      const response = await client.messages
        .stream({
          model,
          max_tokens: 8_000,
          // Adaptive thinking: deciding whether a page satisfies an expectation
          // is exactly the judgement that benefits from it.
          thinking: { type: 'adaptive' },
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              // Stable across every step of every run, so it caches. Tools are
              // rendered before system and are stable too, keeping the prefix intact.
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools,
          messages,
        })
        .finalMessage();

      turns += 1;
      budget.record(response.usage);

      if (response.stop_reason === 'refusal') {
        return incomplete(
          'The model declined to act on this step. Rephrase the step, or run it in Deterministic mode.',
          toolCallCount,
        );
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        // No tools and no verdict. Nudge once rather than ending the step: the
        // model has usually just narrated instead of calling report_step_result.
        messages.push({
          role: 'user',
          content:
            'You did not call a tool. Either act on the page, or call report_step_result with your verdict.',
        });
        continue;
      }

      // Every tool_result for one assistant turn must go back in ONE user
      // message, or the model learns to stop calling tools in parallel.
      const results: Anthropic.ToolResultBlockParam[] = [];
      let verdict: AgentStepResult | null = null;

      for (const call of toolUses) {
        if (call.name === REPORT_STEP_RESULT_TOOL.name) {
          verdict = readVerdict(call.input, toolCallCount);
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: 'Verdict recorded.',
          });
          continue;
        }

        toolCallCount += 1;
        const result = await session.call(call.name, (call.input ?? {}) as Record<string, unknown>);

        // Only successful calls enter the trail: a generated spec must never
        // replay an action that did not work.
        if (!result.isError) {
          recorder.record({
            stepIndex,
            executedBy: 'ai',
            code: result.code,
            stepText: context.stepText,
            url: context.currentUrl,
          });
        }

        log?.(`    [ai] ${call.name}${result.isError ? ' — failed' : ''}`);
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: result.text || '(no output)',
          ...(result.isError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: 'user', content: results });

      // Returned after the results are appended so the conversation stays valid
      // if this step is ever resumed or replayed.
      if (verdict) return verdict;
    }
  } catch (err) {
    return { ...incomplete(explainError(err), toolCallCount), incomplete: true };
  }
}

/** A step that ended without the agent reaching a verdict. */
function incomplete(reason: string, toolCallCount: number): AgentStepResult {
  return { status: 'failed', reasoning: reason, incomplete: true, toolCallCount };
}

/**
 * Reads the verdict out of a tool call.
 *
 * The input is validated rather than trusted: a malformed verdict that defaulted
 * to "passed" would turn a broken agent into a green run.
 */
function readVerdict(input: unknown, toolCallCount: number): AgentStepResult {
  const raw = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  const status = raw.status === 'passed' ? 'passed' : 'failed';
  const expected = str(raw.expected);
  const actual = str(raw.actual);
  const reasoning =
    str(raw.reasoning) ??
    (expected && actual ? `Expected ${expected}; observed ${actual}.` : 'No reasoning given.');

  if (raw.status !== 'passed' && raw.status !== 'failed') {
    logger.warn(`Agent reported an unrecognised status "${String(raw.status)}" — treated as failed`);
  }

  return { status, reasoning, expected, actual, toolCallCount };
}

/** Turns an SDK error into something a QA reader can act on. */
function explainError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'ANTHROPIC_API_KEY was rejected. Check the key in .env.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'The Anthropic API rate-limited this run. Retry in a moment, or lower the worker count.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API. Check network connectivity.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status}: ${err.message}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Agent step failed unexpectedly', err);
  return `AI execution failed: ${message}`;
}
