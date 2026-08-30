import { ExecutionContext, BugReportSummary } from '@/types/execution';
import { ReportPayload, ReportSummary } from '@/types/report';
import { fileHelper } from '@/utils/fileHelper';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';
import {
  EvidenceCollector,
  BugAutoGenerator,
  JiraClient,
  ReportExporter,
  TestReport,
  StepReport,
  BugReport
} from '@/lib/report-bug-tracker';
import { classifyFailure } from './failureClassifier';
import { isCloudinaryConfigured, uploadFile, uploadText } from '@/core/storage/cloudinaryStorage';

export interface GenerateOptions {
  /** When true, a drafted bug is actually filed as a Jira issue (Phase 4.4). */
  autoFileBug?: boolean;
}

export interface IReportGenerator {
  generate(context: ExecutionContext, options?: GenerateOptions): Promise<ReportPayload>;
}

export class ReportGenerator implements IReportGenerator {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'public', 'reports');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Builds a Jira client from env. Real mode requires JIRA_BASE_URL + JIRA_EMAIL +
   * JIRA_API_TOKEN; otherwise it runs in mock mode (drafts a fake ticket id).
   */
  private buildJiraClient(): { client: JiraClient; mock: boolean } {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const apiToken = process.env.JIRA_API_TOKEN;
    const projectKey = process.env.JIRA_PROJECT_KEY || 'QA';
    const mock = !(baseUrl && email && apiToken);

    return {
      mock,
      client: new JiraClient({
        baseUrl: baseUrl || 'https://jira.example-mock.com',
        projectKey,
        email,
        apiToken,
        isMockMode: mock,
      }),
    };
  }

  /**
   * Writes the rolled-up log files for a run, and publishes them if Cloudinary
   * is configured.
   *
   * Console output and network traffic only exist in memory while the run is
   * going, so they are serialised here. They are written to disk first and
   * uploaded second, deliberately: the report links to these files, and a link
   * to a file that was never written is a 404 no matter how the run went.
   */
  private async publishLogArtifacts(collector: EvidenceCollector, executionId: string): Promise<void> {
    const folder = `logs/execution-${executionId}`;
    const localDir = path.join(this.outputDir, 'logs', `execution-${executionId}`);

    /** Writes one log file next to the report and returns what the collector needs. */
    const write = (fileName: string, content: string) => {
      const filePath = path.join(localDir, fileName);
      fileHelper.writeText(filePath, content);
      return {
        // Root-relative so the link works from any page in the report, not just
        // the one that happens to sit at the right depth.
        filePath: `/reports/logs/execution-${executionId}/${fileName}`,
        sizeBytes: Buffer.byteLength(content, 'utf-8'),
      };
    };

    const consoleLogs = collector.getConsoleLogs();
    if (consoleLogs.length > 0) {
      const text = consoleLogs
        .map((l) => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
        .join('\n');
      const written = write('console.log', text);

      const uploaded = isCloudinaryConfigured()
        ? await uploadText(text, { folder, publicId: 'console.log' })
        : null;

      collector.attachLogArtifact('console_log', {
        ...written,
        remote: uploaded
          ? { url: uploaded.secureUrl, publicId: uploaded.publicId, sizeBytes: uploaded.bytes }
          : undefined,
      });
    }

    const apiLogs = collector.getAPILogs();
    if (apiLogs.length > 0) {
      // A minimal but valid HAR 1.2 log, so the file opens in the usual viewers
      // rather than being a JSON dump that only this app understands.
      const har = {
        log: {
          version: '1.2',
          creator: { name: 'AutoQA', version: '1.0' },
          entries: apiLogs.map((l) => ({
            startedDateTime: l.requestTime,
            time: l.duration,
            request: {
              method: l.method,
              url: l.fullUrl,
              httpVersion: 'HTTP/1.1',
              headers: Object.entries(l.headers).map(([name, value]) => ({ name, value })),
              queryString: [],
              cookies: [],
              headersSize: -1,
              bodySize: l.requestSize,
            },
            response: {
              status: l.statusCode,
              statusText: l.statusText,
              httpVersion: 'HTTP/1.1',
              headers: [],
              cookies: [],
              content: { size: l.responseSize, mimeType: 'application/json' },
              redirectURL: '',
              headersSize: -1,
              bodySize: l.responseSize,
            },
            cache: {},
            timings: { send: 0, wait: l.duration, receive: 0 },
          })),
        },
      };

      const harJson = JSON.stringify(har, null, 2);
      const written = write('network.har', harJson);

      const uploaded = isCloudinaryConfigured()
        ? await uploadText(harJson, {
            folder,
            publicId: 'network.har',
            contentType: 'application/json',
          })
        : null;

      collector.attachLogArtifact('har_file', {
        ...written,
        remote: uploaded
          ? { url: uploaded.secureUrl, publicId: uploaded.publicId, sizeBytes: uploaded.bytes }
          : undefined,
      });
    }
  }

  public async generate(context: ExecutionContext, options?: GenerateOptions): Promise<ReportPayload> {
    const totalSteps = context.stepResults.length;
    const passedSteps = context.stepResults.filter((s) => s.status === 'passed').length;
    const failedSteps = context.stepResults.filter((s) => s.status === 'failed').length;
    const skippedSteps = context.stepResults.filter((s) => s.status === 'skipped').length;

    const summary: ReportSummary = {
      runId: context.runId,
      url: context.url,
      appName: context.appName,
      moduleName: context.moduleName,
      title: context.appName && context.moduleName
        ? `${context.appName} - ${context.moduleName}`
        : `Execution Run - ${context.url.replace(/^https?:\/\//i, '')}`,
      timestamp: context.endTime || new Date().toISOString(),
      totalSteps,
      passedSteps,
      failedSteps,
      skippedSteps,
      durationMs: context.durationMs || 0,
      status: failedSteps > 0 ? 'failed' : 'passed',
    };

    // 1. Initialize report-bug-tracker components
    const bugGen = new BugAutoGenerator();
    const { client: jiraClient, mock: jiraMock } = this.buildJiraClient();
    const exporter = new ReportExporter();

    // 2. Map ExecutionContext to collector logs
    const executionId = context.runId;
    const testCaseId = context.testSuiteResults?.[0]?.tcId || 'TC01';
    const collector = new EvidenceCollector(executionId, testCaseId);

    // Map network requests (if captured)
    if (context.networkRequests) {
      for (const req of context.networkRequests) {
        let pathname = req.url;
        try {
          pathname = new URL(req.url).pathname;
        } catch {}

        collector.addAPILog({
          timestamp: req.timestamp,
          method: (req.method || 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
          endpoint: pathname,
          fullUrl: req.url,
          headers: {}, // raw headers not available in flat records
          requestPayload: null,
          requestSize: 0,
          statusCode: req.status || 200,
          statusText: req.status && req.status >= 400 ? 'Error' : 'OK',
          responsePayload: null,
          responseSize: 0,
          requestTime: req.timestamp,
          responseTime: req.timestamp,
          duration: req.durationMs || 0
        });
      }
    }

    // Map console logs (if captured)
    if (context.consoleLogs) {
      for (const log of context.consoleLogs) {
        collector.addConsoleLog({
          level: log.type === 'error' ? 'error' : log.type === 'warn' ? 'warn' : 'info',
          message: log.text,
          args: [],
          timestamp: log.timestamp
        });
      }
    }

    // Map step results to StepReports
    const reportId = `rep-${Math.random().toString(36).substring(2, 11)}`;
    const mappedStepReports: StepReport[] = context.stepResults.map(s => {
      const stepStatus: 'passed' | 'failed' | 'not_reached' = 
        s.status === 'passed' ? 'passed' : s.status === 'failed' ? 'failed' : 'not_reached';

      // Append captured failure context (page URL + DOM snapshot) to failed steps
      // so it lands in the bug's reproduction details.
      let actualResult = s.status === 'passed' ? 'Completed successfully' : s.error || 'Action failed';
      if (s.status === 'failed') {
        if (s.pageUrl) actualResult += `\nPage URL at failure: ${s.pageUrl}`;
        if (s.domSnapshotPath) actualResult += `\nDOM snapshot: ${s.domSnapshotPath}`;
      }

      return {
        id: `step-${Math.random().toString(36).substring(2, 11)}`,
        reportId,
        stepNumber: s.stepIndex,
        action: s.step.rawText,
        expectedResult: s.step.type === 'validation'
          ? `Assertion: ${s.step.targetField} is ${s.step.validation}`
          : `Interact with element: ${s.step.targetField}`,
        actualResult,
        status: stepStatus,
        errorMessage: s.error,
        screenshotPath: s.screenshotPath || undefined,
        screenshotSizeBytes: s.screenshotPath ? 150 * 1024 : undefined
      };
    });

    // Register the artifacts the runner captured. Each carries its Cloudinary
    // copy when the upload succeeded, so the evidence record can say whether the
    // file is on the CDN or only on this machine.
    for (const step of context.stepResults) {
      if (!step.screenshotPath) continue;
      collector.addScreenshot(
        step.stepIndex,
        step.screenshotPath,
        step.screenshotSizeBytes ?? step.screenshotRemote?.sizeBytes ?? 0,
        step.screenshotRemote,
      );
    }

    const primarySuite = context.testSuiteResults?.[0];
    if (primarySuite?.videoPath) {
      collector.captureVideo(
        primarySuite.videoPath,
        primarySuite.videoSizeBytes ?? primarySuite.videoRemote?.sizeBytes ?? 0,
        primarySuite.videoRemote,
      );
    }

    if (primarySuite?.tracePath) {
      collector.captureTrace(
        primarySuite.tracePath,
        primarySuite.traceSizeBytes ?? primarySuite.traceRemote?.sizeBytes ?? 0,
        primarySuite.traceRemote,
      );
    }

    const testReport: TestReport = {
      id: reportId,
      executionId,
      testCaseId,
      status: summary.status,
      summary: summary.title,
      startedAt: context.startTime,
      completedAt: summary.timestamp,
      durationMs: summary.durationMs,
      videoPath: context.testSuiteResults?.[0]?.videoPath || undefined
    };

    // 3. Bug generation on failure — but only when the application is what failed.
    //    A step the parser could not read, or a locator that resolved to nothing,
    //    never put a question to the app, so raising it as a product bug is noise
    //    that teaches people to ignore the bug queue.
    const apiLogs = collector.getAPILogs();
    const consoleLogs = collector.getConsoleLogs();

    let bugReport: BugReport | undefined;
    let bugSummary: BugReportSummary | undefined;
    const failureClassification = classifyFailure(context.stepResults, {
      hasServerError: apiLogs.some((l) => l.statusCode >= 500),
      hasUncaughtError: consoleLogs.some(
        (l) => l.level === 'error' && (!!l.stackTrace || /uncaught/i.test(l.message)),
      ),
    });

    if (failureClassification) {
      logger.info(
        `Run ${context.runId} failure classified as ${failureClassification.kind}: ${failureClassification.reason}`,
      );
    }

    if (summary.status === 'failed' && failureClassification?.fileAsBug) {
      const testTitle = summary.title;
      bugReport = await bugGen.generateBugReport(
        reportId,
        testTitle,
        mappedStepReports,
        collector.getAPILogs(),
        collector.getConsoleLogs()
      );

      let disposition: 'drafted' | 'filed' = 'drafted';
      if (options?.autoFileBug) {
        try {
          const jiraResult = await jiraClient.createIssue(bugReport);
          bugReport.jiraIssueId = jiraResult.issueId;
          bugReport.jiraUrl = jiraResult.url;
          disposition = 'filed';
          logger.info(`Filed bug as Jira issue ${jiraResult.issueId} (${jiraMock ? 'mock' : 'real'})`);
        } catch (err) {
          logger.error('Failed to create Jira issue; leaving bug as draft', err);
        }
      }

      bugSummary = {
        id: bugReport.id,
        title: bugReport.title,
        severity: bugReport.severity,
        category: bugReport.category,
        rootCause: bugReport.rootCause,
        suggestedFix: bugReport.suggestedFix,
        disposition,
        jiraIssueId: bugReport.jiraIssueId,
        jiraUrl: bugReport.jiraUrl,
        jiraMock: disposition === 'filed' ? jiraMock : undefined,
      };
    }

    // 4. Generate Premium HTML
    await this.publishLogArtifacts(collector, executionId);
    const evidenceMetadata = collector.compileEvidenceMetadata();
    const htmlContent = exporter.exportToHtml(
      testReport,
      mappedStepReports,
      collector.getAPILogs(),
      collector.getConsoleLogs(),
      bugReport,
      evidenceMetadata
    );

    // Save standalone Premium HTML dashboard
    const htmlPath = path.join(this.outputDir, `${context.runId}.html`);
    fileHelper.writeText(htmlPath, htmlContent);
    logger.info(`Generated Premium HTML report: ${htmlPath}`);

    // Publish the dashboard so links to it survive outside this host. `raw`
    // keeps the HTML byte-for-byte rather than treating it as media.
    const uploadedReport = await uploadFile(htmlPath, {
      folder: 'reports',
      resourceType: 'raw',
      publicId: `${context.runId}.html`,
    });
    testReport.reportUrl = uploadedReport?.secureUrl ?? `/reports/${context.runId}.html`;
    if (uploadedReport) {
      logger.info(`Uploaded report to Cloudinary: ${uploadedReport.secureUrl}`);
    }

    // Build the final Next.js payload structure
    const payload: ReportPayload = {
      summary,
      details: {
        ...context,
        bugReport: bugSummary, // typed summary surfaced to the API/UI
        // Present on every failed run, including the ones that were deliberately
        // not raised as bugs — the reason they were not is the useful part.
        failureClassification: failureClassification ?? undefined,
      },
    };

    // Save JSON and update history log
    fileHelper.saveReport(payload);

    return payload;
  }
}
