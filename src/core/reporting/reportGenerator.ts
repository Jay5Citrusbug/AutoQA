import { ExecutionContext } from '@/types/execution';
import { ReportPayload, ReportSummary } from '@/types/report';
import { fileHelper } from '@/utils/fileHelper';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';
import { 
  DbRepository, 
  EvidenceCollector, 
  BugAutoGenerator, 
  JiraClient, 
  ReportExporter, 
  TestExecutionData,
  TestReport,
  StepReport,
  APILog,
  ConsoleLog,
  BugReport
} from '@/lib/report-bug-tracker';

export interface IReportGenerator {
  generate(context: ExecutionContext): Promise<ReportPayload>;
}

export class ReportGenerator implements IReportGenerator {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'public', 'reports');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  public async generate(context: ExecutionContext): Promise<ReportPayload> {
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
    const dbRepo = new DbRepository();
    const bugGen = new BugAutoGenerator();
    const jiraClient = new JiraClient({
      baseUrl: 'https://jira.company-qa-portal.com',
      projectKey: 'QA',
      isMockMode: true
    });
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
          method: (req.method as any) || 'GET',
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

      return {
        id: `step-${Math.random().toString(36).substring(2, 11)}`,
        reportId,
        stepNumber: s.stepIndex,
        action: s.step.rawText,
        expectedResult: s.step.type === 'validation' 
          ? `Assertion: ${s.step.targetField} is ${s.step.validation}` 
          : `Interact with element: ${s.step.targetField}`,
        actualResult: s.status === 'passed' ? 'Completed successfully' : s.error || 'Action failed',
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

    // 3. Perform Bug Generation & Jira Mock creation if failed
    let bugReport: BugReport | undefined;
    if (summary.status === 'failed') {
      const testTitle = summary.title;
      bugReport = await bugGen.generateBugReport(
        reportId,
        testTitle,
        mappedStepReports,
        collector.getAPILogs(),
        collector.getConsoleLogs()
      );

      try {
        const jiraResult = await jiraClient.createIssue(bugReport);
        bugReport.jiraIssueId = jiraResult.issueId;
        bugReport.jiraUrl = jiraResult.url;
      } catch (err) {
        logger.error('Failed to generate mock Jira issue', err);
      }
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
        bugReport: bugReport || null // Attach the bug details to JSON payload
      } as any
    };

    // Save JSON and update history log
    fileHelper.saveReport(payload);

    return payload;
  }
}
