'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { 
  ClipboardList, Search, Calendar, Cpu, Layers, CheckCircle2, 
  XCircle, Filter, Download, ArrowRight, Eye, RefreshCw, X
} from 'lucide-react';
import { ReportSummary, ReportPayload } from '@/types/report';
import SafeFormattedDate from '@/components/SafeFormattedDate';

export default function ReportsPage() {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);

  // Fetch reports on mount
  React.useEffect(() => {
    const fetchReports = async () => {
      try {
        setIsLoading(true);
        const res = await fetch('/api/reports');
        if (!res.ok) throw new Error('Failed to load reports archive.');
        const data = await res.json();
        setReports(data);
      } catch (err: any) {
        setApiError(err?.message || 'Error connecting to API');
      } finally {
        setIsLoading(false);
      }
    };
    fetchReports();
  }, []);

  // --- FILTER STATES ---
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'passed' | 'failed'>('all');
  const [dateFilter, setDateFilter] = useState('all');

  // Filter application matching rules
  const filteredReports = reports.filter((r) => {
    const titleText = r.appName || r.title || '';
    const matchesSearch = titleText.toLowerCase().includes(searchTerm.toLowerCase()) || r.url.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleDownload = async (runId: string) => {
    try {
      const res = await fetch(`/api/reports?runId=${runId}`);
      if (!res.ok) throw new Error('Failed to download report data.');
      const data = await res.json();
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `autoqa_report_${runId}.json`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Download failed: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-8 w-full py-2 animate-fade-in">
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white flex items-center gap-2.5">
          <ClipboardList className="h-8 w-8 text-purple-400" />
          Execution Reports Archive
        </h2>
        <p className="text-base sm:text-lg text-zinc-400 mt-2">Access and download detailed JSON metrics and standalone HTML dashboard reports.</p>
      </div>

      {/* Filter Toolbar Controls */}
      <div className="border border-zinc-800 bg-zinc-900/10 rounded-2xl p-6 flex flex-col gap-5 backdrop-blur-md">
        <div className="flex items-center gap-2 text-sm sm:text-base font-bold text-zinc-400 uppercase tracking-wider">
          <Filter className="h-5 w-5 text-purple-400" />
          Filter Archive Reports
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {/* Search text input */}
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-zinc-500">
              <Search className="h-4.5 w-4.5" />
            </div>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search by app, url, or test case..."
              className="w-full pl-11 pr-4 py-3.5 bg-zinc-950 border border-zinc-850 rounded-xl text-sm sm:text-base text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500/20"
            />
          </div>

          {/* Status Selection */}
          <div className="flex bg-zinc-950 p-1.5 rounded-xl border border-zinc-850">
            {(['all', 'passed', 'failed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`flex-1 py-2 rounded-lg text-xs sm:text-sm font-bold uppercase transition-all ${
                  statusFilter === s
                    ? 'bg-purple-600 text-white shadow'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Date Selector mockup */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-zinc-500">
              <Calendar className="h-4.5 w-4.5" />
            </div>
            <select
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value)}
              className="w-full pl-11 pr-4 py-3.5 bg-zinc-950 border border-zinc-850 rounded-xl text-sm sm:text-base text-white focus:outline-none focus:border-purple-500 font-medium"
            >
              <option value="all">Any Date (All time)</option>
              <option value="today">Today (Last 24 hours)</option>
              <option value="week">This Week (Last 7 days)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Reports Grid Cards layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {isLoading ? (
          <div className="md:col-span-2 border border-zinc-800 bg-[#101524] rounded-2xl p-20 text-center text-zinc-500 font-semibold text-base flex flex-col items-center justify-center gap-3">
            <RefreshCw className="h-7 w-7 animate-spin text-purple-400" />
            Loading reports archive...
          </div>
        ) : apiError ? (
          <div className="md:col-span-2 border border-rose-500/20 bg-rose-500/5 rounded-2xl p-20 text-center text-rose-400 font-semibold text-base flex flex-col items-center justify-center gap-3">
            <XCircle className="h-7 w-7" />
            {apiError}
          </div>
        ) : filteredReports.length === 0 ? (
          <div className="md:col-span-2 border border-zinc-800 bg-zinc-900/10 rounded-2xl p-20 text-center text-zinc-500 font-semibold text-base flex flex-col items-center justify-center">
            No matching execution reports discovered.
          </div>
        ) : (
          filteredReports.map((report) => {
            const isPass = report.status === 'passed';
            return (
              <div
                key={report.runId}
                className="border border-zinc-800 bg-zinc-900/10 hover:bg-zinc-900/20 hover:border-zinc-700/80 rounded-2xl p-6 flex flex-col justify-between gap-5 transition-all duration-200 group relative overflow-hidden"
              >
                <div className="absolute top-0 right-0 h-28 w-28 bg-purple-500/5 blur-[40px] rounded-full pointer-events-none"></div>

                <div className="flex justify-between items-start gap-4">
                  <div className="flex gap-3">
                    <div className="h-10 w-10 rounded-lg bg-zinc-950 border border-zinc-900 flex items-center justify-center text-purple-400 shrink-0">
                      <ClipboardList className="h-5.5 w-5.5" />
                    </div>
                    <div>
                      <h4 className="font-bold text-white text-base sm:text-lg truncate group-hover:text-purple-400 transition-colors max-w-[280px]">
                        {report.appName && report.moduleName ? `${report.appName} - ${report.moduleName}` : report.title}
                      </h4>
                      <p className="text-xs sm:text-sm text-zinc-500 font-mono mt-0.5"><SafeFormattedDate value={report.timestamp} /></p>
                    </div>
                  </div>

                  <span className={`px-3 py-1 rounded-xl text-xs sm:text-sm font-bold border shrink-0 ${
                    isPass 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/15' 
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/15'
                  }`}>
                    {report.status.toUpperCase()}
                  </span>
                </div>

                <div className="flex items-center justify-between border-t border-zinc-900 pt-4 mt-1 text-xs sm:text-sm font-mono text-zinc-500">
                  <span>{report.totalSteps} steps completed</span>
                  <span className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => handleDownload(report.runId)}
                      className="text-zinc-500 hover:text-white p-1 hover:bg-zinc-900 rounded transition-all"
                    >
                      <Download className="h-4.5 w-4.5" />
                    </button>
                    <Link
                      href={`/run-test?runId=${report.runId}`}
                      className="text-zinc-400 hover:text-white flex items-center gap-1 font-sans font-bold text-xs sm:text-sm"
                    >
                      Audits Report
                      <ArrowRight className="h-4.5 w-4.5 group-hover:translate-x-1 transition-transform text-purple-400" />
                    </Link>
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

    </div>
  );
}
