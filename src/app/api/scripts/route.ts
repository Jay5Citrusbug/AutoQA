import { NextRequest, NextResponse } from 'next/server';
import { ScriptsQuerySchema } from '@/types/apiModels';
import { fileHelper, PATHS } from '@/utils/fileHelper';
import fs from 'fs';
import path from 'path';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = {
      appName: searchParams.get('appName') || undefined,
      moduleName: searchParams.get('moduleName') || undefined
    };

    // Validate query using Zod
    const validation = ScriptsQuerySchema.safeParse(query);
    if (!validation.success) {
      return NextResponse.json({
        error: 'Invalid query parameters format',
        details: validation.error.flatten()
      }, { status: 400 });
    }

    const { appName, moduleName } = validation.data;

    // Dynamically retrieve scripts from saved reports and disk
    const reportsDir = PATHS.REPORTS;
    const scripts: any[] = [];

    if (fs.existsSync(reportsDir)) {
      const files = fs.readdirSync(reportsDir);
      for (const file of files) {
        if (file === 'history-index.json' || !file.endsWith('.json')) continue;
        
        const reportPath = path.join(reportsDir, file);
        const report = fileHelper.readJson<any>(reportPath);
        if (report && report.details && report.details.generatedScriptPath) {
          const scriptRelPath = report.details.generatedScriptPath; // e.g. "/generated-tests/test_url_abc.spec.ts"
          const scriptName = path.basename(scriptRelPath);
          const fullScriptPath = path.join(process.cwd(), 'generated-tests', scriptName);
          
          let content = '';
          if (fs.existsSync(fullScriptPath)) {
            content = fs.readFileSync(fullScriptPath, 'utf-8');
          } else {
            // Check in public
            const publicPath = path.join(process.cwd(), 'public', 'generated-tests', scriptName);
            if (fs.existsSync(publicPath)) {
              content = fs.readFileSync(publicPath, 'utf-8');
            }
          }

          if (content) {
            scripts.push({
              id: report.summary.runId,
              scriptName,
              moduleName: report.summary.moduleName || 'Execution Scenario',
              appName: report.summary.appName || 'AutoQA Target',
              createdDate: report.summary.timestamp,
              content
            });
          }
        }
      }
    }

    // Filter scripts dynamically based on queries
    const filteredScripts = scripts.filter(s => {
      const matchesApp = !appName || s.appName.toLowerCase().includes(appName.toLowerCase());
      const matchesModule = !moduleName || s.moduleName.toLowerCase().includes(moduleName.toLowerCase());
      return matchesApp && matchesModule;
    });

    // Sort scripts by date descending
    filteredScripts.sort((a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime());

    return NextResponse.json(filteredScripts, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({
      error: 'Internal server error occurred',
      details: err?.message || 'Unknown error context'
    }, { status: 500 });
  }
}
