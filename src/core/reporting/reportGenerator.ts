import { ExecutionContext } from '@/types/execution';
import { ReportPayload, ReportSummary } from '@/types/report';

export interface IReportGenerator {
  generate(context: ExecutionContext): Promise<ReportPayload>;
}

import { fileHelper } from '@/utils/fileHelper';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';

export class ReportGenerator implements IReportGenerator {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'public', 'reports');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  public async generate(context: ExecutionContext): Promise<ReportPayload> {
    const totalSteps = context.stepResults.length;
    const passedSteps = context.stepResults.filter((s) => s.status === 'passed').length;
    const failedSteps = context.stepResults.filter((s) => s.status === 'failed').length;

    const summary: ReportSummary = {
      runId: context.runId,
      url: context.url,
      appName: context.appName,
      moduleName: context.moduleName,
      title: context.appName && context.moduleName
        ? `${context.appName} - ${context.moduleName}`
        : `Execution Run - ${context.url.replace(/^https?:\/\//i, '')}`,
      timestamp: context.endTime || new Date().toISOString(),
      totalSteps,
      passedSteps,
      failedSteps,
      durationMs: context.durationMs || 0,
      status: failedSteps > 0 ? 'failed' : 'passed',
    };

    const payload: ReportPayload = {
      summary,
      details: context,
    };

    // Save full JSON and history database index
    fileHelper.saveReport(payload);

    // Save standalone Premium HTML dashboard
    const htmlPath = path.join(this.outputDir, `${context.runId}.html`);
    const htmlContent = this.renderHtmlDashboard(payload);
    fileHelper.writeText(htmlPath, htmlContent);
    logger.info(`Generated Premium HTML report: ${htmlPath}`);

