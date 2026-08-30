/**
 * actionRecorder.ts — Keeps the trail of what was actually done, so a run can
 * become a regression script.
 *
 * The recording is not a transcript of what the agent *intended*. It is the
 * Playwright code MCP reports having run (see docs/PHASE-0-VERDICT.md), which
 * means a generated spec replays the real locators against the real page rather
 * than a guess reconstructed from the step wording.
 *
 * Deterministic steps record here too, so a mixed run produces one coherent
 * script instead of two half-scripts.
 */

export interface RecordedAction {
  /** The step this action belongs to, matching StepExecutionResult.stepIndex. */
  stepIndex: number;
  /** Which engine performed it — surfaced in the generated spec's comments. */
  executedBy: 'deterministic' | 'ai';
  /** The Playwright statement(s) that were executed. */
  code: string;
  /** The step text, used to comment the generated spec. */
  stepText: string;
  /** URL at the time of the action, for ordering and for navigation asserts. */
  url?: string;
  timestamp: string;
}

/**
 * Collects actions for one test case.
 *
 * Only successful, verified actions belong in a regression script, so the
 * recorder is deliberately append-only and the caller decides what to append:
 * an action that threw should never be recorded, or the generated spec will
 * replay a step that never worked.
 */
export class ActionRecorder {
  private readonly actions: RecordedAction[] = [];

  /**
   * Appends an executed action.
   *
   * Calls with no code are ignored rather than rejected: read-only tools
   * (snapshot, find) legitimately run no code, and they are the majority of an
   * agent's calls. Silently skipping them keeps the call site free of
   * `if (result.code)` guards.
   */
  public record(entry: Omit<RecordedAction, 'timestamp' | 'code'> & { code?: string }): void {
    const code = entry.code?.trim();
    if (!code) return;
    this.actions.push({ ...entry, code, timestamp: new Date().toISOString() });
  }

  public getActions(): readonly RecordedAction[] {
    return this.actions;
  }

  /** Actions belonging to one step, in order. */
  public getStepActions(stepIndex: number): RecordedAction[] {
    return this.actions.filter((a) => a.stepIndex === stepIndex);
  }

  public get length(): number {
    return this.actions.length;
  }

  /**
   * True when the trail is complete enough to generate a script from.
   *
   * A trail with no actions produces a spec that navigates and asserts nothing,
   * which would then pass verification and enter the library as a "verified"
   * script that tests nothing at all.
   */
  public isUsable(): boolean {
    return this.actions.length > 0;
  }
}
