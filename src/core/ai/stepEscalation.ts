/**
 * stepEscalation.ts — The hybrid handoff: when the deterministic engine cannot
 * carry out a step, hand that step to the agent.
 *
 * The three triggers named in the plan (an unparsed step, a locator the
 * discovery engine could not resolve, a step that simply failed) all surface the
 * same way — as a thrown error inside the step loop — so escalation hooks in at
 * that one point rather than at three.
 *
 * What escalation must NOT do is turn a real defect into a pass. The agent is
 * given the same step and the same page, not permission to reach the outcome by
 * another route; the prompt forbids working around the application, and a step
 * the agent also fails stays failed, now with a reason a human can read.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { McpBrowserSession } from './mcpAdapter';
import { ActionRecorder } from './actionRecorder';
import { RunBudget, type BudgetLimits } from './budget';
import { executeStepWithAgent, isAiExecutionAvailable, type AgentStepResult } from './agentExecutor';
import type { ParsedStep } from '@/types/testCase';
import { logger } from '@/utils/logger';

/** How a run decides between the two engines. */
export type ExecutionMode = 'deterministic' | 'ai' | 'auto';

export interface EscalationRequest {
  page: Page;
  step: ParsedStep;
  stepIndex: number;
  /** Why the deterministic engine could not complete the step. */
  deterministicError: string;
  testCaseTitle: string;
  totalSteps: number;
  previousSteps: Array<{ text: string; status: 'passed' | 'failed' }>;
  log: (message: string) => void;
}

export interface EscalatorOptions {
  mode: ExecutionMode;
  /** Where MCP writes its own scratch artifacts. */
  outputDir: string;
  model?: string;
  limits?: Partial<BudgetLimits>;
  isCancelled?: () => boolean;
}

/**
 * Owns the agent's lifetime for one run.
 *
 * An MCP session is bound to a BrowserContext, and a run has one context per
 * test case, so sessions are cached per context and created only when a step
 * actually escalates. In hybrid mode most runs never escalate at all — paying
 * to attach a session up front would tax every run for a path most never take.
 */
export class StepEscalator {
  private readonly sessions = new Map<BrowserContext, McpBrowserSession>();
  private readonly recorder = new ActionRecorder();
  private readonly budget: RunBudget;
  private unavailableReason?: string;

  private readonly model: string;

  constructor(private readonly options: EscalatorOptions) {
    this.model = options.model ?? process.env.AUTOQA_AI_MODEL ?? 'claude-opus-5';
    this.budget = new RunBudget(this.model, options.limits);
  }

  /** The model this run escalates to. */
  public getModel(): string {
    return this.model;
  }

  /** True when this run may escalate at all. */
  public isEnabled(): boolean {
    return this.options.mode !== 'deterministic' && isAiExecutionAvailable();
  }

  public getRecorder(): ActionRecorder {
    return this.recorder;
  }

  public getBudget(): RunBudget {
    return this.budget;
  }

  /**
   * Attempts the step with the agent.
   *
   * Returns null when escalation is not possible, which the caller must treat as
   * "keep the deterministic failure" — never as a pass.
   */
  public async escalate(req: EscalationRequest): Promise<AgentStepResult | null> {
    if (!this.isEnabled()) return null;
    if (this.unavailableReason) return null;

    try {
      const session = await this.sessionFor(req.page);
      req.log(`  AI takeover: ${req.step.rawText}`);

      const result = await executeStepWithAgent({
        session,
        recorder: this.recorder,
        budget: this.budget,
        stepIndex: req.stepIndex,
        model: this.options.model,
        isCancelled: this.options.isCancelled,
        log: req.log,
        context: {
          stepText: req.step.rawText,
          stepNumber: req.stepIndex,
          totalSteps: req.totalSteps,
          testCaseTitle: req.testCaseTitle,
          currentUrl: req.page.url(),
          previousSteps: req.previousSteps,
          handoffReason: req.deterministicError,
        },
      });

      req.log(
        `  AI verdict: ${result.status.toUpperCase()} — ${result.reasoning}`,
      );
      return result;
    } catch (err) {
      // Escalation failing is not the application's fault, and must not be
      // reported as though it were. The deterministic failure stands.
      const message = err instanceof Error ? err.message : String(err);
      this.unavailableReason = message;
      logger.error('Step escalation unavailable for the rest of this run', err);
      req.log(`  AI takeover unavailable: ${message}`);
      return null;
    }
  }

  private async sessionFor(page: Page): Promise<McpBrowserSession> {
    const context = page.context();
    const existing = this.sessions.get(context);
    if (existing) return existing;

    const session = await McpBrowserSession.attach(context, {
      outputDir: this.options.outputDir,
    });
    this.sessions.set(context, session);
    return session;
  }

  /** Closes every session. Must run before the browser contexts do. */
  public async dispose(): Promise<void> {
    const open = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(open.map((s) => s.close()));
  }
}
