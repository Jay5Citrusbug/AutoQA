'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { History, ClipboardList, CheckCircle, XCircle, ArrowUpRight, Clock, HelpCircle } from 'lucide-react';
import { ReportSummary } from '@/types/report';
import SafeFormattedDate from '@/components/SafeFormattedDate';

export default function HistoryPage() {
  const [runs, setRuns] = useState<ReportSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/api/history')
      .then((res) => res.json())
      .then((data: ReportSummary[]) => {
        setRuns(data || []);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load history list', err);
        setIsLoading(false);
      });
  }, []);

  return (
    <div className="flex flex-col gap-8 max-w-5xl mx-auto py-2">
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-2xl font-bold text-white flex items-center gap-2.5">
          <History className="h-6.5 w-6.5 text-purple-400" />
          Test Run History
        </h2>
        <p className="text-xs text-zinc-500">Track and review past browser executions, pass/fail status, and generated scripts.</p>
      </div>

      {isLoading ? (
        <div className="border border-zinc-900 bg-zinc-900/10 rounded-2xl p-12 text-center text-zinc-500 font-medium">
          Loading execution history records...
        </div>
      ) : runs.length === 0 ? (
        <div className="border border-zinc-900 bg-zinc-900/10 rounded-2xl p-16 text-center flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500">
            <HelpCircle className="h-6 w-6" />
          </div>
          <div>
            <h4 className="font-bold text-white text-sm">No Runs Recorded Yet</h4>
            <p className="text-xs text-zinc-500 mt-1 max-w-sm">Dispatch your first rule-based test execution to populate the database records.</p>
          </div>
          <Link
            href="/run-test"
            className="mt-2 text-xs font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-4 py-2 rounded-xl hover:bg-purple-500/15 transition-all"
          >
            Run First Test Case
          </Link>
        </div>
      ) : (
        <div className="border border-border/80 rounded-2xl bg-zinc-900/10 backdrop-blur-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-900 bg-zinc-900/35 text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Target Application</th>
                  <th className="px-6 py-4">Steps</th>
                  <th className="px-6 py-4">Duration</th>
                  <th className="px-6 py-4">Date Completed</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900/50 text-xs font-medium text-zinc-300">
                {runs.map((run) => (
                  <tr key={run.runId} className="hover:bg-zinc-900/20 transition-all">
                    <td className="px-6 py-4.5">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
                        run.status === 'passed' 
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                          : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      }`}>
                        {run.status === 'passed' ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                        {run.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-6 py-4.5 max-w-xs">
                      <div className="font-semibold text-white truncate">{run.url.replace(/^https?:\/\//i, '')}</div>
                      <div className="text-[10px] text-zinc-500 truncate mt-0.5">{run.url}</div>
                    </td>
                    <td className="px-6 py-4.5 font-mono text-zinc-400">
                      {run.totalSteps} steps ({run.passedSteps} passed)
                    </td>
                    <td className="px-6 py-4.5 font-mono text-zinc-500 flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5" />
                      {((run.durationMs || 0) / 1000).toFixed(2)}s
                    </td>
                    <td className="px-6 py-4.5 text-zinc-500 font-mono">
                      <SafeFormattedDate value={run.timestamp} />
                    </td>
                    <td className="px-6 py-4.5 text-right">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/reports?runId=${run.runId}`}
                          className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-400 bg-purple-500/5 hover:bg-purple-500/10 px-3 py-1.5 rounded-lg border border-purple-500/10 transition-all"
                        >
                          View Report
                          <ArrowUpRight className="h-3 w-3" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
