'use client';

import React from 'react';
import { FileCode, FileText, LayoutList, CheckCircle, AlertOctagon, Terminal, Globe, ChevronRight } from 'lucide-react';
import { ReportPayload } from '@/types/report';
import SafeFormattedDate from './SafeFormattedDate';

interface ReportViewerProps {
  payload: ReportPayload;
}

export default function ReportViewer({ payload }: ReportViewerProps) {
  const [activeTab, setActiveTab] = React.useState<'steps' | 'console' | 'network' | 'script'>('steps');
  const d = payload.details;
  const s = payload.summary;

  const tabs = [
    { id: 'steps', name: 'Steps Details', icon: LayoutList },
    { id: 'console', name: 'Console Messages', icon: Terminal, count: d.consoleLogs.length },
    { id: 'network', name: 'Network Failures', icon: Globe, count: d.networkErrors.length },
  ];

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Header telemetry metadata */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-900 pb-4">
        <div className="flex items-center gap-3">
          <div className={`h-4.5 w-4.5 rounded-full ${s.status === 'passed' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></div>
          <div>
            <h2 className="text-xl font-bold text-white">Report Run Details</h2>
            <p className="text-xs text-zinc-500 font-mono mt-0.5">{s.url} | Completed <SafeFormattedDate value={s.timestamp} /></p>
          </div>
        </div>

        <span className={`px-3 py-1 rounded-full text-xs font-bold ${
          s.status === 'passed' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
        }`}>
          {s.status.toUpperCase()}
        </span>
      </div>

      {/* Tabs navigation */}
      <div className="flex border-b border-zinc-900/60 pb-px gap-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`px-4 py-2 text-xs font-semibold rounded-t-xl transition-all border-b-2 flex items-center gap-2 ${
                isActive
                  ? 'border-purple-500 text-purple-400 bg-purple-500/5'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.name}
              {t.count !== undefined && (
                <span className={`px-1.5 py-0.5 text-[9px] rounded font-mono font-bold ${
                  t.count > 0 
                    ? t.id === 'network' ? 'bg-rose-500/20 text-rose-400' : 'bg-purple-500/20 text-purple-400'
                    : 'bg-zinc-800 text-zinc-650'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Panels */}
      <div className="min-h-[400px]">
        {/* PANEL 1: STEPS */}
        {activeTab === 'steps' && (
          <div className="flex flex-col gap-4">
            {d.stepResults.map((r, idx) => (
              <div key={idx} className="border border-border/80 rounded-xl bg-zinc-900/20 p-5 flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="h-8 w-8 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center font-bold text-zinc-300 text-sm">
                      {r.stepIndex}
                    </span>
                    <div>
                      <p className="font-semibold text-white text-sm">{r.step.rawText}</p>
                      <p className="text-[10px] text-zinc-500 font-mono mt-0.5">Action: {r.step.action || r.step.validation} | Selector Strategy: {r.resolvedSelector ? 'Resolved Scorer' : 'None'}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-zinc-500 font-mono">{r.durationMs}ms</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      r.status === 'passed' 
                        ? 'bg-emerald-500/10 text-emerald-400' 
                        : r.status === 'failed' 
                          ? 'bg-rose-500/10 text-rose-400' 
                          : 'bg-zinc-800 text-zinc-500'
                    }`}>
                      {r.status.toUpperCase()}
                    </span>
                  </div>
                </div>

                {r.error && (
                  <div className="bg-rose-500/10 border border-rose-500/25 p-3 rounded-lg text-xs font-mono text-rose-400">
                    <span className="font-bold">Error:</span> {r.error}
                  </div>
                )}

                {r.resolvedSelector && (
                  <div className="text-[10px] text-zinc-400 bg-zinc-950/80 px-2.5 py-1 rounded border border-zinc-900 font-mono self-start">
                    <span className="text-zinc-600">Locator Selector:</span> {r.resolvedSelector}
                  </div>
                )}

                {r.screenshotPath && (
                  <div className="mt-1 border border-zinc-900 rounded-lg overflow-hidden max-w-sm bg-zinc-950">
                    <p className="text-[9px] text-zinc-600 border-b border-zinc-900 px-3 py-1.5 font-mono uppercase font-bold tracking-wider">Step Screenshot Evidence</p>
                    <a href={r.screenshotPath} target="_blank" className="block hover:opacity-90 transition-opacity">
                      <img src={r.screenshotPath} alt={`Step ${r.stepIndex} screenshot`} className="w-full h-auto object-cover max-h-48" />
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* PANEL 2: CONSOLE LOGS */}
        {activeTab === 'console' && (
          <div className="border border-border/80 rounded-xl bg-zinc-950 overflow-hidden flex flex-col font-mono text-xs">
            <div className="bg-zinc-900/60 border-b border-zinc-900/80 px-4 py-2.5 flex items-center justify-between text-zinc-400">
              <span className="font-semibold text-[10px] tracking-wider uppercase">Console Message Stream</span>
              <span>{d.consoleLogs.length} items</span>
            </div>
            <div className="max-h-[500px] overflow-y-auto">
              {d.consoleLogs.map((l, idx) => {
                const colors = l.type === 'error' ? 'text-rose-400 bg-rose-500/5' : l.type === 'warn' ? 'text-amber-400 bg-amber-500/5' : 'text-zinc-300';
                return (
                  <div key={idx} className={`px-4 py-2 border-b border-zinc-900/30 flex items-start gap-3 ${colors}`}>
                    <span className="text-zinc-600 select-none">[<SafeFormattedDate value={l.timestamp} format="time" />]</span>
                    <span className="font-bold tracking-wider select-none uppercase">[{l.type}]</span>
                    <span className="break-all flex-1">{l.text}</span>
                  </div>
                );
              })}
              {d.consoleLogs.length === 0 && (
                <div className="p-8 text-center text-zinc-600 text-xs">No console outputs recorded.</div>
              )}
            </div>
          </div>
        )}

        {/* PANEL 3: NETWORK ERRORS */}
        {activeTab === 'network' && (
          <div className="border border-border/80 rounded-xl bg-zinc-950 overflow-hidden flex flex-col font-mono text-xs">
            <div className="bg-zinc-900/60 border-b border-zinc-900/80 px-4 py-2.5 flex items-center justify-between text-zinc-400">
              <span className="font-semibold text-[10px] tracking-wider uppercase">Failed Network Telemetry</span>
              <span>{d.networkErrors.length} failures</span>
            </div>
            <div className="max-h-[500px] overflow-y-auto">
              {d.networkErrors.map((n, idx) => (
                <div key={idx} className="px-4 py-3 border-b border-zinc-900/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-rose-400 bg-rose-500/5">
                  <div className="flex items-start gap-3">
                    <span className="text-zinc-600 select-none">[<SafeFormattedDate value={n.timestamp} format="time" />]</span>
                    <span className="font-bold tracking-wider select-none uppercase">[{n.method}]</span>
                    <span className="break-all">{n.url}</span>
                  </div>
                  <span className="text-[10px] font-bold bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded text-zinc-500 self-start shrink-0">{n.errorMessage}</span>
                </div>
              ))}
              {d.networkErrors.length === 0 && (
                <div className="p-8 text-center text-zinc-600 text-xs">No HTTP failures occurred during browser runs.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
