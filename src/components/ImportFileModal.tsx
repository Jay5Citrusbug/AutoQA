'use client';

import React, { useState, useRef, useCallback } from 'react';
import {
  Upload,
  X,
  FileText,
  AlertCircle,
  CheckCircle,
  ChevronRight,
  Download,
  Table,
  Trash2,
  PlayCircle,
  FileSpreadsheet,
  Info,
  ArrowUpDown,
} from 'lucide-react';
import {
  parseTestCaseFile,
  testCasesToStepsText,
  generateCSVTemplate,
  ImportedTestCase,
  ParseResult,
} from '@/utils/fileImportParser';
import { ExecutionType } from '@/types/mvp';

interface ImportFileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (params: {
    stepsText: string;
    url: string;
    appName: string;
    moduleName: string;
    execType: ExecutionType;
    testCases: ImportedTestCase[];
  }) => void;
}

type ModalState = 'upload' | 'preview' | 'error';

export function ImportFileModal({ isOpen, onClose, onImport }: ImportFileModalProps) {
  const [modalState, setModalState] = useState<ModalState>('upload');
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = () => {
    setModalState('upload');
    setFileName('');
    setParseResult(null);
    setIsLoading(false);
    setIsDragging(false);
    setExpandedRow(null);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const processFile = useCallback(async (file: File) => {
    setIsLoading(true);
    setFileName(file.name);
    try {
      const result = await parseTestCaseFile(file);
      setParseResult(result);
      if (result.testCases.length > 0) {
        setModalState('preview');
      } else {
        setModalState('error');
      }
    } catch (err: any) {
      setParseResult({
        testCases: [],
        errors: [err?.message || 'An unexpected error occurred while parsing the file.'],
      });
      setModalState('error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDownloadTemplate = () => {
    const csv = generateCSVTemplate();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autoqa_test_cases_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportAndRun = () => {
    if (!parseResult || parseResult.testCases.length === 0) return;

    const tcs = parseResult.testCases;
    const stepsText = testCasesToStepsText(tcs);

    // Use first TC's metadata as batch defaults
    const firstTc = tcs[0];
    const url = firstTc.url;
    const appName = firstTc.appName || 'AutoQA Target';
    const moduleName = firstTc.moduleName || 'Imported Suite';
    const execType: ExecutionType = firstTc.execType || 'Functional';

    onImport({ stepsText, url, appName, moduleName, execType, testCases: tcs });
    handleClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col bg-[#0c1120] border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-800 bg-[#101524] shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-blue-600/15 border border-blue-500/30 flex items-center justify-center">
              <FileSpreadsheet className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Import Test Cases</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Upload a CSV or XLSX file to run multiple test cases in sequence</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="h-8 w-8 rounded-lg bg-zinc-800/60 hover:bg-zinc-700 text-zinc-400 hover:text-white flex items-center justify-center transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* ── UPLOAD STATE ── */}
          {modalState === 'upload' && !isLoading && (
            <div className="flex flex-col gap-6">
              {/* Drop zone */}
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                className={`
                  relative border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center gap-4 cursor-pointer transition-all
                  ${isDragging
                    ? 'border-blue-500 bg-blue-500/5 scale-[1.01]'
                    : 'border-zinc-700 bg-zinc-900/30 hover:border-blue-500/60 hover:bg-blue-500/5'
                  }
                `}
              >
                <div className={`h-16 w-16 rounded-2xl flex items-center justify-center transition-all ${isDragging ? 'bg-blue-500/20' : 'bg-zinc-800'}`}>
                  <Upload className={`h-8 w-8 transition-colors ${isDragging ? 'text-blue-400' : 'text-zinc-500'}`} />
                </div>
                <div className="text-center">
                  <p className="text-base font-bold text-white">
                    {isDragging ? 'Drop your file here' : 'Drag & drop your test file'}
                  </p>
                  <p className="text-sm text-zinc-500 mt-1">
                    or <span className="text-blue-400 font-semibold">click to browse</span> · Accepts .csv, .xlsx, .xls
                  </p>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFileChange}
                  className="hidden"
                  id="import-file-input"
                />
              </div>

              {/* Format guide */}
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5">
                <h3 className="text-sm font-bold text-zinc-300 flex items-center gap-2 mb-3">
                  <Info className="h-4 w-4 text-blue-400" />
                  Required File Format
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="text-left pb-2 pr-4 text-zinc-400 font-bold uppercase tracking-wider">Column</th>
                        <th className="text-left pb-2 pr-4 text-zinc-400 font-bold uppercase tracking-wider">Required</th>
                        <th className="text-left pb-2 text-zinc-400 font-bold uppercase tracking-wider">Description</th>
                      </tr>
                    </thead>
                    <tbody className="text-zinc-400">
                      {[
                        { col: 'tc_id', req: true, desc: 'Test Case ID — controls execution order (TC01, TC02...)' },
                        { col: 'title', req: true, desc: 'Short name for this test case' },
                        { col: 'url', req: true, desc: 'Full URL of the target page (https://...)' },
                        { col: 'steps', req: true, desc: 'Test steps, one per line (use \\n between steps in CSV)' },
                        { col: 'expected_result', req: false, desc: 'Assertion(s) to verify at the end' },
                        { col: 'app_name', req: false, desc: 'Application name' },
                        { col: 'module_name', req: false, desc: 'Module name' },
                        { col: 'exec_type', req: false, desc: 'Functional | Smoke | Regression' },
                      ].map(row => (
                        <tr key={row.col} className="border-b border-zinc-800/50">
                          <td className="py-2 pr-4 font-mono text-white">{row.col}</td>
                          <td className="py-2 pr-4">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${row.req ? 'bg-rose-500/15 text-rose-400' : 'bg-zinc-800 text-zinc-500'}`}>
                              {row.req ? 'Required' : 'Optional'}
                            </span>
                          </td>
                          <td className="py-2">{row.desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Download template button */}
              <button
                onClick={handleDownloadTemplate}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl border border-blue-500/30 bg-blue-500/5 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300 font-semibold text-sm transition-all"
              >
                <Download className="h-4 w-4" />
                Download CSV Template
              </button>
            </div>
          )}

          {/* ── LOADING STATE ── */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="h-12 w-12 rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
                <div className="h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <div className="text-center">
                <p className="text-base font-bold text-white">Parsing file…</p>
                <p className="text-sm text-zinc-500 mt-1">{fileName}</p>
              </div>
            </div>
          )}

          {/* ── PREVIEW STATE ── */}
          {modalState === 'preview' && parseResult && (
            <div className="flex flex-col gap-5">

              {/* Summary strip */}
              <div className="flex items-center justify-between gap-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl px-5 py-3">
                <div className="flex items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-sm font-bold text-white">
                      {parseResult.testCases.length} test case{parseResult.testCases.length !== 1 ? 's' : ''} ready from <span className="text-zinc-400">{fileName}</span>
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5 flex items-center gap-1">
                      <ArrowUpDown className="h-3 w-3" />
                      Sorted by TC ID · will execute in sequence
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => { resetState(); }}
                  className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Change file
                </button>
              </div>

              {/* Parse warnings */}
              {parseResult.errors.length > 0 && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
                  <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                    <AlertCircle className="h-3.5 w-3.5" />
                    Warnings ({parseResult.errors.length})
                  </h4>
                  <ul className="flex flex-col gap-1">
                    {parseResult.errors.map((err, i) => (
                      <li key={i} className="text-xs text-amber-300/80 font-mono">{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Preview table */}
              <div className="border border-zinc-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-zinc-900/60 border-b border-zinc-800 flex items-center gap-2">
                  <Table className="h-4 w-4 text-zinc-500" />
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Test Case Preview</span>
                </div>
                <div className="divide-y divide-zinc-800/60">
                  {parseResult.testCases.map((tc, idx) => {
                    const stepLines = tc.steps.split('\n').filter(Boolean);
                    const isExpanded = expandedRow === tc.tcId;
                    return (
                      <div key={tc.tcId} className="group">
                        <button
                          onClick={() => setExpandedRow(isExpanded ? null : tc.tcId)}
                          className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-zinc-800/30 transition-colors text-left"
                        >
                          {/* Execution order badge */}
                          <div className="h-6 w-6 rounded-lg bg-blue-600/15 border border-blue-500/30 text-blue-400 text-[10px] font-black flex items-center justify-center shrink-0">
                            {idx + 1}
                          </div>
                          {/* TC ID */}
                          <span className="text-xs font-mono font-bold text-blue-400 w-12 shrink-0">{tc.tcId}</span>
                          {/* Title */}
                          <span className="text-sm font-semibold text-white flex-1 truncate">{tc.title}</span>
                          {/* Step count */}
                          <span className="text-xs text-zinc-600 shrink-0">{stepLines.length} step{stepLines.length !== 1 ? 's' : ''}</span>
                          {/* URL preview */}
                          <span className="text-xs text-zinc-600 font-mono truncate max-w-40 shrink-0 hidden sm:block">
                            {tc.url.replace(/^https?:\/\//, '')}
                          </span>
                          {/* Exec type badge */}
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold shrink-0 ${
                            tc.execType === 'Smoke' ? 'bg-amber-500/15 text-amber-400' :
                            tc.execType === 'Regression' ? 'bg-purple-500/15 text-purple-400' :
                            'bg-emerald-500/15 text-emerald-400'
                          }`}>
                            {tc.execType || 'Functional'}
                          </span>
                          <ChevronRight className={`h-4 w-4 text-zinc-600 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                        </button>

                        {/* Expanded steps */}
                        {isExpanded && (
                          <div className="px-4 pb-4 bg-zinc-950/30">
                            <div className="border border-zinc-800 rounded-xl overflow-hidden">
                              <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800">
                                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Steps</span>
                              </div>
                              <div className="divide-y divide-zinc-800/40">
                                {stepLines.map((step, si) => (
                                  <div key={si} className="flex items-start gap-3 px-3 py-2">
                                    <span className="text-[10px] font-mono text-zinc-700 w-5 shrink-0 pt-0.5">{si + 1}</span>
                                    <span className="text-xs text-zinc-300 font-mono">{step}</span>
                                  </div>
                                ))}
                                {tc.expectedResult && tc.expectedResult.split('\n').filter(Boolean).map((er, ei) => (
                                  <div key={`er-${ei}`} className="flex items-start gap-3 px-3 py-2 bg-amber-500/5">
                                    <span className="text-[10px] font-mono text-amber-600 w-5 shrink-0 pt-0.5">✓</span>
                                    <span className="text-xs text-amber-300/80 font-mono">{er}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── ERROR STATE ── */}
          {modalState === 'error' && parseResult && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-col items-center text-center py-8 gap-4">
                <div className="h-14 w-14 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
                  <AlertCircle className="h-7 w-7 text-rose-400" />
                </div>
                <div>
                  <p className="text-base font-bold text-white">Could not parse "{fileName}"</p>
                  <p className="text-sm text-zinc-500 mt-1">Fix the issues below and re-upload your file.</p>
                </div>
              </div>

              <div className="bg-rose-500/5 border border-rose-500/20 rounded-xl p-4">
                <h4 className="text-xs font-bold text-rose-400 uppercase tracking-wider flex items-center gap-1.5 mb-3">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Errors ({parseResult.errors.length})
                </h4>
                <ul className="flex flex-col gap-2">
                  {parseResult.errors.map((err, i) => (
                    <li key={i} className="text-xs text-rose-300/80 font-mono bg-rose-500/5 rounded-lg px-3 py-2">{err}</li>
                  ))}
                </ul>
              </div>

              <button
                onClick={resetState}
                className="w-full py-3 rounded-xl border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-600 font-semibold text-sm transition-all flex items-center justify-center gap-2"
              >
                <Upload className="h-4 w-4" />
                Upload Different File
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        {(modalState === 'upload' || modalState === 'preview') && !isLoading && (
          <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-zinc-800 bg-[#101524] shrink-0">
            <button
              onClick={handleClose}
              className="px-5 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-600 font-semibold text-sm transition-all"
            >
              Cancel
            </button>

            {modalState === 'preview' && parseResult && parseResult.testCases.length > 0 && (
              <button
                onClick={handleImportAndRun}
                className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm transition-all shadow-lg shadow-blue-500/20"
              >
                <PlayCircle className="h-4.5 w-4.5" />
                Import &amp; Run {parseResult.testCases.length} Test Case{parseResult.testCases.length !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
