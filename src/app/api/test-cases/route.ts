import { NextRequest, NextResponse } from 'next/server';
import { fileHelper } from '@/utils/fileHelper';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { TestCase } from '@/types/testCase';
import { v4 as uuidv4 } from 'uuid';

export async function GET(request: NextRequest) {
  try {
    const testCases = fileHelper.getTestCases();
    return NextResponse.json(testCases, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Failed to retrieve test cases', details: err?.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, description, websiteUrl, moduleName, stepsText } = body;

    if (!title || !stepsText) {
      return NextResponse.json(
        { error: 'Validation failed', details: 'Title and test case steps are required' },
        { status: 400 }
      );
    }

    // Parse the raw text steps into structured ParsedStep[]
    const parser = new TestCaseParser();
    const steps = parser.parse(stepsText.split('\n'));

    if (steps.length === 0) {
      return NextResponse.json(
        { error: 'Validation failed', details: 'No valid steps could be parsed from the steps editor.' },
        { status: 400 }
      );
    }

    const newTestCase: TestCase = {
      id: 'tc_' + uuidv4().substring(0, 8),
      title: title.trim(),
      description: description?.trim() || '',
      websiteUrl: websiteUrl?.trim() || '',
      moduleName: moduleName?.trim() || 'General',
      stepsText: stepsText,
      steps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    fileHelper.saveTestCase(newTestCase);

    return NextResponse.json(newTestCase, { status: 201 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal server error occurred', details: err?.message },
      { status: 500 }
    );
  }
}
