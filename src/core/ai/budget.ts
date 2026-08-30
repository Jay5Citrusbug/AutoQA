/**
 * budget.ts — Hard limits on what one AI-executed run may spend.
 *
 * A tool-use loop can fail in ways a deterministic runner cannot: an agent that
 * cannot find a button may keep re-snapshotting and re-clicking forever, and
 * every iteration costs money. Every guard here is a ceiling, not a suggestion —
 * hitting one ends the step with a clear verdict rather than letting the loop
 * discover its own stopping point.
 */
import type Anthropic from '@anthropic-ai/sdk';

/** Per-1M-token prices. Kept beside the model id so the two cannot drift apart. */
const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

export interface BudgetLimits {
  /** Model turns per step. One turn is one request plus its tool results. */
  maxTurnsPerStep: number;
  /** Ceiling on output tokens for the whole run, across every step. */
  maxOutputTokensPerRun: number;
  /** Wall-clock ceiling for a single step's agent loop. */
  stepTimeoutMs: number;
  /**
   * Origins the agent may drive the browser to. Empty means unrestricted.
   * Without this an agent that misreads a step can wander onto a real site and
   * act on it — the browser is not a sandbox.
   */
  allowedOrigins: string[];
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxTurnsPerStep: 12,
  maxOutputTokensPerRun: 200_000,
  stepTimeoutMs: 120_000,
  allowedOrigins: [],
};

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelTurns: number;
  estimatedCostUsd: number;
}

/** Why a step stopped early. `null` means it did not. */
export type BudgetStop = 'max-turns' | 'token-budget' | 'timeout' | null;

/**
 * Tracks spend for one run and answers "may the loop continue?".
 *
 * One instance per run, shared across its steps, so a test case that burns the
 * budget on step 2 cannot quietly keep spending on steps 3 through 40.
 */
export class RunBudget {
  private readonly limits: BudgetLimits;
  private readonly usage: BudgetUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelTurns: 0,
    estimatedCostUsd: 0,
  };

  constructor(
    private readonly model: string,
    limits: Partial<BudgetLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  public getLimits(): Readonly<BudgetLimits> {
    return this.limits;
  }

  public getUsage(): Readonly<BudgetUsage> {
    return { ...this.usage };
  }

  /** Folds one response's usage into the running total. */
  public record(usage: Anthropic.Usage | undefined): void {
    if (!usage) return;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;

    this.usage.modelTurns += 1;
    this.usage.inputTokens += usage.input_tokens ?? 0;
    this.usage.outputTokens += usage.output_tokens ?? 0;
    this.usage.cacheWriteTokens += cacheWrite;
    this.usage.cacheReadTokens += cacheRead;

    const price = PRICING[this.model];
    if (price) {
      // Cache writes bill at ~1.25x input, cache reads at ~0.1x.
      const billableInput =
        (usage.input_tokens ?? 0) + cacheWrite * 1.25 + cacheRead * 0.1;
      this.usage.estimatedCostUsd +=
        (billableInput / 1_000_000) * price.inputPerMTok +
        ((usage.output_tokens ?? 0) / 1_000_000) * price.outputPerMTok;
    }
  }

  /**
   * Whether the loop may take another turn.
   *
   * `turnsThisStep` is passed in rather than tracked here because the per-step
   * limit resets each step while the token budget does not.
   */
  public checkStop(turnsThisStep: number, stepStartedAt: number): BudgetStop {
    if (turnsThisStep >= this.limits.maxTurnsPerStep) return 'max-turns';
    if (this.usage.outputTokens >= this.limits.maxOutputTokensPerRun) return 'token-budget';
    if (Date.now() - stepStartedAt >= this.limits.stepTimeoutMs) return 'timeout';
    return null;
  }
}

/** Explains a budget stop in terms a QA reader can act on. */
export function describeStop(stop: Exclude<BudgetStop, null>, limits: BudgetLimits): string {
  switch (stop) {
    case 'max-turns':
      return `The agent used all ${limits.maxTurnsPerStep} attempts on this step without reaching a verdict.`;
    case 'token-budget':
      return `This run reached its token budget (${limits.maxOutputTokensPerRun.toLocaleString()} output tokens).`;
    case 'timeout':
      return `The agent exceeded the ${Math.round(limits.stepTimeoutMs / 1000)}s limit for a single step.`;
  }
}
