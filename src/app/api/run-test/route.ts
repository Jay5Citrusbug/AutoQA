import { NextRequest, NextResponse } from 'next/server';
import { RunTestRequestSchema } from '@/types/apiModels';
import { PlaywrightRunner } from '@/core/execution/playwrightRunner';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { runRegistry } from '@/core/execution/runRegistry';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate request body using Zod schema
    const validation = RunTestRequestSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten() },
        { status: 400 },
      );
    }

    const {
      url,
      appName,
      moduleName,
      execType,
      stepsText,
      browser,
      deviceMode,
      maxWorkers,
      config,
      runId,
    } = validation.data;

    // Parse test suites — splits on TC headers for multi-TC runs
    const parser = new TestCaseParser();
    const suites = parser.parseTestSuites(stepsText);

    if (suites.length === 0) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: {
            fieldErrors: {
              stepsText: [
                'No valid steps could be parsed from input text. Please provide valid step statements.',
              ],
            },
          },
        },
        { status: 400 },
      );
    }

    // Run all test suites with parallel workers + selected browser + device mode
    const runner = new PlaywrightRunner();
    const context = await runner.runTestSuites(url, suites, appName, moduleName, {
      ...config,
      browser,
      deviceMode,
      maxWorkers,
      runId,
    });

    const failedCount = context.stepResults.filter((s) => s.status === 'failed').length;
    const passedCount = context.stepResults.filter((s) => s.status === 'passed').length;

    // Build response payload
    const responsePayload = {
      runId: context.runId,
      appName,
      moduleName,
      url,
      type: execType,
      status: failedCount > 0 ? ('failed' as const) : ('passed' as const),
      durationMs: context.durationMs || 0,
      timestamp: context.startTime,
      passedCount,
      failedCount,
      totalCount: context.stepResults.length,
      browser,
      deviceMode,
      steps: context.stepResults.map((r) => ({
        stepIndex: r.stepIndex,
        rawText: r.step.rawText,
        status: r.status,
        durationMs: r.durationMs,
        resolvedSelector: r.resolvedSelector,
        screenshot: r.screenshotPath,
        error: r.error,
        consoleLogs: r.logs,
        domSnapshot: r.domSnapshotPath,
        pageUrl: r.pageUrl,
      })),
      bugReport: context.bugReport,
      generatedScriptPath: context.generatedScriptPath,
      videoPath: context.testSuiteResults?.[0]?.videoPath,
      networkRequests: context.networkRequests,
      // Per-TC suite summary
      testSuites: (context.testSuiteResults ?? []).map((ts) => ({
        tcId: ts.tcId,
        title: ts.title,
        status: ts.status,
        durationMs: ts.durationMs,
        generatedScriptPath: ts.generatedScriptPath,
        scriptVerification: ts.scriptVerification,
      })),
    };

    // Clean up live logs from memory after run finishes
    if (runId) runRegistry.clearLogs(runId);

    return NextResponse.json(responsePayload, { status: 200 });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error: 'Internal server error occurred',
        details: err instanceof Error ? err.message : 'Unknown error context',
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const runId = searchParams.get('runId');
    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }
    const logs = runRegistry.getLogs(runId);
    return NextResponse.json({ logs }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Error fetching active logs';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
