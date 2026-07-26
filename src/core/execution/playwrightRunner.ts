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
} from '@/types/execution';
import { ParsedStep } from '@/types/testCase';
import { BrowserEngine, DeviceMode } from '@/types/mvp';
import { TestCaseParser } from '../parser/testCaseParser';
import { ElementDiscoveryEngine } from '../discovery/elementDiscovery';
import { Validator } from '../validation/validator';
import { ScreenshotManager } from '../evidence/screenshotManager';
import { DomSnapshotManager } from '../evidence/domSnapshotManager';
import { LogManager } from '../evidence/logManager';
import { ReportGenerator } from '../reporting/reportGenerator';
import { PlaywrightGenerator } from '../generator/playwrightGenerator';
import { ScriptVerifier } from './scriptVerifier';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileHelper } from '@/utils/fileHelper';
import { getCredentials, substituteVariables } from '@/utils/testData';
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
import { LoginPrologue, containsLogout, detectLoginPrologue, hasLoginSteps } from './loginFlow';
import type { Browser, BrowserContext, Page, Request } from '@playwright/test';

// Universal 30-second timeout applied to all network-dependent operations.
const UNIVERSAL_TIMEOUT_MS = 30_000;

/**
 * How many suites may be re-run with a real login after failing on a reused
 * session. Bounded so a genuinely broken app cannot double a long run's cost.
 */
