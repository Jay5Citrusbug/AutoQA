'use client';

import React from 'react';
import { CheckCircle2, XCircle, FileJson, FileCode, Clock, Clipboard, ClipboardCheck, ArrowUpRight } from 'lucide-react';
import { ExecutionContext } from '@/types/execution';

interface ResultCardProps {
  context: ExecutionContext;
}

export default function ResultCard({ context }: ResultCardProps) {
  const [copied, setCopied] = React.useState(false);

  const total = context.stepResults.length;
  const passed = context.stepResults.filter((s) => s.status === 'passed').length;
  const failed = context.stepResults.filter((s) => s.status === 'failed').length;
  const isSuccess = failed === 0;

  const handleCopyScriptPath = () => {
    if (!context.generatedScriptPath) return;
    navigator.clipboard.writeText(context.generatedScriptPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="border border-border rounded-2xl bg-zinc-900/30 backdrop-blur-md overflow-hidden flex flex-col glow relative">
      <div className="absolute top-0 right-0 h-32 w-32 bg-purple-500/5 blur-[50px] rounded-full pointer-events-none"></div>

      {/* Result Status Header banner */}
      <div className={`px-6 py-5 flex items-center justify-between border-b ${
        isSuccess ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-rose-500/5 border-rose-500/10'
      }`}>
        <div className="flex items-center gap-3">
          {isSuccess ? (
            <CheckCircle2 className="h-6 w-6 text-emerald-400" />
          ) : (
            <XCircle className="h-6 w-6 text-rose-400" />
          )}
          <div>
            <h3 className="text-base font-bold text-white">
              {isSuccess ? 'Execution Passed' : 'Execution Failed'}
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">Run Completed at {new Date(context.endTime || '').toLocaleTimeString()}</p>
          </div>
        </div>
        
        <span className={`px-3 py-1 rounded-full text-xs font-bold ${
          isSuccess 
            ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' 
            : 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
        }`}>
          {isSuccess ? 'PASSED' : 'FAILED'}
        </span>
      </div>

      <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Run Metrics Stats */}
        <div className="flex flex-col gap-4 border-r border-zinc-900 pr-6">
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500">Run Metrics</h4>
          
          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center text-sm">
              <span className="text-zinc-500">Total Steps</span>
              <span className="font-semibold text-white font-mono">{total}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-zinc-500">Passed</span>
              <span className="font-semibold text-emerald-400 font-mono">{passed}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-zinc-500">Failed</span>
              <span className="font-semibold text-rose-400 font-mono">{failed}</span>
            </div>
            <div className="flex justify-between items-center text-sm border-t border-zinc-900 pt-2.5">
              <span className="text-zinc-500 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-zinc-500" />
                Duration
              </span>
              <span className="font-semibold text-zinc-300 font-mono">
                {((context.durationMs || 0) / 1000).toFixed(2)}s
              </span>
            </div>
          </div>
        </div>

        {/* Action Triggers / Assets links */}
        <div className="flex flex-col gap-4 border-r border-zinc-900 px-0 md:px-6">
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500">Execution Artifacts</h4>
          
          <div className="flex flex-col gap-2.5">
            {/* Direct Dashboard report viewer link */}
            <a
              href={`/reports/${context.runId}`}
              target="_blank"
              className="flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 hover:border-zinc-700 text-xs font-semibold text-white hover:text-white transition-all"
            >
              <span className="flex items-center gap-2">
                <FileJson className="h-4 w-4 text-purple-400" />
                Dynamic Report Dashboard
              </span>
              <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500" />
            </a>

            {/* Static HTML Report download link */}
            <a
              href={`/reports/${context.runId}.html`}
              target="_blank"
              className="flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 hover:border-zinc-700 text-xs font-semibold text-white hover:text-white transition-all"
            >
              <span className="flex items-center gap-2">
                <FileCode className="h-4 w-4 text-indigo-400" />
                Standalone HTML Report
              </span>
              <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500" />
            </a>

            {/* Script Asset downloader */}
            {context.generatedScriptPath && (
              <a
                href={context.generatedScriptPath}
                download
                className="flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-purple-500/20 bg-purple-500/5 hover:bg-purple-500/10 text-xs font-semibold text-purple-400 transition-all cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-purple-400" />
                  Download Playwright Spec
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 text-purple-400" />
              </a>
            )}
          </div>
        </div>

        {/* Playwright Script Telemetry details */}
        <div className="flex flex-col gap-4 pl-0 md:pl-6">
          <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500">Spec File Metadata</h4>
          
          <div className="flex flex-col gap-2.5">
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              AutoQA successfully built a clean Playwright TypeScript spec simulating steps with high accuracy.
            </p>
            {context.generatedScriptPath && (
              <div className="flex items-center justify-between gap-2 border border-zinc-900 bg-zinc-950 p-2.5 rounded-xl font-mono text-[10px] text-zinc-400 border border-zinc-800">
                <span className="truncate flex-1 select-all">{context.generatedScriptPath.split('/').pop()}</span>
                <button
                  type="button"
                  onClick={handleCopyScriptPath}
                  className="p-1.5 rounded bg-zinc-900 hover:bg-zinc-850 text-zinc-400 hover:text-white transition-all"
                >
                  {copied ? <ClipboardCheck className="h-3.5 w-3.5 text-emerald-400" /> : <Clipboard className="h-3.5 w-3.5" />}
                </button>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
