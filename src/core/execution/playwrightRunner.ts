import { chromium, firefox, webkit, devices, BrowserType } from '@playwright/test';
import {
  ExecutionContext,
  StepExecutionResult,
  LocatorMap,
  TestSuiteResult,
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

// Universal 2-minute timeout applied to all network-dependent operations.
const UNIVERSAL_TIMEOUT_MS = 120_000;

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
    config?: RunConfig,
  ): Promise<ExecutionContext> {
    const runId = uuidv4();
    const startTime = new Date().toISOString();
    const browser = config?.browser ?? 'chromium';
    const deviceMode = config?.deviceMode ?? 'desktop';
    const maxWorkers = Math.max(1, Math.min(config?.maxWorkers ?? 1, 8));

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
    for (const sr of suiteResults) {
      context.stepResults.push(...sr.stepResults);
    }

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

    const browserType = getBrowserType(browserEngine);
    const deviceConfig = DEVICE_CONFIGS[deviceMode];

    let browser;
    try {
      // Launch a dedicated browser instance for this TC
      browser = await browserType.launch({
        headless: config?.headless !== false,
        args:
          browserEngine === 'chromium'
            ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            : [],
      });

      const browserContext = await browser.newContext({
        viewport: deviceConfig.viewport,
        userAgent: deviceConfig.userAgent,
        isMobile: deviceConfig.isMobile ?? false,
        hasTouch: deviceConfig.hasTouch ?? false,
      });

      const page = await browserContext.newPage();

      // Hook up log listeners
      this.logManager.startListeners(page);

      // ---- Execute each step INDEPENDENTLY (no global abort on failure) ----
      for (let i = 0; i < suite.steps.length; i++) {
        const step = suite.steps[i];
        const stepIndex = step.stepIndex;
        const stepStartTime = Date.now();
        const stepLogs: string[] = [];

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
                await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: UNIVERSAL_TIMEOUT_MS });
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
                  await page.locator(userMatch.selector).first().fill(userVal);
                  await page.locator(passMatch.selector).first().fill(passVal);
                  break;
                }

                stepLogs.push(`Scanning DOM for input: "${step.targetField}"`);
                const match = await this.discovery.discover(page, step.targetField);
                stepLogs.push(`Resolved: "${match.selector}" (${match.score}%)`);
                result.resolvedSelector = match.selector;
                await page.locator(match.selector).first().fill(step.value || '');
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

                // Post-click: wait for navigation / network to settle (2 min patience)
                stepLogs.push(`Waiting for page to settle after click...`);
                try {
                  await page.waitForLoadState('networkidle', { timeout: UNIVERSAL_TIMEOUT_MS });
                  stepLogs.push(`Page network settled.`);
                } catch {
                  try {
                    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
                    stepLogs.push(`Page DOM ready (network still active — WebSocket app).`);
                  } catch {
                    stepLogs.push(`Page still loading — continuing.`);
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

          // Capture failure screenshot
          if (config?.captureScreenshots !== false) {
            const errShot = await this.screenshotManager
              .capture(page, `${runId}-${suite.id}`, stepIndex)
              .catch(() => undefined);
            if (errShot) result.screenshotPath = errShot;
          }

          // NOTE: No global abort — each step continues independently within the TC
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
      if (browser) {
        await browser.close().catch(() => {});
      }
    }

    const failed = stepResults.some((r) => r.status === 'failed');

    return {
      tcId: suite.id,
      title: suite.title,
      status: failed ? 'failed' : 'passed',
      durationMs: Date.now() - suiteStart,
      stepResults,
    };
  }
}
