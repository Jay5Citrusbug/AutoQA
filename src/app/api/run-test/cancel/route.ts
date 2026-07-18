import { NextRequest, NextResponse } from 'next/server';
import { runRegistry } from '@/core/execution/runRegistry';

export async function POST(request: NextRequest) {
  try {
    const { runId } = await request.json();
    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    // Marks the run aborted AND force-closes its live browsers so a step stuck
    // mid-navigation stops immediately instead of running to its timeout.
    const wasActive = await runRegistry.abort(runId);

    return NextResponse.json(
      {
        success: true,
        runId,
        message: wasActive
          ? 'Execution cancelled and browser(s) closed.'
          : 'Cancellation recorded; run will abort as soon as it starts.',
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to cancel execution';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
