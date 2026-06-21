import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { runId } = await request.json();
    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    if (!(globalThis as any).activeRuns) {
      (globalThis as any).activeRuns = {};
    }

    // Set abort flag to true
    if ((globalThis as any).activeRuns[runId]) {
      (globalThis as any).activeRuns[runId].aborted = true;
    } else {
      (globalThis as any).activeRuns[runId] = { aborted: true };
    }

    return NextResponse.json({ success: true, runId, message: 'Execution cancellation signal transmitted.' }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to cancel execution' }, { status: 550 });
  }
}
