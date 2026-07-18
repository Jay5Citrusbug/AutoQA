'use client';

import React, { useState, useEffect } from 'react';
import { 
  Layers, Plus, Edit2, Trash2, Play, Search, X, 
  HelpCircle, RefreshCw, Globe, ChevronRight, Save, ClipboardList, Info
} from 'lucide-react';
import Link from 'next/link';
import { TestCase } from '@/types/testCase';
import SafeFormattedDate from '@/components/SafeFormattedDate';

export default function TestCasesPage() {
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  
  // Form modal states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTestCase, setEditingTestCase] = useState<TestCase | null>(null);
  
  // Form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [stepsText, setStepsText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Search filter
  const [searchTerm, setSearchTerm] = useState('');

  // Fetch test cases on mount
  const fetchTestCases = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/test-cases');
      if (!res.ok) throw new Error('Failed to load test cases database.');
      const data = await res.json();
      setTestCases(data);
    } catch (err: any) {
      setApiError(err?.message || 'Error connecting to API');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTestCases();
  }, []);

  const handleOpenCreateModal = () => {
    setEditingTestCase(null);
    setTitle('');
    setDescription('');
    setWebsiteUrl('');
    setModuleName('');
    setStepsText('');
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (tc: TestCase) => {
    setEditingTestCase(tc);
    setTitle(tc.title);
    setDescription(tc.description || '');
    setWebsiteUrl(tc.websiteUrl || '');
    setModuleName(tc.moduleName || '');
    setStepsText(tc.stepsText || '');
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleDeleteTestCase = async (id: string) => {
    if (!confirm('Are you sure you want to delete this test case?')) return;
    try {
      const res = await fetch(`/api/test-cases/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete test case.');
      
      // Update UI list
      setTestCases(prev => prev.filter(t => t.id !== id));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSubmitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!title.trim() || !stepsText.trim()) {
      setFormError('Title and test case steps are required.');
      return;
    }

    try {
      const urlEndpoint = editingTestCase 
        ? `/api/test-cases/${editingTestCase.id}` 
        : '/api/test-cases';
      const httpMethod = editingTestCase ? 'PUT' : 'POST';

      const response = await fetch(urlEndpoint, {
        method: httpMethod,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          websiteUrl: websiteUrl.trim(),
          moduleName: moduleName.trim() || 'General',
          stepsText: stepsText
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.details || 'Failed to save test case');
      }

      // Warn (non-blocking) about steps the parser could not understand, so the
      // user can rephrase them rather than discovering the failure only at run time.
      const unparsed = Array.isArray(data.steps)
        ? data.steps.filter((s: { type?: string }) => s?.type === 'unparsed')
        : [];
      if (unparsed.length > 0) {
        const lines = unparsed
          .map((s: { rawText?: string }) => `  • ${s.rawText ?? ''}`)
          .join('\n');
        alert(
          `Saved, but ${unparsed.length} step(s) were not understood and will fail at run time:\n\n${lines}\n\n` +
            `Rephrase them starting with an action verb (click, enter, select, check, navigate) or an assertion (verify/assert/expect).`,
        );
      }

      // Close modal and refresh list
      setIsModalOpen(false);
      fetchTestCases();
    } catch (err: any) {
      setFormError(err.message);
    }
  };

  // Filter test cases
  const filteredTestCases = testCases.filter((tc) => {
    return tc.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
           (tc.moduleName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
           (tc.websiteUrl || '').toLowerCase().includes(searchTerm.toLowerCase());
  });

  return (
    <div className="flex flex-col gap-8 w-full py-2 relative animate-fade-in text-[#f9fafb]">
      
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white flex items-center gap-2.5">
            <Layers className="h-8 w-8 text-purple-400" />
            Test Case Repository
          </h2>
          <p className="text-base sm:text-lg text-zinc-400 mt-2">Manage your automated test scenarios catalog, edit steps, and dispatch execution scripts.</p>
        </div>

        <button
          type="button"
          onClick={handleOpenCreateModal}
          className="px-6 py-4.5 rounded-xl font-bold bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-500/10 flex items-center gap-2 select-none cursor-pointer self-start sm:self-center transition-all text-base shrink-0"
        >
          <Plus className="h-5.5 w-5.5" />
          Create Test Case
        </button>
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
          placeholder="Search by title, module context, or url..."
          className="w-full pl-11 pr-4 py-3.5 bg-zinc-900 border border-zinc-800 rounded-xl text-sm sm:text-base text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
        />
      </div>

      {/* Test Cases Table/Grid */}
      <div className="border border-zinc-800 rounded-2xl bg-zinc-900/10 backdrop-blur-md overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-zinc-800/60 bg-zinc-900/40 text-xs sm:text-sm font-bold text-zinc-500 uppercase tracking-widest">
                <th className="px-6 py-4">Test Case details</th>
                <th className="px-6 py-4">Module context</th>
                <th className="px-6 py-4">Steps count</th>
                <th className="px-6 py-4">Last Updated</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/50 text-sm sm:text-base font-semibold text-zinc-300">
              {isLoading && (
                <tr>
                  <td colSpan={5} className="p-16 text-center text-zinc-500 font-semibold text-base">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <RefreshCw className="h-8 w-8 animate-spin text-purple-400" />
                      <p className="text-zinc-400 mt-2 font-mono">Loading repository catalog...</p>
                    </div>
                  </td>
                </tr>
              )}

              {!isLoading && apiError && (
                <tr>
                  <td colSpan={5} className="p-16 text-center text-rose-455 font-semibold text-base">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <p className="text-rose-500 font-bold font-mono">Failed to load test cases</p>
                      <p className="text-zinc-500 text-xs sm:text-sm mt-1 font-mono">{apiError}</p>
                    </div>
                  </td>
                </tr>
              )}

              {!isLoading && !apiError && filteredTestCases.map((tc) => (
                <tr key={tc.id} className="hover:bg-zinc-900/10 transition-colors">
                  <td className="px-6 py-4 flex items-start gap-3 max-w-sm">
                    <div className="h-10 w-10 rounded-lg bg-zinc-950 border border-zinc-855 flex items-center justify-center text-purple-400 shrink-0 mt-0.5">
                      <ClipboardList className="h-5.5 w-5.5" />
                    </div>
                    <div className="truncate">
                      <div className="font-bold text-white truncate text-base">{tc.title}</div>
                      <div className="text-xs sm:text-sm text-zinc-500 truncate mt-1 flex items-center gap-1">
                        <Globe className="h-3.5 w-3.5" />
                        {tc.websiteUrl || 'No target URL configured'}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-zinc-400 font-mono">{tc.moduleName}</td>
                  <td className="px-6 py-4 text-zinc-350 font-mono">{tc.steps.length} steps</td>
                  <td className="px-6 py-4 text-zinc-500 font-mono"><SafeFormattedDate value={tc.updatedAt} /></td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      <Link
                        href={`/run-test?testCaseId=${tc.id}`}
                        className="text-xs sm:text-sm font-bold text-emerald-450 hover:text-emerald-400 inline-flex items-center gap-1.5 border border-emerald-500/10 bg-emerald-500/5 px-3.5 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        <Play className="h-4 w-4 fill-current" />
                        Run Test
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleOpenEditModal(tc)}
                        className="text-xs sm:text-sm font-bold text-purple-400 hover:text-purple-300 inline-flex items-center gap-1.5 border border-purple-500/10 bg-purple-500/5 px-3.5 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        <Edit2 className="h-4 w-4" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteTestCase(tc.id)}
                        className="text-xs sm:text-sm font-bold text-rose-400 hover:text-rose-300 inline-flex items-center gap-1.5 border border-rose-500/10 bg-rose-500/5 px-3.5 py-2 rounded-xl transition-all cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}

              {!isLoading && !apiError && filteredTestCases.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-16 text-center text-zinc-500 font-semibold text-base">
                    No matching test cases found in your repository.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Save / Edit Modal Overlay */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="relative w-full max-w-2xl bg-zinc-950 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col p-6 max-h-[90vh] animate-fade-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 mb-4">
              <div className="flex items-center gap-3">
                <Layers className="h-6 w-6 text-purple-400" />
                <h3 className="text-base sm:text-lg font-bold text-white">
                  {editingTestCase ? 'Edit Test Case Scenario' : 'Create New Test Case'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="h-8.5 w-8.5 rounded-lg hover:bg-zinc-900 border border-zinc-850 flex items-center justify-center text-zinc-500 hover:text-white transition-all"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            {formError && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 p-4 rounded-xl text-sm font-semibold mb-4 leading-relaxed flex items-start gap-2">
                <Info className="h-4.5 w-4.5 shrink-0 mt-0.5" />
                {formError}
              </div>
            )}

            {/* Modal Form Scroll Area */}
            <form onSubmit={handleSubmitForm} className="overflow-y-auto flex-1 flex flex-col gap-5 pr-1 py-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <label className="text-xs sm:text-sm font-bold text-zinc-400 uppercase tracking-wider">Test Case Title *</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Verify Admin Dashboard Login"
                    className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm sm:text-base text-white placeholder-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="text-xs sm:text-sm font-bold text-zinc-400 uppercase tracking-wider">Module context</label>
                  <input
                    type="text"
                    value={moduleName}
                    onChange={e => setModuleName(e.target.value)}
                    placeholder="e.g. Authentication"
                    className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm sm:text-base text-white placeholder-zinc-600 focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs sm:text-sm font-bold text-zinc-400 uppercase tracking-wider">Target Website URL</label>
                <input
                  type="text"
                  value={websiteUrl}
                  onChange={e => setWebsiteUrl(e.target.value)}
                  placeholder="https://example.com/login"
                  className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm sm:text-base text-white placeholder-zinc-600 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs sm:text-sm font-bold text-zinc-400 uppercase tracking-wider">Description</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Summarize the verification objective..."
                  className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-sm sm:text-base text-white placeholder-zinc-600 focus:outline-none focus:border-purple-500 resize-none h-20"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs sm:text-sm font-bold text-zinc-400 uppercase tracking-wider">Test Steps (Natural Language) *</label>
                <textarea
                  required
                  value={stepsText}
                  onChange={e => setStepsText(e.target.value)}
                  placeholder={`Step 1: Navigate to "https://example.com/login"
Step 2: Enter "admin@example.com" into input "Username"
Step 3: Enter "SecurePass123!" into input "Password"
Step 4: Click the "Sign In" button
Expected Result: Verify success message "Dashboard Welcome"`}
                  className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 font-mono text-xs sm:text-sm text-white placeholder-zinc-650 focus:outline-none focus:border-purple-500 resize-none h-44"
                />
              </div>

              {/* Bottom Actions footer */}
              <div className="flex items-center justify-end gap-3 border-t border-zinc-900 pt-4 mt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-5 py-3 border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 text-zinc-300 hover:text-white rounded-xl font-bold text-xs sm:text-sm transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-6 py-3 bg-purple-600 hover:bg-purple-500 rounded-xl font-bold text-white text-xs sm:text-sm transition-all shadow-md flex items-center gap-1.5"
                >
                  <Save className="h-4.5 w-4.5" />
                  Save Test Case
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
}
