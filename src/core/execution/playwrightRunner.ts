import { chromium, firefox, webkit, devices, BrowserType } from '@playwright/test';
import {
  ExecutionContext,
  StepExecutionResult,
  LocatorMap,
  TestSuiteResult,
  NetworkRequestRecord,
  ConsoleMessageRecord,
  NetworkErrorRecord,
  SessionReuseSummary,
  DiscoveryMatch,
} from '@/types/execution';
import { ActionType, ParsedStep } from '@/types/testCase';
import { BrowserEngine, DeviceMode } from '@/types/mvp';
import { TestCaseParser } from '../parser/testCaseParser';
import { ElementDiscoveryEngine } from '../discovery/elementDiscovery';
import { Validator } from '../validation/validator';
import { ScreenshotManager } from '../evidence/screenshotManager';
import { uploadFile } from '../storage/cloudinaryStorage';
import { RemoteArtifact } from '@/lib/report-bug-tracker/types';
import { DomSnapshotManager } from '../evidence/domSnapshotManager';
import { LogManager } from '../evidence/logManager';
import { ReportGenerator } from '../reporting/reportGenerator';
import { PlaywrightGenerator } from '../generator/playwrightGenerator';
import { ScriptVerifier } from './scriptVerifier';
import { logger } from '@/utils/logger';
import { StepEscalator, type ExecutionMode } from '../ai/stepEscalation';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileHelper } from '@/utils/fileHelper';
import { generateAutoValue, getCredentials, substituteVariables } from '@/utils/testData';
import { runRegistry } from './runRegistry';
import { installNetworkActivityTracker, waitForPageSettle, waitUntilCondition } from './smartWait';
import {
  CachedSession,
  DEFAULT_SESSION_TTL_MINUTES,
  computeSessionKey,
  invalidateSession,
  loadSession,
  saveSession,
} from './sessionManager';
import { LoginPrologue, containsLogout, detectLoginPrologue, hasLoginSteps, shouldRetryAfterReuse } from './loginFlow';
import type { Browser, BrowserContext, Locator, Page, Request } from '@playwright/test';

// Universal 30-second timeout applied to all network-dependent operations.
const UNIVERSAL_TIMEOUT_MS = 30_000;

/**
 * How a navigation is considered "arrived".
 *
 * `load` waits for every subresource — images, fonts, ad pixels, analytics — long
 * after the page is usable, and on a media-heavy dashboard that is several seconds
 * per navigation with nothing gained. `domcontentloaded` plus waitForPageSettle()
 * is strictly better information: the markup is parsed AND the app's own async
 * work has gone quiet, which is what the next step actually depends on.
 */
const NAV_WAIT_UNTIL = 'domcontentloaded' as const;

/**
 * Settle budget for a confirmation read (is this page authenticated?) rather than
 * an action. Nothing was just triggered, so there is nothing slow to wait for.
 *
 * Only for checks that follow a GET navigation to an already-authenticated page
 * (restoring a cached session, or a suite's own opening navigation with cookies
 * already in place) — there genuinely is nothing pending to wait for there.
 */
const CHECK_SETTLE_MS = 2_000;

/**
 * Settle budget for confirming a login that was just submitted.
 *
 * This follows a POST-and-redirect, not a plain GET, and measurement against the
 * real target app showed why that matters: the gap between click and redirect
 * varied from ~5s to ~26s across otherwise-identical runs — backend/network
 * variance on the app's own staging environment, reproducible on EITHER browser
 * engine, not a rendering-engine difference. A tight budget here doesn't fail
 * safely on a slow response, it fails INCORRECTLY: it reports "login didn't
 * work" for a login that was simply still in flight.
 *
 * Getting this wrong is expensive precisely because it is rare and high-stakes —
 * it runs once per login flow, not once per step, and a false "not logged in"
 * here silently drops every suite that would have shared this session back to
 * logging in individually — which is a correctness risk, not just a speed one,
 * for any suite that has no login steps of its own to fall back on (it has
 * nothing to replay, so it runs logged out instead). That asymmetry — cheap to
 * wait longer, expensive to misjudge — is why this budget is generous rather
 * than tuned to the common case.
 */
const LOGIN_CONFIRM_SETTLE_MS = 30_000;

/** True when a step's whole job is to put the browser on a page. */
function isNavigationStep(step: ParsedStep | undefined): boolean {
  return !!step && step.type === 'action' && step.action === 'navigate';
}

/**
 * Navigation errors that mean "this load was replaced by another one", not
 * "this navigation failed".
 *
 * When a single-page app's router redirects during the initial document load,
 * the browser cancels the in-flight request — and each engine reports that
 * cancellation with its own wording. Firefox raises NS_BINDING_ABORTED, which
 * surfaces as a hard step failure even though the browser genuinely arrived
 * where it was sent; Chromium and WebKit mostly absorb the same situation
 * silently, which is exactly why an app can pass on one engine and fail on
 * another with nothing actually different about the application.
 *
 * Recognising these is not the same as ignoring them: the caller still has to
 * confirm the page really landed somewhere before carrying on (see `navigateTo`).
 */
const SUPERSEDED_NAVIGATION_PATTERNS = [
  'NS_BINDING_ABORTED',
  'net::ERR_ABORTED',
  'Navigation interrupted by another one',
  'frame was detached',
];

function isSupersededNavigation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return SUPERSEDED_NAVIGATION_PATTERNS.some((p) => message.includes(p));
}

/**
 * Navigates, tolerating a load that a client-side redirect cancelled.
 *
 * A cancelled navigation is only accepted when the browser actually ended up on
 * a real page — never blank, never still sitting on the URL it started from with
 * nothing loaded. Anything else is re-thrown so a genuinely broken navigation
 * still fails the step, loudly, the way it should.
 */
async function navigateTo(
  page: Page,
  targetUrl: string,
  onNote: (msg: string) => void,
): Promise<void> {
  const from = page.url();
  try {
    await page.goto(targetUrl, { waitUntil: NAV_WAIT_UNTIL, timeout: UNIVERSAL_TIMEOUT_MS });
  } catch (err) {
    if (!isSupersededNavigation(err)) throw err;

    // Give the redirect that cancelled us a moment to arrive somewhere.
    await waitForPageSettle(page, { timeoutMs: CHECK_SETTLE_MS });
    const landed = page.url();
    const wentNowhere = !landed || landed === 'about:blank' || landed === from;
    if (wentNowhere) throw err;

    onNote(
      `Initial load was superseded by the application's own redirect ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : 'navigation aborted'}) — ` +
        `the browser did arrive, now at ${landed}.`,
    );
  }
}

/**
 * The leading entry of a dropdown is usually an instruction, not a choice
 * ("Select visibility", "What's this WorkPod for?", "-- none --"). Picking it
 * leaves the form untouched while reporting success, which is worse than
 * failing.
 */
