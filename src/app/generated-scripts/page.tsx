'use client';

import React, { useState } from 'react';
import { 
  FileTerminal, Download, Eye, Calendar, Layers, Cpu, Search, 
  Terminal, X, Copy, Check, FileCode, CheckCircle2
} from 'lucide-react';
import { GeneratedScript } from '@/types/mvp';

export default function GeneratedScriptsPage() {
  const [scripts, setScripts] = useState<GeneratedScript[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activePreviewScript, setActivePreviewScript] = useState<GeneratedScript | null>(null);
  const [copied, setCopied] = useState(false);

  // Fetch scripts on mount
  React.useEffect(() => {
    const fetchScripts = async () => {
      try {
        setIsLoading(true);
        const res = await fetch('/api/scripts');
        if (!res.ok) throw new Error('Failed to load generated spec files.');
        const data = await res.json();
        
        // Map elements
        const mappedScripts: GeneratedScript[] = data.map((s: any) => ({
          id: s.id,
          scriptName: s.scriptName,
          moduleName: s.moduleName || 'Execution Scenario',
          appName: s.appName || 'AutoQA Target',
          createdDate: s.createdDate,
          content: s.content
        }));
        
        setScripts(mappedScripts);
      } catch (err: any) {
        setApiError(err?.message || 'Error connecting to API');
      } finally {
        setIsLoading(false);
      }
    };
    fetchScripts();
  }, []);

  const filteredScripts = scripts.filter((s) => {
    return s.scriptName.toLowerCase().includes(searchTerm.toLowerCase()) || 
           s.moduleName.toLowerCase().includes(searchTerm.toLowerCase()) ||
           s.appName.toLowerCase().includes(searchTerm.toLowerCase());
  });

  const handleCopyContent = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (script: GeneratedScript) => {
    const blob = new Blob([script.content], { type: 'text/typescript' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = script.scriptName;
    link.click();
    window.URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-8 w-full py-2 relative animate-fade-in">
      
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white flex items-center gap-2.5">
          <FileTerminal className="h-8 w-8 text-purple-400" />
          Generated Automation Scripts
        </h2>
        <p className="text-base sm:text-lg text-zinc-400 mt-2">Preview and download standalone Playwright TypeScript specifications to run natively on your host shell.</p>
      </div>

      {/* Filter toolbar */}
      <div className="relative max-w-xl w-full">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-zinc-500">
          <Search className="h-4.5 w-4.5" />
        </div>
        <input
          type="text"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          placeholder="Search by script name, app, or module..."
          className="w-full pl-11 pr-4 py-3.5 bg-zinc-900 border border-zinc-800 rounded-xl text-sm sm:text-base text-white placeholder-zinc-550 focus:outline-none focus:border-purple-500"
        />
      </div>

      {/* Table of Scripts */}
      <div className="border border-zinc-800 rounded-2xl bg-zinc-900/10 backdrop-blur-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-800/60 bg-zinc-900/40 text-xs sm:text-sm font-bold text-zinc-500 uppercase tracking-widest">
                <th className="px-6 py-4">Script Name</th>
                <th className="px-6 py-4">Module Context</th>
                <th className="px-6 py-4">Created Date</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/50 text-sm sm:text-base font-semibold text-zinc-300">
              {isLoading && (
                <tr>
                  <td colSpan={4} className="p-16 text-center text-zinc-550 font-semibold text-base">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-purple-500"></div>
                      <p className="text-zinc-400 mt-2 font-mono">Loading generated spec scripts...</p>
                    </div>
                  </td>
                </tr>
              )}

              {!isLoading && apiError && (
                <tr>
                  <td colSpan={4} className="p-16 text-center text-rose-400 font-semibold text-base">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <p className="text-rose-500 font-bold font-mono">Failed to load scripts</p>
                      <p className="text-zinc-500 text-xs sm:text-sm mt-1 font-mono">{apiError}</p>
                    </div>
                  </td>
                </tr>
              )}

              {!isLoading && !apiError && filteredScripts.map((s) => (
                <tr key={s.id} className="hover:bg-zinc-900/10 transition-colors">
                  <td className="px-6 py-4 flex items-center gap-3 max-w-sm">
                    <div className="h-10 w-10 rounded-lg bg-zinc-950 border border-zinc-855 flex items-center justify-center text-purple-400 shrink-0">
                      <FileCode className="h-5.5 w-5.5" />
                    </div>
                    <div className="truncate">
                      <div className="font-bold text-white truncate">{s.scriptName}</div>
                      <div className="text-xs sm:text-sm text-zinc-500 truncate mt-1">{s.appName}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-zinc-400 font-mono">{s.moduleName}</td>
                  <td className="px-6 py-4 text-zinc-500 font-mono">{new Date(s.createdDate).toLocaleDateString()}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      <button
                        type="button"
                        onClick={() => setActivePreviewScript(s)}
                        className="text-xs sm:text-sm font-bold text-purple-400 hover:text-purple-300 inline-flex items-center gap-1.5 border border-purple-500/10 bg-purple-500/5 px-3.5 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        <Eye className="h-4 w-4" />
                        Preview
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownload(s)}
                        className="text-xs sm:text-sm font-bold text-zinc-400 hover:text-white inline-flex items-center gap-1.5 border border-zinc-800 bg-zinc-900/40 px-3.5 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        <Download className="h-4 w-4 text-zinc-500" />
                        Download
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {!isLoading && !apiError && filteredScripts.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-16 text-center text-zinc-500 font-semibold text-base">
                    No matching Playwright spec scripts found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Code Preview Overlay Modal Panel */}
      {activePreviewScript && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="relative w-full max-w-3xl bg-zinc-950 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col p-6 max-h-[85vh] animate-fade-in">
            {/* Header info */}
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 mb-4">
              <div className="flex items-center gap-3">
                <FileCode className="h-6 w-6 text-purple-400" />
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-white truncate max-w-[320px]">{activePreviewScript.scriptName}</h3>
                  <p className="text-xs sm:text-sm text-zinc-500 font-mono mt-0.5">{activePreviewScript.appName} | {activePreviewScript.moduleName}</p>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => handleCopyContent(activePreviewScript.content)}
                  className="h-8.5 w-8.5 rounded-lg hover:bg-zinc-900 border border-zinc-850 flex items-center justify-center text-zinc-400 hover:text-white transition-all"
                >
                  {copied ? <Check className="h-4.5 w-4.5 text-emerald-400" /> : <Copy className="h-4.5 w-4.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => setActivePreviewScript(null)}
                  className="h-8.5 w-8.5 rounded-lg hover:bg-zinc-900 border border-zinc-850 flex items-center justify-center text-zinc-500 hover:text-white transition-all"
                >
                  <X className="h-4.5 w-4.5" />
                </button>
              </div>
            </div>

            {/* Scrollable code body */}
            <div className="overflow-y-auto flex-1 bg-zinc-900/60 p-4.5 rounded-2xl border border-zinc-900/80 font-mono text-xs sm:text-sm text-zinc-300 leading-relaxed max-h-[50vh]">
              <pre><code>{activePreviewScript.content}</code></pre>
            </div>

            {/* Bottom Actions footer */}
            <div className="flex items-center justify-between border-t border-zinc-900 pt-4 mt-4 text-xs sm:text-sm font-mono text-zinc-500">
              <span className="flex items-center gap-1.5 font-bold">
                <CheckCircle2 className="h-5 w-5 text-purple-400" />
                V1 MVP Spec verified compile-ready
              </span>
              <button
                type="button"
                onClick={() => handleDownload(activePreviewScript)}
                className="px-5 py-3 bg-purple-600 hover:bg-purple-500 rounded-xl font-bold text-white text-xs sm:text-sm transition-all cursor-pointer shadow-md"
              >
                Download Script
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