const REUSE_RETRY_BUDGET = 3;

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

    // Register this run (preserving an abort that arrived before start) + seed live logs.
    const preAborted = runRegistry.get(runId)?.aborted === true;
    const activeRun = runRegistry.start(runId);
    activeRun.aborted = preAborted;

    runRegistry.initLogs(runId, [
      `[${new Date().toLocaleTimeString()}] [SYSTEM] Run ${runId} started (node ${process.version})`,
      `[${new Date().toLocaleTimeString()}] [SYSTEM] Suites: ${suites.length} | Browser: ${browser} | Device: ${deviceMode} | Workers: ${maxWorkers}`,
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
    const { plans, captureKeys, summary } = await this._planSessionReuse(
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
    const indexed: { result: TestSuiteResult; index: number }[] = [];
    let reuseRetriesLeft = REUSE_RETRY_BUDGET;

    try {
      for (let i = 0; i < ordered.length; i += maxWorkers) {
        const batch = ordered.slice(i, i + maxWorkers);

        const batchResults = await Promise.all(
          batch.map(async ({ suite, index }) => {
            let result = await this._executeSuite(suite, url, runId, browser, deviceMode, config, {
              plan: plans.get(suite.id),
              captureKey: captureKeys.get(suite.id),
            });

            // Self-healing: a suite that started from a cached session and failed
            // is re-run once with a real login. Reuse then never turns into a false
            // failure — an assertion on a post-login flash message, say — while
            // costing nothing for the suites that pass.
            if (result.sessionReused && result.status === 'failed' && reuseRetriesLeft > 0) {
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

    runRegistry.finish(runId);

    return context;
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
    summary: SessionReuseSummary & { perLoginMs: number };
  }> {
    const settings = fileHelper.getSettings();
    const enabled = config?.reuseSession ?? settings.reuseSession ?? true;
    const ttlMinutes =
      config?.sessionTtlMinutes ?? settings.sessionTtlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;

    const plans = new Map<string, SuiteSessionPlan>();
    const captureKeys = new Map<string, string>();
    const summary = {
      enabled,
      primedLogins: 0,
      reusedSuites: 0,
      freshLoginSuites: 0,
      estimatedSavedMs: 0,
      perLoginMs: 0,
    };

    if (!enabled) return { plans, captureKeys, summary };

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
      return { plans, captureKeys, summary };
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
        // stays pending so the next flow can pick it up.
        group.suiteIds.forEach((id) => captureKeys.set(id, key));
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

    return { plans, captureKeys, summary };
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

      const auth = await this._looksAuthenticated(page);
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
      if (browserContext) await browserContext.close().catch(() => {});
    }
  }

  /** Step evidence from the priming login, keyed by session key (in-process only). */
  private primedEvidence = new Map<string, StepExecutionResult[]>();

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
    if (browser) await browser.close().catch(() => {});
  }

  /**
   * Confirms a page is in an authenticated state — used both after the priming
   * login and after restoring a cached session, so a stale or revoked session
   * can never be silently reused.
   */
  private async _looksAuthenticated(page: Page): Promise<{ ok: boolean; reason: string }> {
    try {
      await waitForPageSettle(page, { timeoutMs: 5_000 });

      // A visible password field means we are looking at a login form.
      const passwordVisible = await page
        .locator('input[type="password"]')
        .first()
        .isVisible({ timeout: 1_500 })
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

    const auth = await this._looksAuthenticated(page);
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
        if (ownsBrowser) await browser.close().catch(() => {});
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

      if (plan) {
        pushRealTimeLog(
          plan.skip.length > 0
            ? `Restoring cached login session — skipping ${plan.skip.length} login step(s)...`
            : `Restoring cached login session — this test case starts already logged in...`,
        );
        await page
          .goto(plan.session.landingUrl, { waitUntil: 'load', timeout: UNIVERSAL_TIMEOUT_MS })
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

      const executed = await this._executeSteps({
        page,
        steps: stepsToRun,
        suiteId: suite.id,
        runId,
        url,
        isHeadless,
        config,
        evidencePrefix: `${runId}-${suite.id}`,
        pushRealTimeLog,
      });
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
      // Close this suite's context. The browser process itself is closed once at the
      // end of the run when it is shared across test cases.
      if (browserContext) await browserContext.close().catch(() => {});
      if (browser && ownsBrowser) await browser.close().catch(() => {});
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
            pushRealTimeLog(`Video session recording saved: ${videoPath}`);
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
              await page.goto(targetUrl, { waitUntil: 'load', timeout: 30_000 });

              // 'load' fires before a client-rendered app has painted its form, so
              // the next step could scan an empty DOM. Settle on network/spinner
              // activity the same way a click does.
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
              if (!isHeadless) {
                await page.locator(match.selector).first().pressSequentially(stepValue || '', { delay: 100 });
              } else {
                await page.locator(match.selector).first().fill(stepValue || '');
              }
              stepLogs.push(`Filled "${step.value}" into element`);

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

              // Post-click: wait for page/DOM load.
              // For traditional server-side apps this catches the full page load.
              // For SPAs (client-side routing via pushState), we extend the wait.
              stepLogs.push(`Waiting for page to settle after click...`);
              try {
                // Allow up to 10s for a full load (handles server-side redirects + slow SPAs)
                await page.waitForLoadState('load', { timeout: 10_000 });
                stepLogs.push(`Page load complete.`);
              } catch {
                stepLogs.push(`Load event timed out — continuing (SPA navigation expected).`);
              }

              // Smart settle: a click often triggers an API call (create/update/
              // delete) without a full navigation — poll network activity and
              // loading indicators instead of a fixed sleep, so fast operations
              // don't pay a needless delay and slow ones aren't cut short.
              const clickSettle = await waitForPageSettle(page);
              stepLogs.push(`${clickSettle.reason} (${clickSettle.waitedMs}ms)`);

              stepLogs.push(`Post-click URL: ${page.url()}`);
              break;
            }

            case 'select': {
              stepLogs.push(`Scanning DOM for dropdown: "${step.targetField}"`);
              const match = await this.discovery.discover(page, step.targetField);
              result.resolvedSelector = match.selector;
              await page.locator(match.selector).first().selectOption(stepValue || '');
              stepLogs.push(`Selected option: "${step.value}"`);
              const selectSettle = await waitForPageSettle(page, { timeoutMs: 4_000 });
              if (selectSettle.settled && selectSettle.waitedMs > 300) {
                stepLogs.push(`${selectSettle.reason} (${selectSettle.waitedMs}ms)`);
              }
              break;
            }

            case 'check': {
              stepLogs.push(`Scanning DOM for checkbox: "${step.targetField}"`);
              const match = await this.discovery.discover(page, step.targetField);
              result.resolvedSelector = match.selector;
              await page.locator(match.selector).first().check();
              stepLogs.push(`Checked checkbox`);
              await waitForPageSettle(page, { timeoutMs: 3_000 });
              break;
            }

            case 'uncheck': {
              stepLogs.push(`Scanning DOM for checkbox: "${step.targetField}"`);
              const match = await this.discovery.discover(page, step.targetField);
              result.resolvedSelector = match.selector;
              await page.locator(match.selector).first().uncheck();
              stepLogs.push(`Unchecked checkbox`);
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
          stepLogs.push(`Validation passed.`);
        }

        // Capture success screenshot
        if (config?.captureScreenshots !== false) {
          const screenshotUrl = await this.screenshotManager
            .capture(page, evidencePrefix, stepIndex)
            .catch(() => undefined);
          if (screenshotUrl) {
            result.screenshotPath = screenshotUrl;
            stepLogs.push(`Screenshot saved: ${screenshotUrl}`);
          }
        }
      } catch (stepErr: any) {
        logger.error(`[${suiteId}] Step ${stepIndex} failed`, stepErr);
        result.status = 'failed';
        result.error = stepErr?.message || 'Error during browser interaction.';
        stepLogs.push(`ERROR: ${result.error}`);
        suiteFailed = true;

        // ---- Failure-context capture (Phase 4.1): screenshot + URL + DOM ----
        result.pageUrl = await Promise.resolve(page.url()).catch(() => undefined);

        if (config?.captureScreenshots !== false) {
          const errShot = await this.screenshotManager
            .capture(page, evidencePrefix, stepIndex)
            .catch(() => undefined);
          if (errShot) result.screenshotPath = errShot;
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
