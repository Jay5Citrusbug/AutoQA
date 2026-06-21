'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { 
  History, ClipboardList, CheckCircle, XCircle, Clock, Search, 
  Eye, RefreshCw, Layers, ArrowUpRight, CheckCircle2, X
} from 'lucide-react';
import { MvpExecution, StepExecution } from '@/types/mvp';
import SafeFormattedDate from '@/components/SafeFormattedDate';

export default function ExecutionsPage() {
  const [runs, setRuns] = useState<MvpExecution[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedAuditRun, setSelectedAuditRun] = useState<MvpExecution | null>(null);

  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [comparisonData, setComparisonData] = useState<{runA: MvpExecution, runB: MvpExecution} | null>(null);
  const [isComparing, setIsComparing] = useState(false);

  const handleToggleSelectRun = (id: string) => {
    setSelectedRunIds(prev => 
      prev.includes(id) 
        ? prev.filter(x => x !== id) 
        : prev.length < 2 
          ? [...prev, id]
          : [prev[1], id]
    );
  };

  const handleOpenComparison = async () => {
    if (selectedRunIds.length !== 2) return;
    try {
      setIsComparing(true);
      const [resA, resB] = await Promise.all([
        fetch(`/api/reports?runId=${selectedRunIds[0]}`),
        fetch(`/api/reports?runId=${selectedRunIds[1]}`)
      ]);
      if (!resA.ok || !resB.ok) throw new Error('Failed to fetch run details for comparison.');
      const [dataA, dataB] = await Promise.all([resA.json(), resB.json()]);

      const runAObj = runs.find(r => r.id === selectedRunIds[0])!;
      const runBObj = runs.find(r => r.id === selectedRunIds[1])!;

      const detailedRunA: MvpExecution = {
        ...runAObj,
        steps: dataA.details.stepResults.map((s: any) => ({
          stepIndex: s.stepIndex,
          rawText: s.step.rawText,
          status: s.status,
          durationMs: s.durationMs,
          error: s.error,
        }))
      };

      const detailedRunB: MvpExecution = {
        ...runBObj,
        steps: dataB.details.stepResults.map((s: any) => ({
          stepIndex: s.stepIndex,
          rawText: s.step.rawText,
          status: s.status,
          durationMs: s.durationMs,
          error: s.error,
        }))
      };

      setComparisonData({ runA: detailedRunA, runB: detailedRunB });
    } catch (err: any) {
      alert(err.message || 'Error loading comparison reports');
      setIsComparing(false);
    }
  };

  // Fetch runs on mount
  React.useEffect(() => {
    const fetchRuns = async () => {
      try {
        setIsLoading(true);
        const res = await fetch('/api/reports');
        if (!res.ok) throw new Error('Failed to load executions history.');
        const data = await res.json();
        
        // Map ReportSummary to MvpExecution list format
        const mappedRuns: MvpExecution[] = data.map((r: any) => ({
          id: r.runId,
          appName: r.appName || r.title || 'AutoQA Target',
          moduleName: r.moduleName || 'Default Flow',
          url: r.url,
          type: 'Functional', 
          status: r.status,
          durationMs: r.durationMs,
          timestamp: r.timestamp,
          stepsCount: r.totalSteps,
          passedCount: r.passedSteps,
          failedCount: r.failedSteps,
          config: { generateScript: true, captureScreenshots: true, captureConsoleLogs: true, captureNetworkLogs: true, headless: true },
          steps: [] 
        }));
        
        setRuns(mappedRuns);
      } catch (err: any) {
        setApiError(err?.message || 'Error connecting to API');
      } finally {
        setIsLoading(false);
      }
    };
    fetchRuns();
  }, []);

  const handleOpenAudit = async (run: MvpExecution) => {
    try {
      const res = await fetch(`/api/reports?runId=${run.id}`);
      if (!res.ok) throw new Error('Execution detail not found');
      const data = await res.json();
      
      const detailedRun: MvpExecution = {
        ...run,
        steps: data.details.stepResults.map((s: any) => ({
          stepIndex: s.stepIndex,
          rawText: s.step.rawText,
          status: s.status,
          durationMs: s.durationMs,
          error: s.error,
          expectedResult: s.status === 'failed' ? 'Assertion verify target element text visible.' : undefined,
          actualResult: s.error ? s.error : undefined,
        }))
      };
      
      setSelectedAuditRun(detailedRun);
    } catch (err: any) {
      alert('Failed to load audit steps: ' + err.message);
    }
  };

  const filteredRuns = runs.filter((r) => {
    return r.appName.toLowerCase().includes(searchTerm.toLowerCase()) ||
           r.moduleName.toLowerCase().includes(searchTerm.toLowerCase()) ||
           r.url.toLowerCase().includes(searchTerm.toLowerCase());
  });

  return (
    <div className="flex flex-col gap-8 w-full py-2 relative animate-fade-in">
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white flex items-center gap-2.5">
          <History className="h-8 w-8 text-purple-400" />
          Test Suite Executions
        </h2>
        <p className="text-base sm:text-lg text-zinc-400 mt-2">Audit previous browser runs, validation outcomes, and detailed step timelines.</p>
      </div>


      {/* Filter toolbar & Comparison Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 w-full">
        <div className="relative max-w-xl w-full">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-zinc-500">
            <Search className="h-4.5 w-4.5" />
          </div>
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search by app, module context, or url..."
            className="w-full pl-11 pr-4 py-3.5 bg-zinc-900 border border-zinc-800 rounded-xl text-sm sm:text-base text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
          />
        </div>

        {selectedRunIds.length === 2 && (
          <button
            type="button"
            onClick={handleOpenComparison}
            className="px-5 py-3.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-sm sm:text-base flex items-center gap-1.5 transition-all shadow-lg shadow-purple-500/20 cursor-pointer self-stretch sm:self-auto text-center justify-center shrink-0"
          >
            Compare Selected Runs
          </button>
        )}
      </div>

      {/* Table grid */}
      <div className="border border-zinc-800 rounded-2xl bg-zinc-900/10 backdrop-blur-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-800/60 bg-zinc-900/40 text-xs sm:text-sm font-bold text-zinc-500 uppercase tracking-widest">
                <th className="px-6 py-4 w-12 text-center">Compare</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Target Application</th>
                <th className="px-6 py-4">Execution Type</th>
                <th className="px-6 py-4">Run Duration</th>
                <th className="px-6 py-4">Date Completed</th>
                <th className="px-6 py-4 text-right">Details Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/50 text-sm sm:text-base font-semibold text-zinc-300">
              {filteredRuns.map((run) => {
                const isPass = run.status === 'passed';
                return (
                  <tr key={run.id} className="hover:bg-zinc-900/10 transition-colors">
                    <td className="px-6 py-4 text-center">
                      <input 
                        type="checkbox"
                        checked={selectedRunIds.includes(run.id)}
                        onChange={() => handleToggleSelectRun(run.id)}
                        className="h-4.5 w-4.5 accent-purple-500 rounded border-zinc-700 bg-zinc-950 focus:ring-0 cursor-pointer"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-bold ${
                        isPass 
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/15' 
                          : 'bg-rose-500/10 text-rose-400 border border-rose-500/15'
                      }`}>
                        {isPass ? <CheckCircle className="h-4.5 w-4.5" /> : <XCircle className="h-4.5 w-4.5" />}
                        {run.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-6 py-4 max-w-xs">
                      <div className="font-bold text-white truncate">{run.appName}</div>
                      <div className="text-xs sm:text-sm text-zinc-500 truncate mt-1">{run.moduleName}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-zinc-400">{run.type}</td>
                    <td className="px-6 py-4 font-mono text-zinc-500">{(run.durationMs / 1000).toFixed(2)}s</td>
                    <td className="px-6 py-4 text-zinc-555 font-mono"><SafeFormattedDate value={run.timestamp} /></td>
                    <td className="px-6 py-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleOpenAudit(run)}
                        className="text-xs sm:text-sm font-bold text-purple-400 hover:text-purple-300 inline-flex items-center gap-1.5 border border-purple-500/10 bg-purple-500/5 px-3.5 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        Audit Details
                        <ArrowUpRight className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dynamic Results audit screen overlay panel */}
      {selectedAuditRun && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="relative w-full max-w-3xl bg-zinc-950 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col p-6 max-h-[85vh] animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 mb-4">
              <div className="flex items-center gap-3">
                <History className="h-6 w-6 text-purple-400" />
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-white truncate max-w-[320px]">{selectedAuditRun.appName}</h3>
                  <p className="text-xs sm:text-sm text-zinc-500 font-mono mt-0.5">{selectedAuditRun.moduleName} | {selectedAuditRun.url}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAuditRun(null)}
                className="h-8.5 w-8.5 rounded-lg hover:bg-zinc-900 border border-zinc-850 flex items-center justify-center text-zinc-500 hover:text-white transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Run summary statistics */}
            <div className="grid grid-cols-4 gap-4 mb-5">
              {[
                { label: 'Status', val: selectedAuditRun.status.toUpperCase(), isB: true },
                { label: 'Total Steps', val: selectedAuditRun.stepsCount },
                { label: 'Duration', val: `${(selectedAuditRun.durationMs / 1000).toFixed(2)}s` },
                { label: 'Type', val: selectedAuditRun.type },
              ].map((c, idx) => (
                <div key={idx} className="bg-zinc-900/40 border border-zinc-900 rounded-xl p-3.5 text-center flex flex-col gap-1">
                  <span className="text-xs sm:text-sm text-zinc-500 font-bold uppercase">{c.label}</span>
                  <span className={`text-sm sm:text-base font-bold font-mono ${c.isB ? selectedAuditRun.status === 'passed' ? 'text-emerald-400' : 'text-rose-400' : 'text-white'}`}>{c.val}</span>
                </div>
              ))}
            </div>

            {/* Steps audit lists */}
            <div className="overflow-y-auto flex-1 flex flex-col gap-3 max-h-[50vh] pr-1">
              {selectedAuditRun.steps.length > 0 ? (
                selectedAuditRun.steps.map((st) => (
                  <div key={st.stepIndex} className="border border-zinc-900 bg-zinc-900/10 p-4 rounded-xl flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span className="h-7 w-7 rounded bg-zinc-950 border border-zinc-900 flex items-center justify-center font-mono text-xs sm:text-sm text-zinc-400">{st.stepIndex}</span>
                        <span className="text-sm sm:text-base font-semibold text-zinc-200">{st.rawText}</span>
                      </div>
                      <span className={`text-xs sm:text-sm font-bold px-3 py-1 rounded ${
                        st.status === 'passed'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : st.status === 'skipped'
                            ? 'bg-zinc-500/10 text-zinc-400 border border-zinc-800'
                            : 'bg-rose-500/10 text-rose-400'
                      }`}>
                        {st.status.toUpperCase()}
                      </span>
                    </div>

                    {st.error && (
                      <div className="bg-rose-500/5 border border-rose-500/10 p-3 rounded-lg text-xs sm:text-sm font-mono text-rose-400 leading-normal">
                        {st.error}
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="p-8 text-center text-zinc-650 text-sm sm:text-base font-medium">
                  Detailed step results are only stored for runs with evidence capture flags active.
                </div>
              )}
            </div>

            {/* Bottom Actions footer */}
            <div className="flex items-center justify-end border-t border-zinc-900 pt-4 mt-4">
              <button
                type="button"
                onClick={() => setSelectedAuditRun(null)}
                className="px-5 py-3 border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-300 hover:text-white rounded-xl font-bold text-xs sm:text-sm transition-all cursor-pointer"
              >
                Close Audit Screen
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Comparison results dashboard side-by-side overlay */}
      {comparisonData && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="relative w-full max-w-5xl bg-zinc-950 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col p-6 max-h-[90vh] animate-fade-in text-[#f9fafb]">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 mb-5">
              <div className="flex items-center gap-3">
                <RefreshCw className="h-6 w-6 text-purple-400 animate-spin" style={{ animationDuration: '3s' }} />
                <div>
                  <h3 className="text-lg font-bold text-white">Side-by-Side Run Comparison</h3>
                  <p className="text-xs sm:text-sm text-zinc-550">Analyzing deltas, outcomes, and execution speed.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setComparisonData(null);
                  setIsComparing(false);
                  setSelectedRunIds([]);
                }}
                className="h-8.5 w-8.5 rounded-lg hover:bg-zinc-900 border border-zinc-850 flex items-center justify-center text-zinc-500 hover:text-white transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Run summary grid comparison */}
            <div className="grid grid-cols-3 gap-6 mb-6">
              {/* Run A column */}
              <div className="bg-zinc-900/30 border border-zinc-900 p-4 rounded-2xl flex flex-col gap-2">
                <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Run A (First Selection)</span>
                <h4 className="font-extrabold text-white text-base truncate">{comparisonData.runA.appName}</h4>
                <p className="text-xs text-zinc-550 truncate font-mono">{comparisonData.runA.id.slice(0, 8)} • {comparisonData.runA.browser}</p>
                <div className="mt-2 flex justify-between items-center text-xs font-mono">
                  <span className="text-zinc-500">Duration:</span>
                  <span className="text-purple-400 font-bold">{(comparisonData.runA.durationMs / 1000).toFixed(2)}s</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-zinc-500">Status:</span>
                  <span className={comparisonData.runA.status === 'passed' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {comparisonData.runA.status.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* Speed Delta Comparison card */}
              <div className="bg-purple-950/10 border border-purple-900/20 p-4 rounded-2xl flex flex-col justify-center items-center text-center gap-2">
                <span className="text-xs font-bold text-purple-400 uppercase tracking-widest">Duration Delta</span>
                {(() => {
                  const diff = comparisonData.runA.durationMs - comparisonData.runB.durationMs;
                  const absDiff = Math.abs(diff) / 1000;
                  if (diff > 0) {
                    return (
                      <>
                        <span className="text-2xl font-black text-emerald-400 font-mono">-{absDiff.toFixed(2)}s</span>
                        <span className="text-[11px] text-zinc-400 leading-normal max-w-[180px]">
                          Run B executed faster than Run A
                        </span>
                      </>
                    );
                  } else if (diff < 0) {
                    return (
                      <>
                        <span className="text-2xl font-black text-emerald-450 font-mono">+{absDiff.toFixed(2)}s</span>
                        <span className="text-[11px] text-zinc-400 leading-normal max-w-[180px]">
                          Run A executed faster than Run B
                        </span>
                      </>
                    );
                  } else {
                    return (
                      <>
                        <span className="text-2xl font-black text-white font-mono">0.00s</span>
                        <span className="text-[11px] text-zinc-400">Both runs took exactly same time</span>
                      </>
                    );
                  }
                })()}
              </div>

              {/* Run B column */}
              <div className="bg-zinc-900/30 border border-zinc-900 p-4 rounded-2xl flex flex-col gap-2">
                <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Run B (Second Selection)</span>
                <h4 className="font-extrabold text-white text-base truncate">{comparisonData.runB.appName}</h4>
                <p className="text-xs text-zinc-550 truncate font-mono">{comparisonData.runB.id.slice(0, 8)} • {comparisonData.runB.browser}</p>
                <div className="mt-2 flex justify-between items-center text-xs font-mono">
                  <span className="text-zinc-500">Duration:</span>
                  <span className="text-purple-400 font-bold">{(comparisonData.runB.durationMs / 1000).toFixed(2)}s</span>
                </div>
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-zinc-500">Status:</span>
                  <span className={comparisonData.runB.status === 'passed' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                    {comparisonData.runB.status.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>

            {/* Steps Comparison Lists */}
            <div className="flex-grow overflow-y-auto border border-zinc-900 rounded-2xl bg-zinc-950 flex flex-col max-h-[45vh] mb-5">
              <div className="grid grid-cols-12 text-xs font-bold text-zinc-500 bg-zinc-900/40 border-b border-zinc-900 py-3 px-4 font-mono uppercase tracking-wider sticky top-0 z-10">
                <div className="col-span-1 text-center">Step</div>
                <div className="col-span-5 px-3">Run A Steps Details</div>
                <div className="col-span-1 text-center">Outcome</div>
                <div className="col-span-5 px-3 border-l border-zinc-900">Run B Steps Details</div>
              </div>

              <div className="divide-y divide-zinc-900/60 overflow-y-auto flex-1">
                {(() => {
                  const maxSteps = Math.max(comparisonData.runA.steps.length, comparisonData.runB.steps.length);
                  if (maxSteps === 0) {
                    return <div className="p-8 text-center text-zinc-650 text-sm">No detailed steps saved for these runs.</div>;
                  }

                  return Array.from({ length: maxSteps }).map((_, idx) => {
                    const stepA = comparisonData.runA.steps[idx];
                    const stepB = comparisonData.runB.steps[idx];

                    return (
                      <div key={idx} className="grid grid-cols-12 items-start py-3.5 px-4 text-xs sm:text-sm font-semibold hover:bg-zinc-900/10">
                        {/* Index */}
                        <div className="col-span-1 text-center font-mono">
                          <span className="h-6 w-6 rounded bg-zinc-900 border border-zinc-800 flex items-center justify-center font-mono text-[10px] text-zinc-550 mx-auto mt-0.5">
                            {idx + 1}
                          </span>
                        </div>

                        {/* Run A Step */}
                        <div className="col-span-5 px-3 flex flex-col gap-1">
                          {stepA ? (
                            <>
                              <span className="text-zinc-300 font-medium leading-normal">{stepA.rawText}</span>
                              <span className="text-[10px] text-zinc-500 font-mono mt-0.5">Duration: {stepA.durationMs}ms</span>
                              {stepA.error && (
                                <span className="text-[10px] text-rose-400 font-mono leading-normal bg-rose-500/5 px-2 py-1 rounded border border-rose-500/10 mt-1">{stepA.error}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-zinc-700 italic">No corresponding step</span>
                          )}
                        </div>

                        {/* Outcome comparison */}
                        <div className="col-span-1 text-center flex flex-col gap-1.5 justify-center items-center font-mono text-[10px]">
                          <span className={`px-2 py-0.5 rounded font-bold uppercase ${
                            stepA ? stepA.status === 'passed' ? 'text-emerald-400 bg-emerald-500/5' : stepA.status === 'skipped' ? 'text-zinc-500' : 'text-rose-400 bg-rose-500/5' : 'text-zinc-700'
                          }`}>
                            {stepA ? stepA.status === 'passed' ? 'PASS' : stepA.status === 'skipped' ? 'SKIP' : 'FAIL' : '—'}
                          </span>
                          <span className="text-zinc-650">vs</span>
                          <span className={`px-2 py-0.5 rounded font-bold uppercase ${
                            stepB ? stepB.status === 'passed' ? 'text-emerald-400 bg-emerald-500/5' : stepB.status === 'skipped' ? 'text-zinc-500' : 'text-rose-400 bg-rose-500/5' : 'text-zinc-700'
                          }`}>
                            {stepB ? stepB.status === 'passed' ? 'PASS' : stepB.status === 'skipped' ? 'SKIP' : 'FAIL' : '—'}
                          </span>
                        </div>

                        {/* Run B Step */}
                        <div className="col-span-5 px-3 border-l border-zinc-900 flex flex-col gap-1">
                          {stepB ? (
                            <>
                              <span className="text-zinc-300 font-medium leading-normal">{stepB.rawText}</span>
                              <span className="text-[10px] text-zinc-500 font-mono mt-0.5">Duration: {stepB.durationMs}ms</span>
                              {stepB.error && (
                                <span className="text-[10px] text-rose-400 font-mono leading-normal bg-rose-500/5 px-2 py-1 rounded border border-rose-500/10 mt-1">{stepB.error}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-zinc-700 italic">No corresponding step</span>
                          )}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>

            {/* Actions footer */}
            <div className="flex items-center justify-end border-t border-zinc-900 pt-4 mt-auto">
              <button
                type="button"
                onClick={() => {
                  setComparisonData(null);
                  setIsComparing(false);
                  setSelectedRunIds([]);
                }}
                className="px-6 py-3.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-bold text-xs sm:text-sm transition-all shadow-md cursor-pointer"
              >
                Close Comparison
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
