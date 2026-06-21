import { NextRequest, NextResponse } from 'next/server';
import { fileHelper } from '@/utils/fileHelper';
import { TestCaseParser } from '@/core/parser/testCaseParser';
import { TestCase } from '@/types/testCase';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const testCase = fileHelper.getTestCase(id);

    if (!testCase) {
      return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
    }

    return NextResponse.json(testCase, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Failed to retrieve test case', details: err?.message },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existingTestCase = fileHelper.getTestCase(id);

    if (!existingTestCase) {
      return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
    }

    const body = await request.json();
    const { title, description, websiteUrl, moduleName, stepsText } = body;

    if (!title || !stepsText) {
      return NextResponse.json(
        { error: 'Validation failed', details: 'Title and test case steps are required' },
        { status: 400 }
      );
    }

    // Re-parse the steps
    const parser = new TestCaseParser();
    const steps = parser.parse(stepsText.split('\n'));

    if (steps.length === 0) {
      return NextResponse.json(
        { error: 'Validation failed', details: 'No valid steps could be parsed from steps editor.' },
        { status: 400 }
      );
    }

    const updatedTestCase: TestCase = {
      ...existingTestCase,
      title: title.trim(),
      description: description?.trim() || '',
      websiteUrl: websiteUrl?.trim() || '',
      moduleName: moduleName?.trim() || 'General',
      stepsText: stepsText,
      steps,
      updatedAt: new Date().toISOString()
    };

    fileHelper.saveTestCase(updatedTestCase);

    return NextResponse.json(updatedTestCase, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Internal server error occurred', details: err?.message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const success = fileHelper.deleteTestCase(id);

    if (!success) {
      return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
    }

    return NextResponse.json({ message: 'Test case deleted successfully' }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: 'Failed to delete test case', details: err?.message },
      { status: 500 }
    );
  }
}
