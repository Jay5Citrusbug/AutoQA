/**
 * runRegistry.ts — Typed registry for in-flight test runs.
 *
 * Centralizes the previously-untyped `globalThis.activeRuns` / `globalThis.activeLogs`
 * access so cancellation and live-log streaming share one source of truth.
 *
 * NOTE: this lives on globalThis and therefore only works within a single Node
 * process. Multi-instance deployments need the Phase 5 job/queue model.
 */
import type { Browser } from '@playwright/test';

export interface ActiveRun {
  aborted: boolean;
  /** Browser instances launched for this run, closed immediately on cancel. */
  browsers: Browser[];
}

interface RegistryGlobal {
  activeRuns?: Record<string, ActiveRun>;
  activeLogs?: Record<string, string[]>;
}

function g(): RegistryGlobal {
  return globalThis as unknown as RegistryGlobal;
}

export const runRegistry = {
  start(runId: string): ActiveRun {
    const gl = g();
    if (!gl.activeRuns) gl.activeRuns = {};
    const run: ActiveRun = { aborted: false, browsers: [] };
    gl.activeRuns[runId] = run;
    return run;
  },

  get(runId: string): ActiveRun | undefined {
    return g().activeRuns?.[runId];
  },

  isAborted(runId: string): boolean {
    return g().activeRuns?.[runId]?.aborted === true;
  },

  registerBrowser(runId: string, browser: Browser): void {
    const run = g().activeRuns?.[runId];
    if (run) run.browsers.push(browser);
  },

  /** Marks a run aborted and force-closes every browser it launched. */
  async abort(runId: string): Promise<boolean> {
    const gl = g();
    if (!gl.activeRuns) gl.activeRuns = {};
    const run = gl.activeRuns[runId];
    if (!run) {
      // Run may not have registered yet — record the intent so it aborts on start.
      gl.activeRuns[runId] = { aborted: true, browsers: [] };
      return false;
    }
    run.aborted = true;
    await Promise.all(run.browsers.map((b) => b.close().catch(() => {})));
    run.browsers = [];
    return true;
  },

  finish(runId: string): void {
    const gl = g();
    if (gl.activeRuns) delete gl.activeRuns[runId];
  },

  // ---- live logs ----
  initLogs(runId: string, lines: string[]): void {
    const gl = g();
    if (!gl.activeLogs) gl.activeLogs = {};
    gl.activeLogs[runId] = lines;
  },

  pushLog(runId: string, line: string): void {
    g().activeLogs?.[runId]?.push(line);
  },

  getLogs(runId: string): string[] {
    return g().activeLogs?.[runId] || [];
  },

  clearLogs(runId: string): void {
    const gl = g();
    if (gl.activeLogs) delete gl.activeLogs[runId];
  },
};
