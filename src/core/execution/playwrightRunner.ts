import { chromium, firefox, webkit, devices, BrowserType } from '@playwright/test';
import {
  ExecutionContext,
  StepExecutionResult,
  LocatorMap,
  TestSuiteResult,
  NetworkRequestRecord,
} from '@/types/execution';
import { ParsedStep } from '@/types/testCase';
import { BrowserEngine, DeviceMode } from '@/types/mvp';
import { TestCaseParser } from '../parser/testCaseParser';
import { ElementDiscoveryEngine } from '../discovery/elementDiscovery';
import { Validator } from '../validation/validator';
import { ScreenshotManager } from '../evidence/screenshotManager';
import { LogManager } from '../evidence/logManager';
import { ReportGenerator } from '../reporting/reportGenerator';
import { PlaywrightGenerator } from '../generator/playwrightGenerator';
import { logger } from '@/utils/logger';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileHelper } from '@/utils/fileHelper';

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
  private logManager: LogManager;
  private reportGenerator: ReportGenerator;
  private scriptGenerator: PlaywrightGenerator;

  constructor() {
    this.parser = new TestCaseParser();
    this.discovery = new ElementDiscoveryEngine();
    this.validator = new Validator();
    this.screenshotManager = new ScreenshotManager();
    this.logManager = new LogManager();
    this.reportGenerator = new ReportGenerator();
    this.scriptGenerator = new PlaywrightGenerator();
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

    // Initialize global activeRuns
    if (!(globalThis as any).activeRuns) {
      (globalThis as any).activeRuns = {};
    }
    (globalThis as any).activeRuns[runId] = { aborted: false };

    // Initialize global activeLogs storage for live streaming logs
    if (!(globalThis as any).activeLogs) {
      (globalThis as any).activeLogs = {};
    }
    (globalThis as any).activeLogs[runId] = [
      `[${new Date().toLocaleTimeString()}] [SYSTEM] INITIALIZING AUTOQA KERNEL...`,
      `[${new Date().toLocaleTimeString()}] [SYSTEM] NODE_VERSION v20.11.0`,
      `[${new Date().toLocaleTimeString()}] [SYSTEM] LOADING TEST SUITE CONTEXT: functional_runner.ts`,
      `[${new Date().toLocaleTimeString()}] [SYSTEM] BROWSER_STARTING [IN_PROGRESS]`
    ];

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
    }
    context.networkRequests = allNetworkRequests;

    context.testSuiteResults = suiteResults;
    context.status = suiteResults.some((s) => s.status === 'failed') ? 'failed' : 'completed';
    context.endTime = new Date().toISOString();
    context.durationMs = Date.now() - new Date(context.startTime).getTime();

    // ---- Generate aggregate HTML report ----
    const reportPayload = await this.reportGenerator.generate(context);

    // ---- Generate Playwright spec for each suite ----
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
      }

      // Use the first suite's script path as the primary
      context.generatedScriptPath = suiteResults[0]?.generatedScriptPath;

      // Re-save report with script paths
      reportPayload.details.generatedScriptPath = context.generatedScriptPath;
      await this.reportGenerator.generate(reportPayload.details);
    }

    if ((globalThis as any).activeRuns && runId) {
      delete (globalThis as any).activeRuns[runId];
    }

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
    const requestTimes = new Map<any, number>();

    const settings = fileHelper.getSettings();
    const videoCaptureSetting = settings.videoCapture ?? 'off';
    const isHeadless = config?.headless !== undefined ? config.headless : settings.headlessMode;

    const pushRealTimeLog = (msg: string) => {
      const timeStr = new Date().toLocaleTimeString();
      const formattedLog = `[${timeStr}] [${suite.id}] ${msg}`;
      if ((globalThis as any).activeLogs?.[runId]) {
        (globalThis as any).activeLogs[runId].push(formattedLog);
      }
    };

    pushRealTimeLog(`LAUNCHING BROWSER ENGINE: ${browserEngine} (${deviceMode} mode)...`);

    const browserType = getBrowserType(browserEngine);
    const deviceConfig = DEVICE_CONFIGS[deviceMode];

    let browser: any;
    let browserContext: any;
    let page: any;
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
      page.on('request', (req: any) => {
        requestTimes.set(req, Date.now());
      });
      page.on('response', (res: any) => {
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
        if ((globalThis as any).activeRuns?.[runId]?.aborted) {
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
          if (step.type === 'action') {
            switch (step.action) {
              case 'navigate': {
                let targetUrl = step.value || url;
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
                  const userVal = isValid ? 'jay.r@optevo.com' : 'invalid_user@optevo.com';
                  const passVal = isValid ? 'Jayqa@1234' : 'WrongPassword123!';

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
                  await page.locator(match.selector).first().pressSequentially(step.value || '', { delay: 100 });
                } else {
                  await page.locator(match.selector).first().fill(step.value || '');
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
                await page.locator(match.selector).first().selectOption(step.value || '');
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

            const valResult = await this.validator.validate(page, step);
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

          // Capture failure screenshot
          if (config?.captureScreenshots !== false) {
            const errShot = await this.screenshotManager
              .capture(page, `${runId}-${suite.id}`, stepIndex)
              .catch(() => undefined);
            if (errShot) result.screenshotPath = errShot;
          }
        }

        result.durationMs = Date.now() - stepStartTime;
        stepResults.push(result);
      }

      // Collect telemetry
      const logsPayload = this.logManager.collect(page);
      if (config?.captureConsoleLogs) {
        // stored on parent context aggregate
      }
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
        } catch (err) {}
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
    };
  }
}
