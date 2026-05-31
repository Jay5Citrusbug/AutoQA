import { NextRequest, NextResponse } from 'next/server';
import { ReportsQuerySchema } from '@/types/apiModels';
import { fileHelper } from '@/utils/fileHelper';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = {
      runId: searchParams.get('runId') || undefined,
      appName: searchParams.get('appName') || undefined,
      moduleName: searchParams.get('moduleName') || undefined,
      status: searchParams.get('status') || 'all'
    };

    // Validate query parameters with Zod schema
    const validation = ReportsQuerySchema.safeParse(query);
    if (!validation.success) {
      return NextResponse.json({
        error: 'Invalid query parameters format',
        details: validation.error.flatten()
      }, { status: 400 });
    }

    const { runId, appName, moduleName, status } = validation.data;

    // Case 1: Fetch single report details if runId is supplied
    if (runId) {
      const report = fileHelper.getReport(runId);
      if (!report) {
        return NextResponse.json({ error: `Report details for ID ${runId} not found.` }, { status: 404 });
      }
      return NextResponse.json(report, { status: 200 });
    }

    // Case 2: Fetch history summary list with filters
    const historySummaries = fileHelper.getHistory();
    const summaries = historySummaries.filter(s => {
      const matchesStatus = status === 'all' || s.status === status;
      const matchesAppName = !appName || (s.appName && s.appName.toLowerCase().includes(appName.toLowerCase())) || s.title.toLowerCase().includes(appName.toLowerCase());
      const matchesModuleName = !moduleName || (s.moduleName && s.moduleName.toLowerCase().includes(moduleName.toLowerCase())) || s.title.toLowerCase().includes(moduleName.toLowerCase());
      return matchesStatus && matchesAppName && matchesModuleName;
    });

    return NextResponse.json(summaries, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({
      error: 'Internal server error occurred',
      details: err?.message || 'Unknown error context'
    }, { status: 500 });
  }
}