    return payload;
  }

  /**
   * Renders a highly immersive, beautiful, and fully self-contained HTML dashboard
   */
  private renderHtmlDashboard(payload: ReportPayload): string {
    const s = payload.summary;
    const d = payload.details;

    const stepsHtml = d.stepResults.map((r) => {
      const statusColor = r.status === 'passed' 
        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
        : r.status === 'failed' 
          ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' 
          : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30';
      
      const statusBadge = r.status === 'passed' 
        ? '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">Passed</span>'
        : r.status === 'failed'
          ? '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/20">Failed</span>'
          : '<span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-zinc-500/15 text-zinc-400 border border-zinc-500/20">Skipped</span>';

      return `
      <div class="border border-zinc-800 rounded-xl bg-zinc-900/40 backdrop-blur-md p-5 flex flex-col gap-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-3">
            <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-800 text-sm font-bold text-zinc-300 border border-zinc-700">
              ${r.stepIndex}
            </span>
            <div>
              <p class="font-medium text-white text-base">${r.step.rawText}</p>
              <p class="text-xs text-zinc-500 font-mono mt-0.5">Action: ${r.step.action || r.step.validation} | Field: ${r.step.targetField}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-zinc-500 font-mono">${r.durationMs}ms</span>
            ${statusBadge}
          </div>
        </div>

        ${r.error ? `
        <div class="bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 text-sm text-rose-400 font-mono">
          <span class="font-bold">Error:</span> ${r.error}
        </div>
        ` : ''}

        ${r.resolvedSelector ? `
        <div class="text-xs text-zinc-400 bg-zinc-950 px-3 py-1.5 rounded-md font-mono border border-zinc-800 self-start">
          <span class="text-zinc-600">Locator:</span> ${r.resolvedSelector}
        </div>
        ` : ''}

        ${r.screenshotPath ? `
        <div class="mt-2 border border-zinc-800 rounded-lg overflow-hidden max-w-md bg-zinc-950">
          <p class="text-xs text-zinc-500 border-b border-zinc-800 px-3 py-2 bg-zinc-900/60 font-mono">Visual Evidence Screenshot</p>
          <a href="${r.screenshotPath}" target="_blank" class="block hover:opacity-90 transition-opacity">
            <img src="${r.screenshotPath}" alt="Step screenshot" class="w-full h-auto object-cover max-h-64" />
          </a>
        </div>
        ` : ''}
      </div>
      `;
    }).join('');

    const consoleHtml = d.consoleLogs.map(l => {
      const typeColor = l.type === 'error' ? 'text-rose-400 bg-rose-500/5' : l.type === 'warn' ? 'text-amber-400 bg-amber-500/5' : 'text-zinc-300';
      return `<div class="px-4 py-2 border-b border-zinc-800/40 text-xs font-mono flex items-start gap-3 ${typeColor}">
        <span class="text-zinc-600 select-none">[${l.timestamp.split('T')[1].substring(0, 8)}]</span>
        <span class="font-bold tracking-wider select-none uppercase">[${l.type}]</span>
        <span class="break-all flex-1">${l.text}</span>
      </div>`;
    }).join('') || '<div class="p-4 text-center text-xs text-zinc-600 font-mono">No console logs outputted.</div>';

    const networkHtml = d.networkErrors.map(n => {
      return `<div class="px-4 py-2 border-b border-zinc-800/40 text-xs font-mono flex items-start gap-3 text-rose-400 bg-rose-500/5">
        <span class="text-zinc-600 select-none">[${n.timestamp.split('T')[1].substring(0, 8)}]</span>
        <span class="font-bold select-none">[${n.method}]</span>
        <span class="break-all flex-1">${n.url}</span>
        <span class="text-xs text-zinc-500 font-mono bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 rounded">${n.errorMessage}</span>
      </div>`;
    }).join('') || '<div class="p-4 text-center text-xs text-zinc-600 font-mono">No network request errors logged.</div>';

    return `
    <!DOCTYPE html>
    <html lang="en" class="h-full">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AutoQA Report - ${s.runId}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Outfit', sans-serif;
        }
        pre, code {
          font-family: 'JetBrains Mono', monospace;
        }
        .glow {
          box-shadow: 0 0 50px -12px rgba(168, 85, 247, 0.25);
        }
      </style>
    </head>
    <body class="bg-zinc-950 text-zinc-100 min-h-full flex flex-col antialiased">
      
      <!-- Top Glow Effect -->
      <div class="fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-96 bg-purple-500/10 blur-[120px] rounded-full pointer-events-none -z-10"></div>
      
      <header class="border-b border-zinc-800/80 bg-zinc-900/30 backdrop-blur-md sticky top-0 z-50">
        <div class="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="h-8 w-8 rounded-lg bg-gradient-to-tr from-violet-600 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-violet-500/20">A</span>
            <div>
              <h1 class="text-lg font-bold bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent">AutoQA</h1>
              <p class="text-[10px] text-zinc-500 font-medium uppercase tracking-widest mt-0.5">Automated Quality Assurance Platform</p>
            </div>
          </div>
          <div class="flex items-center gap-4">
            <span class="text-xs text-zinc-400 font-mono bg-zinc-900/80 border border-zinc-800/60 px-3 py-1.5 rounded-lg select-all">Run ID: ${s.runId}</span>
            <a href="/" class="text-xs text-zinc-400 hover:text-white px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-900 transition-colors">Back to app</a>
          </div>
        </div>
      </header>

      <main class="max-w-7xl mx-auto px-6 py-10 flex-1 w-full grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        <!-- Main Panel: Steps -->
        <div class="lg:col-span-2 flex flex-col gap-6">
          <div class="flex items-center justify-between border-b border-zinc-800/60 pb-4">
            <h2 class="text-xl font-bold text-white">Execution Steps</h2>
            <div class="flex items-center gap-2">
              <span class="text-xs text-zinc-500">Run URL:</span>
              <a href="${s.url}" target="_blank" class="text-xs text-violet-400 hover:underline flex items-center gap-1">${s.url} ↗</a>
            </div>
          </div>
          
          <div class="flex flex-col gap-4">
            ${stepsHtml}
          </div>
        </div>

        <!-- Sidebar: Summary & Logs -->
        <div class="flex flex-col gap-6">
          
          <!-- Summary Card -->
          <div class="border border-zinc-800 rounded-2xl bg-zinc-900/30 backdrop-blur-md p-6 glow relative overflow-hidden">
            <div class="absolute top-0 right-0 h-32 w-32 bg-violet-600/5 blur-[50px] rounded-full pointer-events-none"></div>
            
            <h3 class="text-sm font-semibold uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-3 mb-4">Run Summary</h3>
            
            <div class="flex flex-col gap-4">
              <div class="flex items-center justify-between">
                <span class="text-sm text-zinc-500">Status</span>
                <span class="px-3 py-1 rounded-full text-xs font-bold ${
                  s.status === 'passed' 
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                    : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                }">${s.status.toUpperCase()}</span>
              </div>
              
              <div class="flex items-center justify-between">
                <span class="text-sm text-zinc-500">Total Steps</span>
                <span class="text-sm font-semibold text-white font-mono">${s.totalSteps}</span>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm text-zinc-500">Passed</span>
                <span class="text-sm font-semibold text-emerald-400 font-mono">${s.passedSteps}</span>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm text-zinc-500">Failed</span>
                <span class="text-sm font-semibold text-rose-400 font-mono">${s.failedSteps}</span>
              </div>

              <div class="flex items-center justify-between border-t border-zinc-800/60 pt-3">
                <span class="text-sm text-zinc-500">Duration</span>
                <span class="text-sm font-semibold text-zinc-300 font-mono">${(s.durationMs / 1000).toFixed(2)}s</span>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-sm text-zinc-500">Date</span>
                <span class="text-xs text-zinc-400 font-mono">${new Date(s.timestamp).toLocaleString()}</span>
              </div>
            </div>
          </div>

          <!-- Console log output -->
          <div class="border border-zinc-800 rounded-2xl bg-zinc-900/20 backdrop-blur-md overflow-hidden flex flex-col h-[320px]">
            <div class="bg-zinc-900/60 border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
              <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Console Output</h3>
              <span class="text-[10px] bg-zinc-800 px-2 py-0.5 rounded text-zinc-500 font-mono">${d.consoleLogs.length} logs</span>
            </div>
            <div class="overflow-y-auto flex-1 bg-zinc-950/80">
              ${consoleHtml}
            </div>
          </div>

          <!-- Network log output -->
          <div class="border border-zinc-800 rounded-2xl bg-zinc-900/20 backdrop-blur-md overflow-hidden flex flex-col h-[280px]">
            <div class="bg-zinc-900/60 border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
              <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Network Failures</h3>
              <span class="text-[10px] bg-zinc-800 px-2 py-0.5 rounded text-zinc-500 font-mono">${d.networkErrors.length} failed</span>
            </div>
            <div class="overflow-y-auto flex-1 bg-zinc-950/80">
              ${networkHtml}
            </div>
          </div>

        </div>

      </main>

      <footer class="border-t border-zinc-900 bg-zinc-950 py-8 mt-12">
        <div class="max-w-7xl mx-auto px-6 text-center text-xs text-zinc-600">
          <p>© 2026 AutoQA Framework. Generative Playwright Orchestration Platform.</p>
        </div>
      </footer>

    </body>
    </html>
    `;
  }
}
