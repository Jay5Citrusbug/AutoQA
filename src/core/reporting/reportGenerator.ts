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

    // 3. Bug generation on failure. The draft (evidence + RCA) is always produced;
    //    a Jira issue is only created when autoFileBug is set (Phase 4.4).
    let bugReport: BugReport | undefined;
    let bugSummary: BugReportSummary | undefined;
    if (summary.status === 'failed') {
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

    // Build the final Next.js payload structure
    const payload: ReportPayload = {
      summary,
      details: {
        ...context,
        bugReport: bugSummary, // typed summary surfaced to the API/UI
      },
    };

    // Save JSON and update history log
    fileHelper.saveReport(payload);

    return payload;
  }
}
