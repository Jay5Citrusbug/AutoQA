import { NextRequest, NextResponse } from 'next/server';
import { lintStepsText } from '@/core/parser/stepLinter';

/**
 * POST /api/steps/validate — what would the runner make of these steps?
 *
 * The parser is server-side, so the editor cannot answer this itself. Exposing
 * it lets the UI show the real interpretation of every step as it is typed or
 * imported, instead of the author finding out mid-run. Read-only: it parses
 * text and returns a verdict, it never touches storage or launches anything.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const stepsText: unknown = body?.stepsText;

    if (typeof stepsText !== 'string') {
      return NextResponse.json(
        { error: 'Validation failed', details: 'stepsText must be a string' },
        { status: 400 },
      );
    }

    if (!stepsText.trim()) {
      return NextResponse.json(
        { suites: [], totalSteps: 0, errorCount: 0, warningCount: 0, runnable: true },
        { status: 200 },
      );
    }

    return NextResponse.json(lintStepsText(stepsText), { status: 200 });
  } catch (err: unknown) {
    return NextResponse.json(
      {
        error: 'Internal server error occurred',
        details: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
