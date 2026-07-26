import { NextRequest, NextResponse } from 'next/server';
import { fileHelper } from '@/utils/fileHelper';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { TestCase } from '@/types/testCase';
import { v4 as uuidv4 } from 'uuid';

interface BulkTestCaseInput {
  title: string;
  description?: string;
  websiteUrl: string;
  moduleName?: string;
  stepsText: string;
  expectedResult?: string;
  execType?: 'Functional' | 'Smoke' | 'Regression';
  source?: 'manual' | 'import' | 'run';
}

/**
 * POST /api/test-cases/bulk — saves many test cases in one call.
 * Used by: CSV/XLSX import ("save to repository for regression reuse") and the
 * Run Results view ("save this run's test case(s) to the Regression Suite").
 * Rows that fail to parse are reported back but don't block the rest of the batch.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const items: BulkTestCaseInput[] = Array.isArray(body?.testCases) ? body.testCases : [];

    if (items.length === 0) {
      return NextResponse.json(
        { error: 'Validation failed', details: 'testCases must be a non-empty array' },
        { status: 400 },
      );
    }

    const parser = new TestCaseParser();
    const saved: TestCase[] = [];
    const errors: string[] = [];

    for (const item of items) {
      if (!item.title || !item.stepsText) {
        errors.push(`Skipped "${item.title || '(untitled)'}": title and stepsText are required.`);
        continue;
      }

      const combinedText = item.expectedResult?.trim()
        ? `${item.stepsText.trim()}\n${item.expectedResult.trim()}`
        : item.stepsText.trim();
      const steps = parser.parse(combinedText.split('\n'));

      if (steps.length === 0) {
        errors.push(`Skipped "${item.title}": no valid steps could be parsed.`);
        continue;
      }

      saved.push({
        id: 'tc_' + uuidv4().substring(0, 8),
        title: item.title.trim(),
        description: item.description?.trim() || '',
        websiteUrl: item.websiteUrl?.trim() || '',
        moduleName: item.moduleName?.trim() || 'General',
        stepsText: item.stepsText,
        expectedResult: item.expectedResult?.trim() || undefined,
        execType: item.execType || 'Functional',
        source: item.source || 'import',
        steps,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    if (saved.length > 0) {
      fileHelper.saveTestCases(saved);
    }

    return NextResponse.json({ saved, errors }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal server error occurred', details: err?.message },
      { status: 500 },
    );
  }
}
