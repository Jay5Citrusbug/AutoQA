import { chromium, firefox, webkit, devices, BrowserType } from '@playwright/test';
import {
  ExecutionContext,
  StepExecutionResult,
  LocatorMap,
  TestSuiteResult,
  NetworkRequestRecord,
  ConsoleMessageRecord,
  NetworkErrorRecord,
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
import type { Browser, BrowserContext, Page, Request } from '@playwright/test';

// Universal 30-second timeout applied to all network-dependent operations.
const UNIVERSAL_TIMEOUT_MS = 30_000;

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
    suites: { id: string; title: string; steps: ParsedStep[] }[],
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
    suites: { id: string; title: string; steps: ParsedStep[] }[],
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

    // ---- Run suites in batches controlled by maxWorkers ----
    const suiteResults: TestSuiteResult[] = [];

    for (let i = 0; i < suites.length; i += maxWorkers) {
      const batch = suites.slice(i, i + maxWorkers);

      const batchResults = await Promise.all(
        batch.map((suite) =>
          this._executeSuite(suite, url, runId, browser, deviceMode, config),
        ),
      );

      suiteResults.push(...batchResults);
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
  // PRIVATE: _executeSuite() — runs one TC in its own browser instance
  // -----------------------------------------------------------------------
  private async _executeSuite(
    suite: { id: string; title: string; steps: ParsedStep[] },
    url: string,
    runId: string,
    browserEngine: BrowserEngine,
    deviceMode: DeviceMode,
    config?: RunConfig,
  ): Promise<TestSuiteResult> {
    const suiteStart = Date.now();
    const stepResults: StepExecutionResult[] = [];
    const networkRequests: NetworkRequestRecord[] = [];
    let suiteConsoleLogs: ConsoleMessageRecord[] = [];
    let suiteNetworkErrors: NetworkErrorRecord[] = [];
    const requestTimes = new Map<Request, number>();

    const settings = fileHelper.getSettings();
    const videoCaptureSetting = settings.videoCapture ?? 'off';
    const isHeadless = config?.headless !== undefined ? config.headless : settings.headlessMode;

    const pushRealTimeLog = (msg: string) => {
      const timeStr = new Date().toLocaleTimeString();
      runRegistry.pushLog(runId, `[${timeStr}] [${suite.id}] ${msg}`);
    };

    pushRealTimeLog(`LAUNCHING BROWSER ENGINE: ${browserEngine} (${deviceMode} mode)...`);

    const browserType = getBrowserType(browserEngine);
    const deviceConfig = DEVICE_CONFIGS[deviceMode];

    let browser: Browser | undefined;
    let browserContext: BrowserContext | undefined;
    let page: Page | undefined;
    let tempVideoPath = '';
    let videoPath = '';
    try {
      // Launch a dedicated browser instance for this TC
      browser = await browserType.launch({
        headless: isHeadless,
        slowMo: isHeadless ? undefined : 1000, // Add slowMo when in headed mode so interactions are visible
        args:
          browserEngine === 'chromium'
            ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            : [],
      });

      // Register the browser so a cancel request can force-close it mid-step.
      runRegistry.registerBrowser(runId, browser);

      // If the run was cancelled before/while launching, bail out immediately.
      if (runRegistry.isAborted(runId)) {
        await browser.close().catch(() => {});
        throw new Error('Execution cancelled by user before browser started.');
      }

      const recordVideoDir = path.join(process.cwd(), 'public', 'videos');
      if (!fs.existsSync(recordVideoDir)) {
        fs.mkdirSync(recordVideoDir, { recursive: true });
      }

      browserContext = await browser.newContext({
        viewport: deviceConfig.viewport,
        userAgent: deviceConfig.userAgent,
        isMobile: deviceConfig.isMobile ?? false,
        hasTouch: deviceConfig.hasTouch ?? false,
        recordVideo: videoCaptureSetting !== 'off' ? {
          dir: recordVideoDir,
          size: { width: 1280, height: 720 }
        } : undefined
      });

      page = await browserContext.newPage();

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

      let suiteFailed = false;

      // ---- Execute each step ----
      for (let i = 0; i < suite.steps.length; i++) {
        const step = suite.steps[i];
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
          logger.info(`[${suite.id}] Step ${stepIndex} skipped due to prior failure`);
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

        logger.info(`[${suite.id}] Step ${stepIndex}: ${step.rawText}`);
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
                break;
              }

              case 'click': {
                stepLogs.push(`Scanning DOM for clickable: "${step.targetField}"`);
                const match = await this.discovery.discover(page, step.targetField);
                stepLogs.push(`Resolved: "${match.selector}" (${match.score}%)`);
                result.resolvedSelector = match.selector;

                await page.locator(match.selector).first().click({ timeout: 15_000 });
                stepLogs.push(`Clicked element`);

                // Post-click: wait for page/DOM load (with a short timeout)
                stepLogs.push(`Waiting for page/DOM load...`);
                try {
                  await page.waitForLoadState('load', { timeout: 3000 });
                  stepLogs.push(`Page settled.`);
                } catch {
                  try {
                    await page.waitForLoadState('domcontentloaded', { timeout: 1000 });
                    stepLogs.push(`Page DOM ready.`);
                  } catch {
                    stepLogs.push(`Continuing execution.`);
                  }
                }
                break;
              }

              case 'select': {
                stepLogs.push(`Scanning DOM for dropdown: "${step.targetField}"`);
                const match = await this.discovery.discover(page, step.targetField);
                result.resolvedSelector = match.selector;
                await page.locator(match.selector).first().selectOption(stepValue || '');
                stepLogs.push(`Selected option: "${step.value}"`);
                break;
              }

              case 'check': {
                stepLogs.push(`Scanning DOM for checkbox: "${step.targetField}"`);
                const match = await this.discovery.discover(page, step.targetField);
                result.resolvedSelector = match.selector;
                await page.locator(match.selector).first().check();
                stepLogs.push(`Checked checkbox`);
                break;
              }

              case 'uncheck': {
                stepLogs.push(`Scanning DOM for checkbox: "${step.targetField}"`);
                const match = await this.discovery.discover(page, step.targetField);
                result.resolvedSelector = match.selector;
                await page.locator(match.selector).first().uncheck();
                stepLogs.push(`Unchecked checkbox`);
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
              .capture(page, `${runId}-${suite.id}`, stepIndex)
              .catch(() => undefined);
            if (screenshotUrl) {
              result.screenshotPath = screenshotUrl;
              stepLogs.push(`Screenshot saved: ${screenshotUrl}`);
            }
          }
        } catch (stepErr: any) {
          logger.error(`[${suite.id}] Step ${stepIndex} failed`, stepErr);
          result.status = 'failed';
          result.error = stepErr?.message || 'Error during browser interaction.';
          stepLogs.push(`ERROR: ${result.error}`);
          suiteFailed = true;

          // ---- Failure-context capture (Phase 4.1): screenshot + URL + DOM ----
          result.pageUrl = await Promise.resolve(page.url()).catch(() => undefined);

          if (config?.captureScreenshots !== false) {
            const errShot = await this.screenshotManager
              .capture(page, `${runId}-${suite.id}`, stepIndex)
              .catch(() => undefined);
            if (errShot) result.screenshotPath = errShot;
          }

          const domPath = await this.domSnapshotManager
            .capture(page, `${runId}-${suite.id}`, stepIndex)
            .catch(() => undefined);
          if (domPath) {
            result.domSnapshotPath = domPath;
            stepLogs.push(`DOM snapshot saved: ${domPath}`);
          }
        }

        result.durationMs = Date.now() - stepStartTime;
        stepResults.push(result);
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
      if (browser) {
        if (!isHeadless && page) {
          pushRealTimeLog(`Headed mode: pausing for 5 seconds before closing browser...`);
          await page.waitForTimeout(5000).catch(() => {});
        }
        await browser.close().catch(() => {});
      }
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
    };
  }
}
