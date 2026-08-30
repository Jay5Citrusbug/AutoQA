import { NextRequest, NextResponse } from 'next/server';
import { RunTestRequestSchema } from '@/types/apiModels';
import { PlaywrightRunner } from '@/core/execution/playwrightRunner';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { formatBlockingErrors, lintStepsText } from '@/core/parser/stepLinter';
import { runRegistry } from '@/core/execution/runRegistry';
import { isAiExecutionAvailable } from '@/core/ai/agentExecutor';

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

    // ---- Pre-flight gate ----
    // A step the parser cannot understand can never execute deterministically,
    // and that is knowable the instant the text arrives. Starting the run anyway
    // means paying for a browser launch, a login and every preceding step before
    // reporting a fault that was present before anything started — and reporting
    // it one step at a time, so a file with four bad steps takes four runs to fix.
    //
    // That reasoning holds only while the parser is the sole engine. With the AI
    // agent available, an unparsed step is no longer unrunnable — it is a step
    // that routes to the agent instead, which is the whole point of hybrid mode.
    // So the gate now closes only when nothing else can pick the step up.
    const lint = lintStepsText(stepsText);
    const canEscalate = config.executionMode !== 'deterministic' && isAiExecutionAvailable();
    if (!lint.runnable && !canEscalate) {
      return NextResponse.json(
        {
          error: 'Test case contains steps that cannot be executed',
          details:
            `${lint.errorCount} step(s) could not be understood, so this run was not started. ` +
            `Fix them and run again — nothing was executed.` +
            (config.executionMode === 'deterministic'
              ? ' Or switch this run to Auto mode, where the AI agent handles steps the parser cannot.'
              : ' Set ANTHROPIC_API_KEY to let the AI agent handle steps the parser cannot.'),
          blockingSteps: formatBlockingErrors(lint),
          lint,
        },
        { status: 422 },
      );
    }

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
        reusedSession: r.reusedSession,
        assertionNote: r.assertionNote,
        // Data the runner invented because the step did not supply it. Surfaced
        // so the reader sees what was actually typed or chosen, not just that
        // the step passed.
        autoSuppliedValue: r.autoSuppliedValue,
        // Which engine ran the step, and — for AI-executed steps — the agent's
        // own account of its verdict. A verdict the reader cannot inspect is a
        // verdict they cannot trust.
        executedBy: r.executedBy,
        aiReasoning: r.aiReasoning,
        aiExpected: r.aiExpected,
        aiActual: r.aiActual,
        aiHandoffReason: r.aiHandoffReason,
      })),
      aiUsage: context.aiUsage,
      bugReport: context.bugReport,
      failureClassification: context.failureClassification,
      sessionReuse: context.sessionReuse,
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
        sessionReused: ts.sessionReused,
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