const PLACEHOLDER_OPTION =
  /^(?:\s*(?:--+|—)?\s*)(?:select|choose|pick|please\s+select|none|any|all|what'?s|-{2,})\b|^\s*-{2,}\s*$/i;

/**
 * How an opened dropdown's options are rendered, across the frameworks a QA
 * team actually meets: ARIA-correct listboxes, Angular Material, the Angular
 * `ng-select` widget, MUI, Ant Design, Bootstrap, and plain `<li>` lists.
 */
const CUSTOM_OPTION_SELECTOR = [
  '[role="option"]',
  '[role="listbox"] li',
  '[role="menu"] [role="menuitem"]',
  'mat-option',
  '.mat-option',
  '.ng-option',
  '.ant-select-item-option',
  '.MuiMenuItem-root',
  '.MuiAutocomplete-option',
  '.dropdown-menu li',
  '.dropdown-menu .dropdown-item',
  '.select2-results__option',
  '.choices__item--choice',
].join(', ');

/** Human-readable name for what a resolved element turned out to be. */
function describeShape(tag: string, type: string, role: string): string {
  if (tag === 'select') return 'dropdown';
  if (type === 'checkbox' || role === 'checkbox') return 'checkbox';
  if (type === 'radio' || role === 'radio') return 'radio button';
  if (tag === 'textarea') return 'text area';
  if (tag === 'input') return `${type || 'text'} input`;
  if (role === 'combobox' || role === 'listbox') return 'dropdown';
  if (tag === 'button' || role === 'button') return 'button';
  if (tag === 'a') return 'link';
  return tag || 'element';
}

/** Longest a browser/context is given to close before it is abandoned. */
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * Closes a Browser or BrowserContext without letting a hung shutdown hang the
 * whole run with it.
 *
 * `.close().catch(() => {})` only guards against a *rejected* close — it does
 * nothing if close() simply never resolves, which every engine can do on an
 * unlucky run (observed in practice with WebKit's network process on this
 * platform). Racing a timeout against it means a stuck close leaks one OS
 * process instead of hanging the HTTP request that the user is waiting on.
 */
async function closeWithTimeout(target: { close: () => Promise<void> }): Promise<void> {
  await Promise.race([
    target.close().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
  ]);
}

/** What evidence to capture for each step. Mirrors the Settings page options. */
type ScreenshotPolicy = 'all' | 'on-failure' | 'off';

function resolveScreenshotPolicy(
  config: RunConfig | undefined,
  settings: { screenshotCapture?: string } | undefined,
): ScreenshotPolicy {
  // An explicit `captureScreenshots: false` from the run request always wins.
  if (config?.captureScreenshots === false) return 'off';

  const configured = settings?.screenshotCapture;
  if (configured === 'off' || configured === 'on-failure' || configured === 'all') return configured;
  return 'all';
}

/**
 * How many suites in a run may be re-run with a real login after failing on a
 * reused session.
 *
 * One. The retry exists to rule out a single cause — a stale cached session — and
 * one attempt settles that. A larger budget just replays a failing app several
 * times: every retry is another full login, and a run that fails for a real
 * reason ends up logging in four or five times before reporting the same result.
 * When the retry does not fix it, the failure is the answer.
 */
const REUSE_RETRY_BUDGET = 1;

// -----------------------------------------------------------------------
// Device emulation presets (Playwright built-in device descriptors)
// -----------------------------------------------------------------------
const DEVICE_CONFIGS: Record<
  DeviceMode,
  { viewport: { width: number; height: number }; userAgent?: string; isMobile?: boolean; hasTouch?: boolean }
> = {
  desktop: { viewport: { width: 1280, height: 800 } },
  'mobile-iphone14': {
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  },
  'mobile-android': {
    viewport: { width: 412, height: 915 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
    isMobile: true,
    hasTouch: true,
  },
  'tablet-ipad': {
    viewport: { width: 820, height: 1180 },
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  },
};

// Map string to Playwright BrowserType object
function getBrowserType(engine: BrowserEngine): BrowserType {
  switch (engine) {
    case 'firefox':
      return firefox;
    case 'webkit':
      return webkit;
    case 'chromium':
    default:
      return chromium;
  }
}

export interface RunConfig {
  headless?: boolean;
  generateScript?: boolean;
  /** Re-run each generated spec headless to confirm it replays. Slow (~doubles runtime); off by default. */
  verifyScript?: boolean;
  /** On failure, file the drafted bug as a Jira issue (real if configured, else mock). Off by default. */
  autoFileBug?: boolean;
  captureScreenshots?: boolean;
  captureConsoleLogs?: boolean;
  captureNetworkLogs?: boolean;
  browser?: BrowserEngine;
  deviceMode?: DeviceMode;
  maxWorkers?: number;
  /**
   * Log in once and share the authenticated session across every test case that
   * opens with the same login flow, instead of repeating the login UI per TC.
   * Defaults to the persisted setting (on).
   */
  reuseSession?: boolean;
  /** How long a cached session stays valid. Defaults to the persisted setting (20 min). */
  sessionTtlMinutes?: number;
  /**
   * Run every test case in ONE browser process (a fresh isolated context each),
   * instead of launching and closing a browser per test case. Defaults to on.
   */
  reuseBrowser?: boolean;
  /**
   * Which engine runs the steps.
   *
   * 'deterministic' — the parser/discovery engine only; a step it cannot handle fails.
   * 'auto'          — deterministic first, agent on any step it could not carry out (default).
   * 'ai'            — every step goes to the agent.
   *
   * 'auto' is the default because the deterministic path is free and fast: the
   * agent is worth paying for on the steps that need it, not on all of them.
   */
  executionMode?: ExecutionMode;
}

/** A test case as handed to the runner — TestSuite plus its session directives. */
export interface RunnableSuite {
  id: string;
  title: string;
  steps: ParsedStep[];
  /** `@fresh-login` — never reuse a cached session for this test case. */
  freshLogin?: boolean;
  /** `@reuse-session` — reuse a cached session even if this TC asserts on the login itself. */
  forceReuse?: boolean;
}

/** Everything a suite needs to start from a cached login instead of performing one. */
interface SuiteSessionPlan {
  key: string;
  session: CachedSession;
  /** This suite's own login steps, replaced by the cached session. Empty when the suite has no login steps. */
  skip: ParsedStep[];
  /** Steps that still execute in the browser. */
  run: ParsedStep[];
  /** The login flow that produced the session — replayed if the cached one turns out to be stale. */
  loginFlow: LoginPrologue;
}

/**
 * A login-less suite that got no plan because the upfront shared login attempt
 * failed — but a login suite in the same run (sequentially earlier) still might
 * succeed on its own and cache a session before this suite's turn comes. Worth
 * one fresh look at the cache right before running, instead of accepting
 * upfront planning as final and running logged out on a fixable technicality.
 */
interface HopefulSessionKey {
  key: string;
  loginFlow: LoginPrologue;
}

export interface IPlaywrightRunner {
  run(
    url: string,
    steps: ParsedStep[],
    appName?: string,
    moduleName?: string,
    config?: RunConfig,
  ): Promise<ExecutionContext>;

  runTestSuites(
    url: string,
    suites: RunnableSuite[],
    appName?: string,
    moduleName?: string,
    config?: RunConfig,
  ): Promise<ExecutionContext>;
}

export class PlaywrightRunner implements IPlaywrightRunner {
  private parser: TestCaseParser;
  private discovery: ElementDiscoveryEngine;
  private validator: Validator;
  private screenshotManager: ScreenshotManager;
  private domSnapshotManager: DomSnapshotManager;
  private logManager: LogManager;
  private reportGenerator: ReportGenerator;
  private scriptGenerator: PlaywrightGenerator;
  private scriptVerifier: ScriptVerifier;

  constructor() {
    this.parser = new TestCaseParser();
    this.discovery = new ElementDiscoveryEngine();
    this.validator = new Validator();
    this.screenshotManager = new ScreenshotManager();
    this.domSnapshotManager = new DomSnapshotManager();
    this.logManager = new LogManager();
    this.reportGenerator = new ReportGenerator();
    this.scriptGenerator = new PlaywrightGenerator();
    this.scriptVerifier = new ScriptVerifier();
  }

  // -----------------------------------------------------------------------
  // PUBLIC: run() — single flat step list (legacy / single TC path)
  // -----------------------------------------------------------------------
  public async run(
    url: string,
    steps: ParsedStep[],
    appName?: string,
    moduleName?: string,
    config?: RunConfig,
  ): Promise<ExecutionContext> {
    return this.runTestSuites(
      url,
      [{ id: 'TC01', title: 'TC01', steps }],
      appName,
      moduleName,
      config,
    );
  }

  // -----------------------------------------------------------------------
  // PUBLIC: runTestSuites() — parallel, independent per-TC execution
  // -----------------------------------------------------------------------
  public async runTestSuites(
    url: string,
    suites: RunnableSuite[],
    appName?: string,
    moduleName?: string,
    config?: RunConfig & { runId?: string },
  ): Promise<ExecutionContext> {
    const runId = config?.runId || uuidv4();
    const startTime = new Date().toISOString();
    const browser = config?.browser ?? 'chromium';
    const deviceMode = config?.deviceMode ?? 'desktop';
    const maxWorkers = Math.max(1, Math.min(config?.maxWorkers ?? 1, 8));

    // Hybrid execution. Constructed unconditionally but inert unless the mode
    // allows it AND a key is configured — isEnabled() answers both, so callers
    // never have to know which of the two is missing.
    const executionMode: ExecutionMode = config?.executionMode ?? 'auto';
    this.escalator = new StepEscalator({
      mode: executionMode,
      outputDir: path.join(process.cwd(), 'test-runs', runId, 'mcp'),
      isCancelled: () => runRegistry.isAborted(runId),
    });

    // Register this run (preserving an abort that arrived before start) + seed live logs.
    const preAborted = runRegistry.get(runId)?.aborted === true;
    const activeRun = runRegistry.start(runId);
    activeRun.aborted = preAborted;

    // State the evidence policy up front. It is driven by the Settings page, and a
    // report with no per-step screenshots should never leave the reader guessing
    // whether that was a setting or a fault.
    const screenshotPolicy = resolveScreenshotPolicy(config, fileHelper.getSettings());
    const screenshotNote =
      screenshotPolicy === 'all'
        ? 'every step'
        : screenshotPolicy === 'on-failure'
          ? 'failures only (Settings → Screenshot Capture Mode)'
          : 'disabled';

    runRegistry.initLogs(runId, [
      `[${new Date().toLocaleTimeString()}] [SYSTEM] Run ${runId} started (node ${process.version})`,
      `[${new Date().toLocaleTimeString()}] [SYSTEM] Suites: ${suites.length} | Browser: ${browser} | Device: ${deviceMode} | Workers: ${maxWorkers}`,
      `[${new Date().toLocaleTimeString()}] [SYSTEM] Screenshots: ${screenshotNote}`,
    ]);

    logger.info(
      `Starting parallel test run. Suites: ${suites.length}, Workers: ${maxWorkers}, Browser: ${browser}, Device: ${deviceMode}`,
    );

    const context: ExecutionContext = {
      runId,
      url,
      appName,
      moduleName,
      browser,
      deviceMode,
      status: 'running',
      startTime,
      locatorMap: {},
      stepResults: [],
      consoleLogs: [],
      networkErrors: [],
      testSuiteResults: [],
    };

    // ---- Plan login-session reuse before any suite runs ----
    const { plans, captureKeys, hopefulKeys, summary } = await this._planSessionReuse(
      url,
      suites,
      runId,
      browser,
      deviceMode,
      config,
    );

    // Suites that log out are scheduled last: a server-side logout can invalidate
    // the token the other suites are sharing.
    const ordered = [...suites]
      .map((suite, index) => ({ suite, index, logsOut: containsLogout(suite.steps) }))
      .sort((a, b) => (a.logsOut === b.logsOut ? a.index - b.index : a.logsOut ? 1 : -1));

    if (ordered.some((o) => o.logsOut) && suites.length > 1) {
      runRegistry.pushLog(
        runId,
        `[${new Date().toLocaleTimeString()}] [SESSION] Logout test case(s) scheduled last so they cannot end the shared session early.`,
      );
    }

    // ---- Run suites in batches controlled by maxWorkers ----
    const batches = this._planBatches(ordered, maxWorkers);
    const indexed: { result: TestSuiteResult; index: number }[] = [];
    let reuseRetriesLeft = REUSE_RETRY_BUDGET;

    try {
      for (const batch of batches) {

        const batchResults = await Promise.all(
          batch.map(async ({ suite, index }) => {
            let result = await this._executeSuite(suite, url, runId, browser, deviceMode, config, {
              plan: plans.get(suite.id),
              captureKey: captureKeys.get(suite.id),
              hopefulKey: hopefulKeys.get(suite.id),
            });

            // Self-healing: a suite that started from a cached session and failed
            // is re-run once with a real login. Reuse then never turns into a false
            // failure — an assertion on a post-login flash message, say — while
            // costing nothing for the suites that pass.
            const retryVerdict = shouldRetryAfterReuse(result.stepResults);
            if (result.sessionReused && result.status === 'failed' && !retryVerdict.worthRetrying) {
              runRegistry.pushLog(
                runId,
                `[${new Date().toLocaleTimeString()}] [${suite.id}] Failed after reusing a cached login, but ${retryVerdict.reason} — reporting the failure as-is.`,
              );
            } else if (result.sessionReused && result.status === 'failed' && reuseRetriesLeft > 0) {
              reuseRetriesLeft -= 1;
              runRegistry.pushLog(
                runId,
                `[${new Date().toLocaleTimeString()}] [${suite.id}] Failed after reusing a cached login — retrying once with a real login...`,
              );
              const plan = plans.get(suite.id);
              if (plan) invalidateSession(plan.key);

              const hasOwnLogin = hasLoginSteps(suite.steps);
              const retry = await this._executeSuite(suite, url, runId, browser, deviceMode, config, {
                // A suite with its own login steps replays them for real. One
                // without them keeps the plan but logs in inline as setup.
                plan: hasOwnLogin ? undefined : plan,
                captureKey: hasOwnLogin ? plan?.key : undefined,
                reprime: !hasOwnLogin,
              });
              retry.retriedWithFreshLogin = true;
              runRegistry.pushLog(
                runId,
                `[${new Date().toLocaleTimeString()}] [${suite.id}] Retry with a real login: ${retry.status}`,
              );
              result = retry;
            } else if (result.sessionReused && result.status === 'failed') {
              runRegistry.pushLog(
                runId,
                `[${new Date().toLocaleTimeString()}] [${suite.id}] Failed after reusing a cached login, but the retry budget (${REUSE_RETRY_BUDGET}) is spent — reporting the failure as-is.`,
              );
            }

            return { result, index };
          }),
        );

        indexed.push(...batchResults);
      }
    } finally {
      // MCP sessions are bound to the browser contexts, so they close first.
      await this.escalator?.dispose();
      // The shared browser process lives for exactly one run.
      await this._releaseSharedBrowser();
    }

    // Report in the order the test cases were written, not the order they ran.
    const suiteResults = indexed.sort((a, b) => a.index - b.index).map((r) => r.result);

    // A logout invalidates the shared session server-side — drop the cache so the
    // next run logs in again instead of restoring a dead token.
    if (summary.enabled && ordered.some((o) => o.logsOut)) {
      for (const key of new Set([...plans.values()].map((p) => p.key))) invalidateSession(key);
    }

    summary.reusedSuites = suiteResults.filter((s) => s.sessionReused).length;
    summary.freshLoginSuites = suiteResults.length - summary.reusedSuites;
    summary.estimatedSavedMs = summary.perLoginMs * summary.reusedSuites;
    context.sessionReuse = {
      enabled: summary.enabled,
      primedLogins: summary.primedLogins,
      reusedSuites: summary.reusedSuites,
      freshLoginSuites: summary.freshLoginSuites,
      estimatedSavedMs: summary.estimatedSavedMs,
    };

    if (summary.enabled && summary.reusedSuites > 0) {
      runRegistry.pushLog(
        runId,
        `[${new Date().toLocaleTimeString()}] [SESSION] ${summary.reusedSuites} suite(s) reused a cached login` +
          (summary.estimatedSavedMs > 0
            ? ` — approx ${(summary.estimatedSavedMs / 1000).toFixed(1)}s of login time skipped`
            : ''),
      );
    }

    // ---- Aggregate all step results into flat context.stepResults ----
    const allNetworkRequests: NetworkRequestRecord[] = [];
    for (const sr of suiteResults) {
      context.stepResults.push(...sr.stepResults);
      if (sr.networkRequests) {
        allNetworkRequests.push(...sr.networkRequests);
      }
      if (sr.consoleLogs) context.consoleLogs.push(...sr.consoleLogs);
      if (sr.networkErrors) context.networkErrors.push(...sr.networkErrors);
    }
    context.networkRequests = allNetworkRequests;

    // What AI execution cost this run. Omitted entirely when nothing escalated,
    // so a purely deterministic run does not report a cost of zero as though it
    // had used the agent.
    const aiSteps = context.stepResults.filter((r) => r.executedBy === 'ai').length;
    if (aiSteps > 0 && this.escalator) {
      const usage = this.escalator.getBudget().getUsage();
      context.aiUsage = {
        model: this.escalator.getModel(),
        stepsExecutedByAi: aiSteps,
        modelTurns: usage.modelTurns,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
      };
      runRegistry.pushLog(
        runId,
        `[${new Date().toLocaleTimeString()}] [AI] ${aiSteps} step(s) executed by the agent ` +
          `across ${usage.modelTurns} model turn(s) — approx $${usage.estimatedCostUsd.toFixed(4)}`,
      );
    }

    context.testSuiteResults = suiteResults;
    context.status = suiteResults.some((s) => s.status === 'failed') ? 'failed' : 'completed';
    context.endTime = new Date().toISOString();
    context.durationMs = Date.now() - new Date(context.startTime).getTime();

    // ---- Generate Playwright spec for each suite FIRST, so the report (and any
    //      auto-filed bug) is produced once with script paths already attached. ----
    if (config?.generateScript !== false) {
      for (const sr of suiteResults) {
        if (!sr.generatedScriptPath) {
          const suiteCtx: ExecutionContext = {
            ...context,
            stepResults: sr.stepResults,
            testSuiteResults: undefined,
          };
          const specUrl = await this.scriptGenerator.generateSpec(suiteCtx, sr.tcId);
          sr.generatedScriptPath = specUrl;
        }

        // Opt-in: replay the generated spec headless to confirm it actually works.
        if (config?.verifyScript && sr.generatedScriptPath) {
          const specFileName = path.basename(sr.generatedScriptPath);
          runRegistry.pushLog(runId, `[${new Date().toLocaleTimeString()}] [${sr.tcId}] Verifying generated spec...`);
          sr.scriptVerification = await this.scriptVerifier.verify(specFileName).catch((e) => ({
            status: 'error' as const,
            durationMs: 0,
            output: e?.message,
          }));
          runRegistry.pushLog(
            runId,
            `[${new Date().toLocaleTimeString()}] [${sr.tcId}] Spec verification: ${sr.scriptVerification.status}`,
          );
        }
      }

      // Use the first suite's script path as the primary
      context.generatedScriptPath = suiteResults[0]?.generatedScriptPath;
    }

    // ---- Generate the report once (drafts/files a bug on failure per config). ----
    const reportPayload = await this.reportGenerator.generate(context, {
      autoFileBug: config?.autoFileBug,
    });
    context.bugReport = reportPayload.details.bugReport;
    context.failureClassification = reportPayload.details.failureClassification;

    // Say plainly, in the live log, whether this run found a product problem or
    // tripped over its own automation — that distinction is the whole point of
    // the run and it should not require opening the report to discover.
    if (context.failureClassification) {
      const fc = context.failureClassification;
      runRegistry.pushLog(
        runId,
        `[${new Date().toLocaleTimeString()}] [VERDICT] ${fc.label}\n` +
          `    ${fc.reason}\n` +
          `    Next: ${fc.nextStep}` +
          (fc.fileAsBug ? '' : '\n    No bug was raised — this is not an application defect.'),
      );
    }

    runRegistry.finish(runId);

    return context;
  }

  /**
   * Groups the ordered suites into batches that run concurrently.
   *
   * Ordering already puts logout suites last, but ordering alone is not enough
   * once more than one worker is in play: with `maxWorkers` 2 the last ordinary
   * suite and the logout suite land in the same batch and run side by side, and
   * the logout kills the shared token underneath the suite still using it. So a
   * logout suite always gets a batch to itself — the barrier the ordering was
   * there to create, actually enforced. Parallelism is then safe to turn up.
   */
  private _planBatches<T extends { logsOut: boolean }>(ordered: T[], maxWorkers: number): T[][] {
    const batches: T[][] = [];
    let current: T[] = [];

    for (const item of ordered) {
      if (item.logsOut) {
        if (current.length > 0) batches.push(current);
        current = [];
        batches.push([item]);
        continue;
      }
      current.push(item);
      if (current.length === maxWorkers) {
        batches.push(current);
        current = [];
      }
    }

    if (current.length > 0) batches.push(current);
    return batches;
  }

  // -----------------------------------------------------------------------
  // PRIVATE: _planSessionReuse() — decides which suites can skip their login
  //
  // Two kinds of suite consume a shared session:
  //   • login suites      — they open with a login flow, which gets skipped
  //   • login-less suites — they jump straight into an authenticated area
  //                         (e.g. "Navigate to /desktop/home"), so without a
  //                         session they land on the login page and fail
  //
  // Suites are grouped by login-flow fingerprint. Per group:
  //   • cache hit                    -> every consumer reuses it
  //   • cache miss, 2+ consumers     -> log in once up front, all reuse it
  //   • cache miss, 1 login suite    -> it logs in itself; its session is cached
  //                                     so the next run starts warm
  // -----------------------------------------------------------------------
  private async _planSessionReuse(
    url: string,
    suites: RunnableSuite[],
    runId: string,
    browserEngine: BrowserEngine,
    deviceMode: DeviceMode,
    config?: RunConfig,
  ): Promise<{
    plans: Map<string, SuiteSessionPlan>;
    captureKeys: Map<string, string>;
    hopefulKeys: Map<string, HopefulSessionKey>;
    summary: SessionReuseSummary & { perLoginMs: number };
  }> {
    const settings = fileHelper.getSettings();
    const enabled = config?.reuseSession ?? settings.reuseSession ?? true;
    const ttlMinutes =
      config?.sessionTtlMinutes ?? settings.sessionTtlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;

    const plans = new Map<string, SuiteSessionPlan>();
    const captureKeys = new Map<string, string>();
    const hopefulKeys = new Map<string, HopefulSessionKey>();
    const summary = {
      enabled,
      primedLogins: 0,
      reusedSuites: 0,
      freshLoginSuites: 0,
      estimatedSavedMs: 0,
      perLoginMs: 0,
    };

    if (!enabled) return { plans, captureKeys, hopefulKeys, summary };

    // ---- Classify every suite ----
    // Each suite keeps its OWN steps: suites in a group log in the same way, but
    // their step objects (raw text, indexes) and their remaining steps differ.
    const loginSuites = new Map<string, { key: string; prologue: LoginPrologue }>();
    const loginlessSuiteIds: string[] = [];
    const groups = new Map<string, { prologue: LoginPrologue; suiteIds: string[] }>();

    for (const suite of suites) {
      // Explicit opt-out from the test text: run this TC from a clean, logged-out browser.
      if (suite.freshLogin) {
        runRegistry.pushLog(
          runId,
          `[${new Date().toLocaleTimeString()}] [${suite.id}] @fresh-login — this test case starts logged out.`,
        );
        continue;
      }

      const prologue = detectLoginPrologue(suite.steps);

      if (prologue) {
        const key = computeSessionKey({
          url,
          browser: browserEngine,
          deviceMode,
          loginSteps: prologue.steps,
        });
        loginSuites.set(suite.id, { key, prologue });
        const group = groups.get(key);
        if (group) group.suiteIds.push(suite.id);
        else groups.set(key, { prologue, suiteIds: [suite.id] });
        continue;
      }

      // No login flow of its own. If it never enters credentials it is a
      // continuation test case ("go to /desktop/home, open the profile menu…")
      // that assumes an authenticated browser — give it the shared session.
      // Negative-login suites DO enter credentials, so they are excluded here.
      if (!hasLoginSteps(suite.steps)) loginlessSuiteIds.push(suite.id);
    }

    if (groups.size === 0) {
      if (loginlessSuiteIds.length > 0) {
        runRegistry.pushLog(
          runId,
          `[${new Date().toLocaleTimeString()}] [SESSION] ${loginlessSuiteIds.join(', ')} need an authenticated browser but no test case in this module performs a successful login — add a login test case to enable reuse.`,
        );
      }
      return { plans, captureKeys, hopefulKeys, summary };
    }

    // Login-less suites ride along with the first login flow that actually yields a
    // working session, so a flow that fails to log in cannot strand them.
    let pendingLoginless = [...loginlessSuiteIds];

    for (const [key, group] of groups) {
      const consumers = [...group.suiteIds, ...pendingLoginless];
      let session = loadSession(key, ttlMinutes);

      if (session) {
        runRegistry.pushLog(
          runId,
          `[${new Date().toLocaleTimeString()}] [SESSION] Reusing cached login for ${consumers.join(', ')} (cached ${new Date(session.createdAt).toLocaleTimeString()})`,
        );
      } else if (consumers.length > 1) {
        // Worth a dedicated login: one login now replaces N logins.
        session = await this._primeSession(url, group.prologue, key, runId, browserEngine, deviceMode, config);
        if (session) summary.primedLogins += 1;
      } else {
        // A single login suite would pay for two logins if we primed — let it log
        // in normally and cache what it produces so the next run starts warm.
        captureKeys.set(group.suiteIds[0], key);
        continue;
      }

      if (!session) {
        // Priming failed — these suites log in themselves, and any login-less suite
        // stays pending so the next flow can pick it up. It also gets a hopeful
        // key: if one of those login suites succeeds on its own later in this
        // same run, this suite gets one fresh look at the cache right before it
        // executes, rather than being stranded on a failure that already resolved
        // itself by the time its turn came.
        group.suiteIds.forEach((id) => captureKeys.set(id, key));
        pendingLoginless.forEach((id) => hopefulKeys.set(id, { key, loginFlow: group.prologue }));
        continue;
      }

      // This flow works: the login-less suites are now covered.
      group.suiteIds.push(...pendingLoginless);
      pendingLoginless = [];

      summary.perLoginMs = Math.max(summary.perLoginMs, session.loginDurationMs ?? 0);
      for (const suiteId of group.suiteIds) {
        const own = loginSuites.get(suiteId);
        const suite = suites.find((s) => s.id === suiteId)!;
        plans.set(suiteId, {
          key,
          session,
          loginFlow: group.prologue,
          // A login suite skips its own login steps; a login-less suite skips nothing
          // and simply starts out authenticated.
          skip: own ? own.prologue.steps : [],
          run: own ? own.prologue.rest : suite.steps,
        });
      }
    }

    return { plans, captureKeys, hopefulKeys, summary };
  }

  // -----------------------------------------------------------------------
  // PRIVATE: _primeSession() — performs ONE real login and caches the state
  // -----------------------------------------------------------------------
  private async _primeSession(
    url: string,
    prologue: LoginPrologue,
    key: string,
    runId: string,
    browserEngine: BrowserEngine,
    deviceMode: DeviceMode,
    config?: RunConfig,
  ): Promise<CachedSession | null> {
    const settings = fileHelper.getSettings();
    const isHeadless = config?.headless !== undefined ? config.headless : settings.headlessMode;
    const deviceConfig = DEVICE_CONFIGS[deviceMode];
    const started = Date.now();

    const pushRealTimeLog = (msg: string) => {
      runRegistry.pushLog(runId, `[${new Date().toLocaleTimeString()}] [SESSION] ${msg}`);
    };

    pushRealTimeLog(`No cached session — logging in once to share across test cases...`);

    let browserContext: BrowserContext | undefined;
    try {
      const { browser } = await this._acquireBrowser(runId, browserEngine, isHeadless, config);

      if (runRegistry.isAborted(runId)) return null;

      browserContext = await browser.newContext({
        viewport: deviceConfig.viewport,
        userAgent: deviceConfig.userAgent,
        isMobile: deviceConfig.isMobile ?? false,
        hasTouch: deviceConfig.hasTouch ?? false,
      });
      const page = await browserContext.newPage();
      await installNetworkActivityTracker(page);

      const stepResults = await this._executeSteps({
        page,
        steps: prologue.steps,
        suiteId: 'SESSION',
        runId,
        url,
        isHeadless,
        // Screenshots of the priming login are attached to the suites that reuse
        // it, so the report still shows what the login did.
        config,
        evidencePrefix: `${runId}-SESSION`,
        pushRealTimeLog,
      });

      if (stepResults.some((r) => r.status !== 'passed')) {
        const failed = stepResults.find((r) => r.status === 'failed');
        pushRealTimeLog(`Shared login failed (${failed?.error || 'unknown error'}) — each test case will log in itself.`);
        return null;
      }

      const auth = await this._looksAuthenticated(page, LOGIN_CONFIRM_SETTLE_MS);
      if (!auth.ok) {
        pushRealTimeLog(`Shared login could not be confirmed (${auth.reason}) — each test case will log in itself.`);
        return null;
      }

      const session: CachedSession = {
        key,
        createdAt: new Date().toISOString(),
        landingUrl: page.url(),
        storageState: await browserContext.storageState(),
        prologueSelectors: stepResults.map((r) => r.resolvedSelector ?? null),
        loginDurationMs: Date.now() - started,
      };
      saveSession(session);
      pushRealTimeLog(
        `Shared login succeeded in ${((session.loginDurationMs ?? 0) / 1000).toFixed(1)}s — landing: ${session.landingUrl}`,
      );

      // Keep the primed screenshots on the record so reusing suites can show them.
      this.primedEvidence.set(key, stepResults);

      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Session priming failed', err);
      pushRealTimeLog(`Shared login errored (${message}) — each test case will log in itself.`);
      return null;
    } finally {
      // Only the priming context goes away; the browser process stays up for the suites.
      if (browserContext) await closeWithTimeout(browserContext);
    }
  }

  /** Step evidence from the priming login, keyed by session key (in-process only). */
  private primedEvidence = new Map<string, StepExecutionResult[]>();

  /**
   * The agent half of hybrid execution for the current run.
   *
   * Undefined for a deterministic-only run, so every escalation site must treat
   * its absence as "there is no fallback" rather than as an error.
   */
  private escalator?: StepEscalator;

  /** The one browser process shared by every test case in this run (when enabled). */
  private sharedBrowser?: Browser;
  /** In-flight launch, so suites starting together do not each launch a browser. */
  private sharedBrowserLaunch?: Promise<Browser>;

  private async _launchBrowser(browserEngine: BrowserEngine, isHeadless: boolean): Promise<Browser> {
    return getBrowserType(browserEngine).launch({
      headless: isHeadless,
      slowMo: isHeadless ? undefined : 1000, // headed mode: slow down so interactions are visible
      args:
        browserEngine === 'chromium'
          ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
          : [],
    });
  }

  /**
   * Hands back the browser a suite should use.
   *
   * With `reuseBrowser` on (default) every test case runs in ONE browser process,
   * each in its own isolated context — so a 20-TC module launches Chrome once
   * instead of twenty times. Contexts give the same isolation a fresh process
   * does for cookies, storage and cache; only the process start-up is shared.
   * `owned: false` tells the caller to close its context but leave the browser up.
   */
  private async _acquireBrowser(
    runId: string,
    browserEngine: BrowserEngine,
    isHeadless: boolean,
    config?: RunConfig,
  ): Promise<{ browser: Browser; owned: boolean }> {
    if (config?.reuseBrowser === false) {
      const browser = await this._launchBrowser(browserEngine, isHeadless);
      runRegistry.registerBrowser(runId, browser);
      return { browser, owned: true };
    }

    // A crashed or cancel-closed browser must not be handed to the next suite.
    if (this.sharedBrowser && !this.sharedBrowser.isConnected()) {
      this.sharedBrowser = undefined;
      this.sharedBrowserLaunch = undefined;
    }

    if (!this.sharedBrowserLaunch) {
      this.sharedBrowserLaunch = this._launchBrowser(browserEngine, isHeadless).then((b) => {
        this.sharedBrowser = b;
        runRegistry.registerBrowser(runId, b);
        return b;
      });
    }

    return { browser: await this.sharedBrowserLaunch, owned: false };
  }

  /** Closes the shared browser at the end of a run. */
  private async _releaseSharedBrowser(): Promise<void> {
    const browser = this.sharedBrowser;
    this.sharedBrowser = undefined;
    this.sharedBrowserLaunch = undefined;
    if (browser) await closeWithTimeout(browser);
  }

  /**
   * Decides how to actually operate a resolved element, regardless of the verb
   * the step happened to use.
   *
   * A test author writing "Enter workpod name" and "Select visibility" is naming
   * the same thing both times — the control they want to set — and the choice of
   * word carries no information the runner needs. What decides the correct
   * interaction is the ELEMENT: you type into a text input, choose from a
   * listbox, toggle a checkbox, click a button. Insisting the author's verb
   * match the widget makes the tool fail for a reason that has nothing to do
   * with the application under test, which is the definition of an automation
   * gap rather than a defect.
   *
   * Every adaptation is logged, because "the step said fill and I clicked
   * instead" is exactly the kind of helpfulness that must not be silent.
   */
  private async _interact(
    page: Page,
    match: DiscoveryMatch,
    step: ParsedStep,
    requestedValue: string | undefined,
    log: (msg: string) => void,
  ): Promise<{ performed: ActionType; usedValue?: string }> {
    let locator = page.locator(match.selector).first();

    // A form's visible text is its <label>, so a search for "Intent" very often
    // lands on the label rather than the control it names. Acting on the label
    // is never what was meant — clicking one does nothing useful and, worse,
    // succeeds. Hop to the control the label points at.
    const labelTarget = await locator
      .evaluate((el) => {
        if (el.tagName.toLowerCase() !== 'label') return null;
        // Broad on purpose. A "dropdown" in the wild is rarely a <select>: it is
        // an anchor with data-bs-toggle, an ng-select, a mat-select, or a custom
        // element wrapping one of those. Missing the control and staying on the
        // label is how a step ends up clicking a caption and reporting success.
        const CONTROL =
          'input, select, textarea, [role="combobox"], [role="listbox"], [data-bs-toggle="dropdown"], ' +
          '[aria-haspopup], .ng-select, .mat-select, .ant-select, .form-control-select, ' +
          'app-dropdown a[role="button"], .dropdown > a[role="button"], .dropdown > button';
        const forId = el.getAttribute('for');
        const byFor = forId ? document.getElementById(forId) : null;
        const inside = el.querySelector(CONTROL);
        // The label and its control are siblings inside a form group.
        const after = el.parentElement?.querySelector(CONTROL);
        const control = byFor ?? inside ?? after;
        if (!control) return null;
        const w = window as unknown as { __autoqaUniqueSelector?: (e: Element) => string };
        return w.__autoqaUniqueSelector ? w.__autoqaUniqueSelector(control) : null;
      })
      .catch(() => null);

    if (labelTarget) {
      log(`«${step.targetField}» resolved to a label — using the control it labels ("${labelTarget}") instead.`);
      locator = page.locator(labelTarget).first();
    }

    const shape = await locator
      .evaluate((el) => {
        const tag = el.tagName.toLowerCase();
        const input = el as HTMLInputElement;
        const type = (el.getAttribute('type') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        return {
          tag,
          type,
          role,
          checked: tag === 'input' ? !!input.checked : false,
          editable: (el as HTMLElement).isContentEditable === true,
          hasPopup: el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded'),
          disabled: (el as HTMLInputElement).disabled === true,
        };
      })
      .catch(() => null);

    // Element could not be inspected (detached mid-step) — fall back to the
    // author's verb rather than guessing from nothing.
    const tag = shape?.tag ?? '';
    const type = shape?.type ?? '';
    const role = shape?.role ?? '';

    const isNativeSelect = tag === 'select';
    const isCheckbox = type === 'checkbox' || role === 'checkbox';
    const isRadio = type === 'radio' || role === 'radio';
    const isTextEntry =
      tag === 'textarea' ||
      shape?.editable === true ||
      (tag === 'input' &&
        !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image'].includes(type)) ||
      role === 'textbox';
    // Whether this *could* behave like a custom dropdown. Deliberately not
    // enough on its own to trigger option-picking — see the guard below.
    const dropdownLike =
      !isNativeSelect &&
      (role === 'combobox' || role === 'listbox' || (shape?.hasPopup === true && !isTextEntry));

    const requested = step.action ?? 'click';
    const note = (performed: string) => {
      if (performed !== requested) {
        log(
          `Step says "${requested}" but «${step.targetField}» is a ${describeShape(tag, type, role)} — ` +
            `performing ${performed} instead (the element decides, not the wording).`,
        );
      }
    };

    // ---- Native <select> ----
    if (isNativeSelect) {
      note('select');
      const chosen = await this._chooseNativeOption(locator, step, requestedValue, log);
      return { performed: 'select', usedValue: chosen };
    }

    // ---- Custom dropdown (Angular/React/MUI/Ant — a div that behaves like a select) ----
    //
    // Only when the step actually asked to SELECT. A step that says "click" gets
    // a click, even on a control that looks dropdown-ish, and this is not a
    // detail: a profile avatar carries aria-haspopup exactly like a dropdown
    // does, so treating "click the JR icon" as a select would open the menu and
    // then pick an item out of it — logging the user out in the middle of a test
    // about something else entirely. "Click" means click.
    if (requested === 'select' && !isTextEntry && !isCheckbox && !isRadio) {
      if (!dropdownLike) {
        log(`«${step.targetField}» is a ${describeShape(tag, type, role)} rather than a labelled dropdown — trying it as one anyway.`);
      }
      note('select');
      const chosen = await this._chooseCustomOption(page, locator, step, requestedValue, log);
      if (chosen !== null) return { performed: 'select', usedValue: chosen };

      // Nothing selectable ever appeared. Degrading to a plain click here would
      // be the worst possible outcome: the step passes, the report says the
      // dropdown was set, and the field is actually still empty — so a later
      // "Create" fails validation for a reason nothing in the run explains. A
      // select that selected nothing did not happen, and has to say so.
      throw new Error(
        `Could not choose a value in «${step.targetField}»: clicking it opened no list of options ` +
          `(looked for ${'role="option"'}, menu items and the usual framework option classes). ` +
          `If this control is not a dropdown, write the step as \`click "${step.targetField}"\`; ` +
          `if it is, the options never rendered.`,
      );
    }

    // ---- Checkbox / radio ----
    if (isCheckbox || isRadio) {
      const wantOff = requested === 'uncheck';
      note(wantOff ? 'uncheck' : 'check');
      if (isRadio || !wantOff) await locator.check({ timeout: 15_000 });
      else await locator.uncheck({ timeout: 15_000 });
      return { performed: wantOff ? 'uncheck' : 'check' };
    }

    // ---- Text entry ----
    if (isTextEntry) {
      note('fill');
      const value = requestedValue ?? '';
      await locator.fill(value, { timeout: 15_000 });
      return { performed: 'fill', usedValue: value };
    }

    // ---- Anything else is a click target ----
    note('click');
    await locator.click({ timeout: 15_000 });
    return { performed: 'click' };
  }

  /** Picks an option from a real <select>, honouring a named one when given. */
  private async _chooseNativeOption(
    locator: Locator,
    step: ParsedStep,
    requestedValue: string | undefined,
    log: (msg: string) => void,
  ): Promise<string | undefined> {
    const options = await locator
      .evaluate((el) =>
        el instanceof HTMLSelectElement
          ? Array.from(el.options).map((o) => ({
              value: o.value,
              label: (o.textContent || '').trim(),
              disabled: o.disabled,
            }))
          : [],
      )
      .catch(() => [] as { value: string; label: string; disabled: boolean }[]);

    const selectable = options.filter(
      (o) => !o.disabled && o.value !== '' && !PLACEHOLDER_OPTION.test(o.label),
    );

    if (requestedValue) {
      const wanted = requestedValue.trim().toLowerCase();
      const exact = selectable.find(
        (o) => o.label.toLowerCase() === wanted || o.value.toLowerCase() === wanted,
      );
      const loose = selectable.find((o) => o.label.toLowerCase().includes(wanted));
      const hit = exact ?? loose;
      if (hit) {
        await locator.selectOption(hit.value);
        if (!exact) log(`No option exactly matched "${requestedValue}" — chose the closest, "${hit.label}".`);
        return hit.label || hit.value;
      }
      // The named option does not exist. That is a claim about the application,
      // not about wording, so it is allowed to fail.
      throw new Error(
        `Option "${requestedValue}" is not available in «${step.targetField}». ` +
          `Available: ${selectable.map((o) => o.label || o.value).join(', ') || '(none)'}.`,
      );
    }

    if (selectable.length === 0) {
      throw new Error(
        `«${step.targetField}» has no selectable option to choose ` +
          `(${options.length} found, all blank, disabled or placeholders).`,
      );
    }
    const pick = selectable[0];
    await locator.selectOption(pick.value);
    log(`No option was named — selected "${pick.label || pick.value}" from «${step.targetField}».`);
    return pick.label || pick.value;
  }

  /**
   * Operates a dropdown that is not a `<select>` — the common case in Angular,
   * React, MUI and Ant Design, where the control is a div and the options only
   * exist in the DOM once it has been opened.
   *
   * Returns null when nothing dropdown-like appeared, so the caller can fall
   * back to treating the element as an ordinary control.
   */
  private async _chooseCustomOption(
    page: Page,
    trigger: Locator,
    step: ParsedStep,
    requestedValue: string | undefined,
    log: (msg: string) => void,
  ): Promise<string | null> {
    await trigger.click({ timeout: 15_000 }).catch(() => {});
    await waitForPageSettle(page, { timeoutMs: 2_000 });

    const optionLocator = page.locator(CUSTOM_OPTION_SELECTOR);
    // The list is rendered on open, so give it a beat to appear before deciding
    // this was never a dropdown at all.
    await optionLocator.first().waitFor({ state: 'visible', timeout: 2_500 }).catch(() => {});

    const options = await optionLocator
      .evaluateAll((els) =>
        els
          .map((el, index) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return {
              index,
              label: ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
              visible:
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden',
              disabled:
                el.getAttribute('aria-disabled') === 'true' ||
                el.classList.contains('disabled') ||
                (el as HTMLButtonElement).disabled === true,
            };
          })
          .filter((o) => o.visible && !o.disabled && o.label.length > 0),
      )
      .catch(() => [] as { index: number; label: string; visible: boolean; disabled: boolean }[]);

    const usable = options.filter((o) => !PLACEHOLDER_OPTION.test(o.label));
    if (usable.length === 0) {
      // Close whatever may have opened so the next step starts clean.
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }

    let pick = usable[0];
    if (requestedValue) {
      const wanted = requestedValue.trim().toLowerCase();
      const exact = usable.find((o) => o.label.toLowerCase() === wanted);
      const loose = usable.find((o) => o.label.toLowerCase().includes(wanted));
      const hit = exact ?? loose;
      if (!hit) {
        await page.keyboard.press('Escape').catch(() => {});
        throw new Error(
          `Option "${requestedValue}" is not available in «${step.targetField}». ` +
            `Available: ${usable.slice(0, 12).map((o) => o.label).join(', ')}.`,
        );
      }
      if (!exact) log(`No option exactly matched "${requestedValue}" — chose the closest, "${hit.label}".`);
      pick = hit;
    } else {
      log(`No option was named — selected "${pick.label}" from the «${step.targetField}» dropdown.`);
    }

    // The clickable node is often an <a> inside the <li>, and the framework's
    // handler is bound to it rather than to the list item — clicking the wrapper
    // can land on padding and quietly do nothing.
    const chosen = optionLocator.nth(pick.index);
    const inner = chosen.locator('a, button, [role="option"]').first();
    if ((await inner.count().catch(() => 0)) > 0) {
      await inner.click({ timeout: 10_000 });
    } else {
      await chosen.click({ timeout: 10_000 });
    }
    return pick.label;
  }

  /**
   * Confirms a page is in an authenticated state — used both after the priming
   * login and after restoring a cached session, so a stale or revoked session
   * can never be silently reused.
   */
  private async _looksAuthenticated(
    page: Page,
    settleMs: number = CHECK_SETTLE_MS,
  ): Promise<{ ok: boolean; reason: string }> {
    try {
      await waitForPageSettle(page, { timeoutMs: settleMs });

      // A visible password field means we are looking at a login form.
      const passwordVisible = await page
        .locator('input[type="password"]')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (passwordVisible) return { ok: false, reason: 'a login form is still displayed' };

      const currentUrl = page.url();
      if (/\/(login|signin|sign-in|sign_in|auth\/login)(\b|\/|\?|#|$)/i.test(currentUrl)) {
        return { ok: false, reason: `redirected back to ${currentUrl}` };
      }

      return { ok: true, reason: 'authenticated' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'authentication check failed' };
    }
  }

  /**
   * Logs in inside a suite's own page, using the module's login flow as setup.
   *
   * Needed by test cases that contain no login steps themselves (they open an
   * authenticated URL directly). Replaying the flow here — rather than restoring
   * state — also covers apps that keep their token in localStorage. The resulting
   * session is cached so the remaining suites benefit, and the login steps are
   * deliberately kept out of the test case's own results: they are setup.
   */
  private async _loginInline(
    page: Page,
    plan: SuiteSessionPlan,
    url: string,
    runId: string,
    isHeadless: boolean,
    config: RunConfig | undefined,
    pushRealTimeLog: (msg: string) => void,
  ): Promise<boolean> {
    const started = Date.now();
    const results = await this._executeSteps({
      page,
      steps: plan.loginFlow.steps,
      suiteId: 'SETUP',
      runId,
      url,
      isHeadless,
      config: { ...config, captureScreenshots: false },
      evidencePrefix: `${runId}-SETUP`,
      pushRealTimeLog,
    });

    if (results.some((r) => r.status !== 'passed')) return false;

    const auth = await this._looksAuthenticated(page, LOGIN_CONFIRM_SETTLE_MS);
    if (!auth.ok) return false;

    // Share what this login produced with the suites still to run.
    saveSession({
      key: plan.key,
      createdAt: new Date().toISOString(),
      landingUrl: page.url(),
      storageState: await page.context().storageState(),
      prologueSelectors: results.map((r) => r.resolvedSelector ?? null),
      loginDurationMs: Date.now() - started,
    });

    pushRealTimeLog(`Logged in as setup for this test case — session cached for the remaining ones.`);
    return true;
  }

  /**
   * Builds the step results that stand in for a skipped login. Selectors and
   * screenshots come from the one real login, so reports stay meaningful and the
   * generated Playwright spec still contains a complete, standalone login.
   */
  private _buildReusedLoginResults(
    prologueSteps: ParsedStep[],
    session: CachedSession,
    key: string,
  ): StepExecutionResult[] {
    const primed = this.primedEvidence.get(key);
    const cachedAt = new Date(session.createdAt).toLocaleTimeString();

    return prologueSteps.map((step, idx) => ({
      stepIndex: step.stepIndex,
      step,
      status: 'passed' as const,
      durationMs: 0,
      reusedSession: true,
      resolvedSelector: primed?.[idx]?.resolvedSelector ?? session.prologueSelectors?.[idx] ?? undefined,
      screenshotPath: primed?.[idx]?.screenshotPath,
      logs: [
        `Reused cached login session (established ${cachedAt}) — login UI not replayed for this test case.`,
      ],
    }));
  }

  // -----------------------------------------------------------------------
  // PRIVATE: _executeSuite() — runs one TC in its own isolated browser context
  // -----------------------------------------------------------------------
  private async _executeSuite(
    suite: RunnableSuite,
    url: string,
    runId: string,
    browserEngine: BrowserEngine,
    deviceMode: DeviceMode,
    config?: RunConfig,
    session?: {
      plan?: SuiteSessionPlan;
      captureKey?: string;
      /** Retry path: log in inline instead of restoring the (unusable) cached session. */
      reprime?: boolean;
      /** Set when planning found no session but a login suite might still produce one before this suite's turn comes. */
      hopefulKey?: HopefulSessionKey;
    },
  ): Promise<TestSuiteResult> {
    const suiteStart = Date.now();
    let stepResults: StepExecutionResult[] = [];
    const networkRequests: NetworkRequestRecord[] = [];
    let suiteConsoleLogs: ConsoleMessageRecord[] = [];
    let suiteNetworkErrors: NetworkErrorRecord[] = [];
    let sessionReused = false;
    const requestTimes = new Map<Request, number>();

    const settings = fileHelper.getSettings();
    const videoCaptureSetting = settings.videoCapture ?? 'off';
    const traceCaptureSetting = settings.traceCapture ?? 'retain-on-failure';
    const isHeadless = config?.headless !== undefined ? config.headless : settings.headlessMode;

    const pushRealTimeLog = (msg: string) => {
      const timeStr = new Date().toLocaleTimeString();
      runRegistry.pushLog(runId, `[${timeStr}] [${suite.id}] ${msg}`);
    };

    const deviceConfig = DEVICE_CONFIGS[deviceMode];

    let browser: Browser | undefined;
    let ownsBrowser = false;
    let browserContext: BrowserContext | undefined;
    let page: Page | undefined;
    let tempVideoPath = '';
    let videoPath = '';
    let videoSizeBytes: number | undefined;
    let videoRemote: RemoteArtifact | undefined;
    let tracePath = '';
    let traceSizeBytes: number | undefined;
    let traceRemote: RemoteArtifact | undefined;
    try {
      // One browser process per run by default; this TC gets its own isolated context.
      const acquired = await this._acquireBrowser(runId, browserEngine, isHeadless, config);
      browser = acquired.browser;
      ownsBrowser = acquired.owned;
      pushRealTimeLog(
        ownsBrowser
          ? `LAUNCHING BROWSER ENGINE: ${browserEngine} (${deviceMode} mode)...`
          : `OPENING ISOLATED CONTEXT in the shared ${browserEngine} browser (${deviceMode} mode)...`,
      );

      // If the run was cancelled before/while launching, bail out immediately.
      if (runRegistry.isAborted(runId)) {
        if (ownsBrowser) await closeWithTimeout(browser);
        throw new Error('Execution cancelled by user before browser started.');
      }

      const recordVideoDir = path.join(process.cwd(), 'public', 'videos');
      if (!fs.existsSync(recordVideoDir)) {
        fs.mkdirSync(recordVideoDir, { recursive: true });
      }

      // A planned session seeds this context with the cookies/localStorage from the
      // one real login. The context is still exclusive to this suite — it receives
      // a copy of that state, never a shared live context.
      browserContext = await browser.newContext({
        viewport: deviceConfig.viewport,
        userAgent: deviceConfig.userAgent,
        isMobile: deviceConfig.isMobile ?? false,
        hasTouch: deviceConfig.hasTouch ?? false,
        storageState: session?.plan?.session.storageState,
        recordVideo: videoCaptureSetting !== 'off' ? {
          dir: recordVideoDir,
          size: { width: 1280, height: 720 }
        } : undefined
      });

      page = await browserContext.newPage();

      // Tracing is started on the context, not the page, so anything the test
      // opens in a second tab is recorded too. Sources are included because the
      // generated script is what a reader will want to line up against.
      if (traceCaptureSetting !== 'off') {
        await browserContext.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
          title: `${suite.id} — ${suite.title}`,
        });
      }

      // Installs a fetch/XHR counter used by waitForPageSettle() to detect
      // in-flight API calls (e.g. after a click triggers a CRUD request).
      await installNetworkActivityTracker(page);

      // Listen to all network requests for waterfall diagram
      page.on('request', (req) => {
        requestTimes.set(req, Date.now());
      });
      page.on('response', (res) => {
        const req = res.request();
        const startTime = requestTimes.get(req);
        const durationMs = startTime ? Date.now() - startTime : 0;

        const record: NetworkRequestRecord = {
          url: req.url(),
          method: req.method(),
          status: res.status(),
          contentType: res.headers()['content-type'] || 'text/html',
          durationMs,
          timestamp: new Date().toISOString(),
        };
        networkRequests.push(record);
      });

      // Hook up log listeners
      this.logManager.startListeners(page);

      // ---- Decide which steps actually run in the browser ----
      let stepsToRun = suite.steps;
      let plan = session?.plan;

      // Planning found nothing for this suite when the shared login attempt
      // failed, but a login suite scheduled ahead of it may have logged in on
      // its own since then and cached a session — take one fresh look before
      // accepting "runs logged out" as final. Cheap when there is nothing
      // there (a single cache read), and the difference between correctly
      // passing and failing on a technicality when there is.
      if (!plan && session?.hopefulKey) {
        const settingsForTtl = fileHelper.getSettings();
        const ttlMinutes =
          config?.sessionTtlMinutes ?? settingsForTtl.sessionTtlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;
        const fresh = loadSession(session.hopefulKey.key, ttlMinutes);
        if (fresh) {
          pushRealTimeLog(
            `A login established earlier in this run is now available — restoring it instead of running logged out...`,
          );
          plan = {
            key: session.hopefulKey.key,
            session: fresh,
            skip: [],
            run: suite.steps,
            loginFlow: session.hopefulKey.loginFlow,
          };
        }
      }

      // Retry path for a suite with no login steps of its own: the cached session
      // proved unusable, so log in inside this suite's own context instead of
      // restoring state. The login steps are not added to the test case's results —
      // they are setup, not part of what this TC asserts.
      if (plan && session?.reprime) {
        pushRealTimeLog(`Logging in directly for this test case before retrying...`);
        const loggedIn = await this._loginInline(page, plan, url, runId, isHeadless, config, pushRealTimeLog);
        if (loggedIn) {
          sessionReused = false;
          stepsToRun = plan.run;
          plan = undefined; // already authenticated; no cached state to restore
        } else {
          plan = undefined;
          pushRealTimeLog(`Direct login failed — this test case runs logged out.`);
        }
      }

      // A login-less test case that opens by navigating somewhere would otherwise
      // load the application twice: once to prove the restored session works, and
      // again as its own first step. On a heavy dashboard that is several seconds
      // of pure duplication per test case. Let the test's own navigation serve
      // both purposes — the session is verified just as strictly, only on the page
      // the test actually cares about instead of a throwaway one.
      const deferAuthToFirstStep =
        !!plan && plan.skip.length === 0 && isNavigationStep(stepsToRun[0]);

      if (plan && !deferAuthToFirstStep) {
        pushRealTimeLog(
          plan.skip.length > 0
            ? `Restoring cached login session — skipping ${plan.skip.length} login step(s)...`
            : `Restoring cached login session — this test case starts already logged in...`,
        );
        await page
          .goto(plan.session.landingUrl, { waitUntil: NAV_WAIT_UNTIL, timeout: UNIVERSAL_TIMEOUT_MS })
          .catch(() => {});

        const auth = await this._looksAuthenticated(page);
        if (auth.ok) {
          sessionReused = true;
          stepResults = this._buildReusedLoginResults(plan.skip, plan.session, plan.key);
          stepsToRun = plan.run;
          pushRealTimeLog(`Cached session accepted — resumed at ${page.url()}`);
        } else if (plan.skip.length > 0) {
          // Stale/revoked session on a suite that knows how to log in: drop the
          // cache and log in for real so the run stays correct. Cost is one login,
          // never a wrong result. The restored state is wiped first so the fallback
          // login starts genuinely clean.
          invalidateSession(plan.key);
          await browserContext.clearCookies().catch(() => {});
          await page
            .evaluate(() => {
              localStorage.clear();
              sessionStorage.clear();
            })
            .catch(() => {});
          pushRealTimeLog(`Cached session rejected (${auth.reason}) — performing a real login instead.`);
        } else {
          // The suite has no login steps of its own, so it cannot recover by
          // replaying them: log in inline (as setup) and carry on from there.
          invalidateSession(plan.key);
          pushRealTimeLog(`Cached session rejected (${auth.reason}) — logging in directly for this test case.`);
          const loggedIn = await this._loginInline(page, plan, url, runId, isHeadless, config, pushRealTimeLog);
          if (!loggedIn) pushRealTimeLog(`Could not establish a session — this test case runs logged out.`);
        }
      }

      const activePage = page;
      const runSteps = (steps: ParsedStep[]) =>
        this._executeSteps({
          page: activePage,
          steps,
          suiteId: suite.id,
          runId,
          url,
          isHeadless,
          config,
          evidencePrefix: `${runId}-${suite.id}`,
          pushRealTimeLog,
        });

      let executed: StepExecutionResult[];

      if (plan && deferAuthToFirstStep) {
        pushRealTimeLog(
          `Restoring cached login session — this test case starts already logged in ` +
            `(the session is verified on its own first navigation).`,
        );

        const opening = await runSteps([stepsToRun[0]]);
        executed = [...opening];

        if (opening.every((r) => r.status === 'passed')) {
          const auth = await this._looksAuthenticated(page);
          if (auth.ok) {
            sessionReused = true;
            pushRealTimeLog(`Cached session accepted — resumed at ${page.url()}`);
          } else {
            // Same recovery as the eager path: the cache is dead, so log in for
            // real. The opening step is then replayed, so what the report shows
            // for it is the authenticated page the rest of the test case runs on.
            invalidateSession(plan.key);
            pushRealTimeLog(`Cached session rejected (${auth.reason}) — logging in directly for this test case.`);
            const loggedIn = await this._loginInline(page, plan, url, runId, isHeadless, config, pushRealTimeLog);
            if (loggedIn) {
              executed = await runSteps([stepsToRun[0]]);
            } else {
              pushRealTimeLog(`Could not establish a session — this test case runs logged out.`);
            }
          }
        }

        // A failed opening step means the rest never ran — record them as skipped
        // rather than executing them against a page that never arrived.
        const remaining = stepsToRun.slice(1);
        executed = [
          ...executed,
          ...(executed.some((r) => r.status === 'failed')
            ? remaining.map((step) => ({
                stepIndex: step.stepIndex,
                step,
                status: 'skipped' as const,
                durationMs: 0,
                logs: [`Skipping step: ${step.rawText}`],
              }))
            : await runSteps(remaining)),
        ];
      } else {
        executed = await runSteps(stepsToRun);
      }

      stepResults = [...stepResults, ...executed];

      // Cache this suite's authenticated state for later runs (single-suite login
      // flows, or a fallback login after a rejected cache).
      const captureKey = session?.captureKey ?? (sessionReused ? undefined : plan?.key);
      if (captureKey && !stepResults.some((r) => r.status === 'failed')) {
        const prologue = detectLoginPrologue(suite.steps);
        if (prologue) {
          const auth = await this._looksAuthenticated(page);
          if (auth.ok) {
            saveSession({
              key: captureKey,
              createdAt: new Date().toISOString(),
              landingUrl: page.url(),
              storageState: await browserContext.storageState(),
              prologueSelectors: stepResults
                .slice(0, prologue.length)
                .map((r) => r.resolvedSelector ?? null),
              loginDurationMs: stepResults
                .slice(0, prologue.length)
                .reduce((sum, r) => sum + r.durationMs, 0),
            });
            pushRealTimeLog(`Cached this login session for reuse by later test cases.`);
          }
        }
      }

      // Collect console/network telemetry for this suite (drives bug evidence + RCA).
      const logsPayload = this.logManager.collect(page);
      suiteConsoleLogs = logsPayload.consoleLogs;
      suiteNetworkErrors = logsPayload.networkErrors;
    } catch (fatalErr: any) {
      logger.error(`[${suite.id}] Fatal browser error`, fatalErr);
      // Mark all remaining steps as failed
      for (const step of suite.steps) {
        if (!stepResults.find((r) => r.stepIndex === step.stepIndex)) {
          stepResults.push({
            stepIndex: step.stepIndex,
            step,
            status: 'failed',
            durationMs: 0,
            error: `Browser launch/context error: ${fatalErr?.message}`,
            logs: [`FATAL: ${fatalErr?.message}`],
          });
        }
      }
    } finally {
      if (page) {
        try {
          const video = page.video();
          if (video) {
            tempVideoPath = await video.path().catch(() => '');
          }
        } catch (err) {
          logger.error(`[${suite.id}] Could not resolve video path`, err);
        }
      }
      if (!isHeadless && page) {
        pushRealTimeLog(`Headed mode: pausing for 5 seconds before closing this test case's window...`);
        await page.waitForTimeout(5000).catch(() => {});
      }
      // Stop tracing before the context closes — after it, the trace is gone.
      if (browserContext && traceCaptureSetting !== 'off') {
        try {
          const traceFailed = stepResults.some((r) => r.status === 'failed');

          if (traceCaptureSetting === 'retain-on-failure' && !traceFailed) {
            // Stopping without a path discards the recording rather than paying
            // to write a few megabytes nobody will open.
            await browserContext.tracing.stop();
          } else {
            const traceDir = path.join(process.cwd(), 'public', 'traces');
            if (!fs.existsSync(traceDir)) {
              fs.mkdirSync(traceDir, { recursive: true });
            }

            const traceFileName = `run-${runId}-${suite.id}.zip`;
            const traceFilePath = path.join(traceDir, traceFileName);
            await browserContext.tracing.stop({ path: traceFilePath });

            tracePath = `/traces/${traceFileName}`;
            traceSizeBytes = fs.statSync(traceFilePath).size;
            pushRealTimeLog(`Trace saved: ${tracePath}`);

            // The hosted Trace Viewer fetches the archive over HTTP, so a trace
            // that only exists on this machine cannot be opened from anywhere
            // else. Uploading it is what makes the report's link work.
            const uploaded = await uploadFile(traceFilePath, {
              folder: `traces/run-${runId}`,
              resourceType: 'raw',
              publicId: `${suite.id}.zip`,
            });
            if (uploaded) {
              traceRemote = {
                url: uploaded.secureUrl,
                publicId: uploaded.publicId,
                sizeBytes: uploaded.bytes,
              };
              tracePath = uploaded.secureUrl;
              pushRealTimeLog(`Trace uploaded to Cloudinary: ${uploaded.secureUrl}`);
            }
          }
        } catch (traceErr) {
          logger.error(`[${suite.id}] Failed to finalise trace`, traceErr);
        }
      }

      // Close this suite's context. The browser process itself is closed once at the
      // end of the run when it is shared across test cases.
      if (browserContext) await closeWithTimeout(browserContext);
      if (browser && ownsBrowser) await closeWithTimeout(browser);
      if (tempVideoPath && fs.existsSync(tempVideoPath)) {
        try {
          const finalFileName = `run-${runId}-${suite.id}.webm`;
          const finalVideoPath = path.join(process.cwd(), 'public', 'videos', finalFileName);

          const failed = stepResults.some((r) => r.status === 'failed');
          if (videoCaptureSetting === 'retain-on-failure' && !failed) {
            fs.unlinkSync(tempVideoPath);
          } else {
            // Copy file to final path
            fs.renameSync(tempVideoPath, finalVideoPath);
            videoPath = `/videos/${finalFileName}`;
            videoSizeBytes = fs.statSync(finalVideoPath).size;
            pushRealTimeLog(`Video session recording saved: ${videoPath}`);

            // Push the recording to Cloudinary so the report stays watchable
            // from anywhere. The local copy is kept either way — a failed
            // upload must not cost the run its only recording.
            const uploaded = await uploadFile(finalVideoPath, {
              folder: `videos/run-${runId}`,
              resourceType: 'video',
              publicId: suite.id,
            });
            if (uploaded) {
              videoRemote = {
                url: uploaded.secureUrl,
                publicId: uploaded.publicId,
                sizeBytes: uploaded.bytes,
              };
              videoPath = uploaded.secureUrl;
              pushRealTimeLog(`Video uploaded to Cloudinary: ${uploaded.secureUrl}`);
            }
          }
        } catch (videoErr) {
          logger.error('Failed to process video recording', videoErr);
        }
      }
    }

    const failed = stepResults.some((r) => r.status === 'failed');

    return {
      tcId: suite.id,
      title: suite.title,
      status: failed ? 'failed' : 'passed',
      durationMs: Date.now() - suiteStart,
      stepResults,
      videoPath: videoPath || undefined,
      videoSizeBytes,
      videoRemote,
      tracePath: tracePath || undefined,
      traceSizeBytes,
      traceRemote,
      networkRequests,
      consoleLogs: suiteConsoleLogs,
      networkErrors: suiteNetworkErrors,
      sessionReused,
    };
  }

  // -----------------------------------------------------------------------
  // PRIVATE: _executeSteps() — the step engine, shared by suite execution and
  // session priming so both walk the UI through exactly the same code path.
  // -----------------------------------------------------------------------
  private async _executeSteps(params: {
    page: Page;
    steps: ParsedStep[];
    suiteId: string;
    runId: string;
    url: string;
    isHeadless: boolean;
    config?: RunConfig;
    /** Prefix for screenshot / DOM-snapshot filenames. */
    evidencePrefix: string;
    pushRealTimeLog: (msg: string) => void;
  }): Promise<StepExecutionResult[]> {
    const { page, steps, suiteId, runId, url, isHeadless, config, evidencePrefix, pushRealTimeLog } =
      params;

    const stepResults: StepExecutionResult[] = [];
    let suiteFailed = false;

    // The Settings page has always offered "capture only on failures", but the
    // runner screenshotted every step regardless. On a long page each capture is
    // seconds of scrolling and stitching, so the setting was both ignored and
    // expensive. Honour it.
    const screenshotPolicy = resolveScreenshotPolicy(config, fileHelper.getSettings());

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepIndex = step.stepIndex;
      const stepStartTime = Date.now();
      const stepLogs: string[] = [];

      const originalPush = stepLogs.push;
      stepLogs.push = function (...items: string[]) {
        items.forEach(item => pushRealTimeLog(item));
        return originalPush.apply(this, items);
      };

      // Check for abort signal from user
      if (runRegistry.isAborted(runId)) {
        suiteFailed = true;
        pushRealTimeLog(`EXECUTION ABORTED BY USER SIGNAL`);
        stepLogs.push(`Aborted: execution cancelled by user`);
        stepResults.push({
          stepIndex,
          step,
          status: 'skipped',
          durationMs: 0,
          logs: stepLogs,
        });
        continue;
      }

      if (suiteFailed) {
        logger.info(`[${suiteId}] Step ${stepIndex} skipped due to prior failure`);
        stepLogs.push(`Skipping step: ${step.rawText}`);
        stepResults.push({
          stepIndex,
          step,
          status: 'skipped',
          durationMs: 0,
          logs: stepLogs,
        });
        continue;
      }

      logger.info(`[${suiteId}] Step ${stepIndex}: ${step.rawText}`);
      stepLogs.push(`Starting step: ${step.rawText}`);

      const result: StepExecutionResult = {
        stepIndex,
        step,
        status: 'passed',
        durationMs: 0,
        logs: stepLogs,
        // Overwritten only if the step escalates to the agent.
        executedBy: 'deterministic',
      };

      try {
        // Resolve {{var}} test-data references at execution time.
        // Logs, reports and generated scripts keep the raw template so secrets never leak into artifacts.
        let stepValue = step.value;
        if (stepValue && stepValue.includes('{{')) {
          const sub = substituteVariables(stepValue);
          if (sub.missing.length > 0) {
            throw new Error(`Unresolved test-data variable(s): ${sub.missing.join(', ')}`);
          }
          stepValue = sub.text;
          stepLogs.push(`Resolved test-data variables from environment`);
        }

        if (step.type === 'unparsed') {
          // Parser could not understand this step — fail clearly instead of guessing.
          throw new Error(step.parseWarning || `Step could not be parsed: "${step.rawText}"`);
        } else if (step.type === 'action') {
          switch (step.action) {
            case 'navigate': {
              let targetUrl = stepValue || url;
              if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                targetUrl = url.startsWith('http') ? url : 'https://' + targetUrl;
              }
              stepLogs.push(`Navigating to: "${targetUrl}"`);
              await navigateTo(page, targetUrl, (note) => stepLogs.push(note));

              // Arriving is not the same as being ready: a client-rendered app has
              // painted nothing yet, so the next step could scan an empty DOM.
              // Settle on network/DOM/spinner activity the same way a click does —
              // which also covers everything waiting for 'load' would have.
              const navSettle = await waitForPageSettle(page);
              stepLogs.push(`${navSettle.reason} (${navSettle.waitedMs}ms)`);
              break;
            }

            case 'wait': {
              const waitMs = step.waitMs || 1000;
              stepLogs.push(`Waiting ${waitMs}ms`);
              await page.waitForTimeout(waitMs);
              break;
            }

            case 'fill': {
              if (step.targetField === 'credentials') {
                const isValid = step.value === 'valid';
                // Credentials come from .env (QA_VALID_* / QA_INVALID_*) — never hardcoded.
                const { username: userVal, password: passVal } = getCredentials(
                  isValid ? 'valid' : 'invalid',
                );

                stepLogs.push(`Scanning DOM for credential fields`);

                let userMatch;
                try {
                  userMatch = await this.discovery.discover(page, 'username');
                } catch {
                  userMatch = await this.discovery.discover(page, 'email');
                }
                const passMatch = await this.discovery.discover(page, 'password');

                stepLogs.push(`Resolved: username=[${userMatch.selector}], password=[${passMatch.selector}]`);

                result.resolvedSelector = `${userMatch.selector} & ${passMatch.selector}`;
                if (!isHeadless) {
                  await page.locator(userMatch.selector).first().pressSequentially(userVal, { delay: 100 });
                  await page.locator(passMatch.selector).first().pressSequentially(passVal, { delay: 100 });
                } else {
                  await page.locator(userMatch.selector).first().fill(userVal);
                  await page.locator(passMatch.selector).first().fill(passVal);
                }
                break;
              }

              stepLogs.push(`Scanning DOM for input: "${step.targetField}"`);
              const match = await this.discovery.discover(page, step.targetField);
              stepLogs.push(`Resolved: "${match.selector}" (${match.score}%)`);
              result.resolvedSelector = match.selector;

              // The step named a field but no value. Ask the resolved element
              // what it wants before inventing one — an email input rejects a
              // plain label client-side, and that failure would read as an
              // application defect rather than as invented test data. Skipped
              // for anything that is not a text entry: a dropdown or checkbox
              // has its own valid values and _interact() picks from those.
              if (step.autoValue) {
                const el = page.locator(match.selector).first();
                const shape = await el
                  .evaluate((node) => ({
                    tag: node.tagName.toLowerCase(),
                    type: (node.getAttribute('type') || '').toLowerCase(),
                    role: (node.getAttribute('role') || '').toLowerCase(),
                    placeholder: node.getAttribute('placeholder') || '',
                  }))
                  .catch(() => null);

                const takesTypedText =
                  !shape ||
                  shape.tag === 'textarea' ||
                  shape.role === 'textbox' ||
                  (shape.tag === 'input' &&
                    !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image'].includes(shape.type));

                if (takesTypedText) {
                  stepValue = generateAutoValue({
                    fieldName: step.targetField,
                    inputType: shape?.type || match.attributes?.type || undefined,
                    placeholder: shape?.placeholder || match.attributes?.placeholder || undefined,
                  });
                  result.autoSuppliedValue = stepValue;
                  stepLogs.push(
                    `No value was given for "${step.targetField}" — auto-supplied "${stepValue}" ` +
                      `(add \`as "your value"\` to the step to control it).`,
                  );
                }
              }

              // The element decides the interaction, not the verb in the step.
              const outcome = await this._interact(page, match, step, stepValue, (m) => stepLogs.push(m));
              if (outcome.usedValue !== undefined && step.autoValue) {
                result.autoSuppliedValue = outcome.usedValue;
              }
              stepLogs.push(
                `${outcome.performed === 'fill' ? 'Filled' : 'Set'} «${step.targetField}»` +
                  (outcome.usedValue !== undefined ? ` to "${outcome.usedValue}"` : ''),
              );

              // Some fields trigger async validation/autocomplete calls on change —
              // settle before the next step reads the DOM.
              const fillSettle = await waitForPageSettle(page, { timeoutMs: 3_000 });
              if (fillSettle.settled && fillSettle.waitedMs > 300) {
                stepLogs.push(`${fillSettle.reason} (${fillSettle.waitedMs}ms)`);
              }
              break;
            }

            case 'click': {
              stepLogs.push(`Scanning DOM for clickable: "${step.targetField}"`);
              const match = await this.discovery.discover(page, step.targetField);
              stepLogs.push(`Resolved: "${match.selector}" (${match.score}%)`);
              result.resolvedSelector = match.selector;

              await page.locator(match.selector).first().click({ timeout: 15_000 });
              stepLogs.push(`Clicked element`);

              // Post-click: a click may navigate (server-side redirect), may route
              // client-side, or may do neither and just fire an API call. Wait for
              // the document to be parsed if a navigation did start — but only
              // that, not its images and fonts, which no assertion depends on.
              stepLogs.push(`Waiting for page to settle after click...`);
              try {
                await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
                stepLogs.push(`Document ready.`);
              } catch {
                stepLogs.push(`Document-ready wait timed out — continuing (SPA navigation expected).`);
              }

              // Smart settle: a click often triggers an API call (create/update/
              // delete) without a full navigation — poll network, DOM and loading
              // indicators instead of a fixed sleep, so fast operations don't pay a
              // needless delay and slow ones aren't cut short.
              const clickSettle = await waitForPageSettle(page);
              stepLogs.push(`${clickSettle.reason} (${clickSettle.waitedMs}ms)`);

              stepLogs.push(`Post-click URL: ${page.url()}`);
              break;
            }

            case 'select': {
              stepLogs.push(`Scanning DOM for dropdown: "${step.targetField}"`);
              const match = await this.discovery.discover(page, step.targetField);
              result.resolvedSelector = match.selector;

              // Native <select>, custom div-based dropdown, or something that
              // turned out not to be a dropdown at all — _interact() decides
              // from the element and picks an option when none was named.
              const outcome = await this._interact(page, match, step, stepValue, (m) => stepLogs.push(m));
              if (outcome.usedValue !== undefined) {
                if (step.autoValue) result.autoSuppliedValue = outcome.usedValue;
                stepLogs.push(`Selected option: "${outcome.usedValue}"`);
              }

              const selectSettle = await waitForPageSettle(page, { timeoutMs: 4_000 });
              if (selectSettle.settled && selectSettle.waitedMs > 300) {
                stepLogs.push(`${selectSettle.reason} (${selectSettle.waitedMs}ms)`);
              }
              break;
            }

            case 'check':
            case 'uncheck': {
              stepLogs.push(`Scanning DOM for "${step.targetField}"`);
              const match = await this.discovery.discover(page, step.targetField);
              result.resolvedSelector = match.selector;
              const outcome = await this._interact(page, match, step, stepValue, (m) => stepLogs.push(m));
              stepLogs.push(`Performed ${outcome.performed} on «${step.targetField}»`);
              await waitForPageSettle(page, { timeoutMs: 3_000 });
              break;
            }

            case 'waitUntil': {
              const mode = step.waitMode || 'visible';
              stepLogs.push(`Waiting until "${step.targetField}" is ${mode === 'visible' ? 'visible' : 'gone'}...`);
              const { reached, waitedMs } = await waitUntilCondition(page, step.targetField, mode, step.waitMs || 20_000);
              if (reached) {
                stepLogs.push(`Condition reached after ${waitedMs}ms — continuing.`);
              } else {
                // Soft wait: never fails the suite. If the UI is just slower than
                // expected, the next assertion step is what actually judges success.
                stepLogs.push(`Condition not reached after ${waitedMs}ms — continuing anyway (soft wait, not a failure).`);
              }
              break;
            }

            default:
              throw new Error(`Unsupported action: "${step.action}"`);
          }
        } else if (step.type === 'validation') {
          stepLogs.push(`Running validation: [${step.validation}] target="${step.targetField}" value="${step.value}"`);

          // Resolve cached locator selector if available
          if (
            step.targetField &&
            step.targetField !== 'url' &&
            step.targetField !== 'success_message' &&
            step.targetField !== 'error_message' &&
            step.targetField !== 'body'
          ) {
            // no-op: validator handles live DOM lookups internally
          }

          const valResult = await this.validator.validate(page, { ...step, value: stepValue });
          if (!valResult.success) {
            throw new Error(valResult.error || 'Assertion check failed.');
          }
          if (valResult.note) {
            // A pass on something looser than a literal comparison is recorded on
            // the step, so the report shows what was accepted and why.
            result.assertionNote = valResult.note;
            stepLogs.push(`Validation passed (not a literal match): ${valResult.note}`);
          } else {
            stepLogs.push(`Validation passed.`);
          }
        }

        // Capture success screenshot
        if (screenshotPolicy === 'all') {
          const shot = await this.screenshotManager
            .captureDetailed(page, evidencePrefix, stepIndex)
            .catch(() => null);
          if (shot) {
            result.screenshotPath = shot.url;
            result.screenshotSizeBytes = shot.sizeBytes;
            result.screenshotRemote = shot.remote;
            stepLogs.push(`Screenshot saved: ${shot.url}`);
          }
        }
      } catch (stepErr: any) {
        const deterministicError = stepErr?.message || 'Error during browser interaction.';

        // ---- Hybrid handoff (A1.4) ----
        // Every reason the deterministic engine can fail a step arrives here: an
        // unparsed step, a locator discovery could not resolve, or an action that
        // did not work. Rather than three separate triggers, the agent is offered
        // the step at the one point they all reach.
        const escalated = await this.escalator?.escalate({
          page,
          step,
          stepIndex,
          deterministicError,
          testCaseTitle: suiteId,
          totalSteps: steps.length,
          previousSteps: stepResults
            .filter((r) => r.status !== 'skipped')
            .map((r) => ({ text: r.step.rawText, status: r.status as 'passed' | 'failed' })),
          log: (m) => stepLogs.push(m),
        });

        if (escalated) {
          result.executedBy = 'ai';
          result.aiHandoffReason = deterministicError;
          result.aiReasoning = escalated.reasoning;
          result.aiExpected = escalated.expected;
          result.aiActual = escalated.actual;
        }

        if (escalated?.status === 'passed') {
          // The agent carried out what the deterministic engine could not. The
          // step passed; the handoff reason stays on the result so a step that
          // needs AI on every run is visible rather than silently absorbed.
          result.status = 'passed';
          logger.info(`[${suiteId}] Step ${stepIndex} recovered by AI`);

          if (screenshotPolicy === 'all') {
            const shot = await this.screenshotManager
              .captureDetailed(page, evidencePrefix, stepIndex)
              .catch(() => null);
            if (shot) {
              result.screenshotPath = shot.url;
              result.screenshotSizeBytes = shot.sizeBytes;
              result.screenshotRemote = shot.remote;
              stepLogs.push(`Screenshot saved: ${shot.url}`);
            }
          }

          result.durationMs = Date.now() - stepStartTime;
          stepResults.push(result);
          continue;
        }

        logger.error(`[${suiteId}] Step ${stepIndex} failed`, stepErr);
        result.status = 'failed';
        // When the agent also failed, its reasoning is the more useful message:
        // it says what was on the page, not merely which selector missed.
        result.error = escalated ? `${escalated.reasoning} (deterministic: ${deterministicError})` : deterministicError;
        stepLogs.push(`ERROR: ${result.error}`);
        suiteFailed = true;

        // ---- Failure-context capture (Phase 4.1): screenshot + URL + DOM ----
        result.pageUrl = await Promise.resolve(page.url()).catch(() => undefined);

        // A failure is the one place the whole scrollable page is worth the cost —
        // the cause is often below the fold. Captured even under 'on-failure'.
        if (screenshotPolicy !== 'off') {
          const errShot = await this.screenshotManager
            .captureDetailed(page, evidencePrefix, stepIndex, { fullPage: true })
            .catch(() => null);
          if (errShot) {
            result.screenshotPath = errShot.url;
            result.screenshotSizeBytes = errShot.sizeBytes;
            result.screenshotRemote = errShot.remote;
          }
        }

        const domPath = await this.domSnapshotManager
          .capture(page, evidencePrefix, stepIndex)
          .catch(() => undefined);
        if (domPath) {
          result.domSnapshotPath = domPath;
          stepLogs.push(`DOM snapshot saved: ${domPath}`);
        }
      }

      result.durationMs = Date.now() - stepStartTime;
      stepResults.push(result);
    }

    return stepResults;
  }
}
