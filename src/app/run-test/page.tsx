'use client';

import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Settings, ClipboardList, Trash2, LayoutTemplate, 
  Terminal, ShieldAlert, ArrowLeft, RefreshCcw, CheckCircle, 
  XCircle, Clock, Eye, AlertCircle, Sparkles, ChevronRight, X,
  Upload, Terminal as TerminalIcon, ShieldCheck, Flame, Compass, PlayCircle, Loader2, Search, FileTerminal,
  Monitor, Smartphone, Tablet, Globe, Zap, Users
} from 'lucide-react';
import { ExecutionType, StageStatus, ExecutionStage, StepExecution, BrowserEngine, DeviceMode } from '@/types/mvp';

export default function RunTestPage() {
  // --- FORM STATES ---
  const [url, setUrl] = useState('');
  const [appName, setAppName] = useState('');
  const [moduleName, setModuleName] = useState('');
  const [testTitle, setTestTitle] = useState('');
  const [testDescription, setTestDescription] = useState('');
  const [execType, setExecType] = useState<ExecutionType>('Functional');
  const [stepsText, setStepsText] = useState('');
  const [expectedResult, setExpectedResult] = useState('');
  const [browser, setBrowser] = useState<BrowserEngine>('chromium');
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('desktop');
  const [maxWorkers, setMaxWorkers] = useState(1);
  
  // --- CONFIG CONFIGS ---
  const [config, setConfig] = useState({
    generateScript: true,
    captureScreenshots: true,
    captureConsoleLogs: false,
    captureNetworkLogs: false,
    headless: true,
  });

  // --- RUNTIME STATE ---
  const [runStatus, setRunStatus] = useState<'form' | 'executing' | 'results'>('form');
  const [activeStageId, setActiveStageId] = useState<string>('4');
  
  // High-fidelity Pipeline checklist stages
  const [stages, setStages] = useState<ExecutionStage[]>([
    { id: '1', name: 'Browser Started', status: 'completed' },
    { id: '2', name: 'URL Opened', status: 'completed' },
    { id: '3', name: 'Elements Discovered', status: 'completed' },
    { id: '4', name: 'Validation Running', status: 'running' },
    { id: '5', name: 'Evidence Collection', status: 'pending' },
    { id: '6', name: 'Report Generation', status: 'pending' },
    { id: '7', name: 'Completed', status: 'pending' },
  ]);

  // Simulated metrics logs
  const [stepResults, setStepResults] = useState<StepExecution[]>([]);
  const [runDuration, setRunDuration] = useState(0);
  const [selectedFailedStep, setSelectedFailedStep] = useState<StepExecution | null>(null);
  const [videoPath, setVideoPath] = useState<string | undefined>(undefined);
  const [networkRequests, setNetworkRequests] = useState<any[]>([]);
  const [activeAuditTab, setActiveAuditTab] = useState<'details' | 'video' | 'network'>('details');
  const [logFilter, setLogFilter] = useState<'all' | 'info' | 'debug' | 'error'>('all');

  useEffect(() => {
    if (selectedFailedStep) {
      setActiveAuditTab('details');
      setLogFilter('all');
    }
  }, [selectedFailedStep]);

  const [isFocused, setIsFocused] = useState(false);
  const [liveLogs, setLiveLogs] = useState<string[]>([
    `[SYSTEM] AutoQA Execution Kernel initialized. Configure execution parameters and click "Run Test" to view real-time browser automation logs.`
  ]);

  // Textarea metrics helpers
  const charCount = stepsText.length;
  const lineCount = stepsText.split('\n').length;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInsertTemplate = () => {
    setTestTitle('Login Flow Verification');
    setTestDescription('Verify that a registered user can log in successfully using valid credentials and lands on the secure area dashboard.');
    setStepsText([
      'Navigate to "https://the-internet.herokuapp.com/login"',
      'Enter "tomsmith" into input "username"',
      'Enter "SuperSecretPassword!" into input "password"',
      'Click the login button',
    ].join('\n'));
    setExpectedResult('Verify success message "You logged into a secure area!" exists');
    setAppName('Heroku App Hub');
    setModuleName('Security Auth');
    setUrl('https://the-internet.herokuapp.com/login');
  };

  const handleClearEditor = () => {
    setTestTitle('');
    setTestDescription('');
    setStepsText('');
    setExpectedResult('');
  };

  // --- SIMULATION TRIGGERS ---
  const [runId, setRunId] = useState<string>('');
  const [generatedScriptPath, setGeneratedScriptPath] = useState<string | undefined>(undefined);
  const [apiError, setApiError] = useState<string | null>(null);

  const [showBugReport, setShowBugReport] = useState(false);
  const [bugReportContent, setBugReportContent] = useState('');
  const [bugCopied, setBugCopied] = useState(false);

  const generateBugReport = () => {
    if (!selectedFailedStep) return;

    // Get preceding steps up to the failed step
    const stepsReproduce = stepResults
      .filter(s => s.stepIndex <= selectedFailedStep.stepIndex)
      .map(s => `${s.stepIndex === selectedFailedStep.stepIndex ? '->' : '  '} Step ${s.stepIndex}: ${s.rawText}`)
      .join('\n');

    const logs = (selectedFailedStep.consoleLogs || []).join('\n') || 'No logs recorded.';

    const markdown = `# Bug Report: ${appName || 'AutoQA Target'} - ${moduleName || 'Automation Scenario'}

## General Information
- **Target URL**: ${url}
- **Environment**: ${browser} (${deviceMode} mode)
- **Execution Run ID**: ${runId || 'N/A'}
- **Duration**: ${runDuration ? (runDuration / 1000).toFixed(2) + 's' : 'N/A'}

## Failure Details
- **Failed Step**: Step ${selectedFailedStep.stepIndex} - "${selectedFailedStep.rawText}"
- **Expected Behavior**: ${selectedFailedStep.expectedResult || "Expected validation text was not matched in target selectors."}
- **Actual Behavior**: ${selectedFailedStep.actualResult || selectedFailedStep.error || "Target element did not load within threshold parameters."}
- **Error Details**: 
\`\`\`
${selectedFailedStep.error || 'N/A'}
\`\`\`

## Steps to Reproduce
\`\`\`
${stepsReproduce}
\`\`\`

## Evidence
- **Visual Evidence (Screenshot)**: ${selectedFailedStep.screenshot ? window.location.origin + selectedFailedStep.screenshot : 'No screenshot captured.'}
- **Console Output**:
\`\`\`
${logs}
\`\`\`

## Automation Test Script Link
- **Spec Path**: ${generatedScriptPath ? window.location.origin + generatedScriptPath : 'No script generated.'}
`;
    setBugReportContent(markdown);
    setShowBugReport(true);
  };

  // --- LOAD HISTORICAL RUN ID OR SAVED TEST CASE FROM QUERY PARAMS ---
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const runIdParam = params.get('runId');
    const testCaseIdParam = params.get('testCaseId');

    if (runIdParam) {
      const loadHistoricalRun = async () => {
        try {
          setRunStatus('executing');
          setStages(prev => prev.map(s => ({ ...s, status: 'completed' })));
          
          const res = await fetch(`/api/reports?runId=${runIdParam}`);
          if (!res.ok) throw new Error('Historical report not found');
          const data = await res.json();
          
          setRunId(data.summary.runId);
          setUrl(data.summary.url);
          setAppName(data.details.appName || 'AutoQA Target');
          setModuleName(data.details.moduleName || 'Default Flow');
          setRunDuration(data.summary.durationMs);
          setVideoPath(data.details.testSuiteResults?.[0]?.videoPath);
          setNetworkRequests(data.details.networkRequests || []);
          
          const results: StepExecution[] = data.details.stepResults.map((s: any) => ({
            stepIndex: s.stepIndex,
            rawText: s.step.rawText,
            status: s.status,
            durationMs: s.durationMs,
            resolvedSelector: s.resolvedSelector,
            screenshot: s.screenshotPath,
            error: s.error,
            expectedResult: s.status === 'failed' ? 'Assertion verify target element text visible.' : undefined,
            actualResult: s.error ? s.error : undefined,
            consoleLogs: s.logs || []
          }));
          
          setStepResults(results);
          setGeneratedScriptPath(data.details.generatedScriptPath);
          setRunStatus('results');
        } catch (err: any) {
          setApiError('Failed to load historical run details: ' + err.message);
          setRunStatus('form');
        }
      };
      loadHistoricalRun();
    } else if (testCaseIdParam) {
      const loadTestCase = async () => {
        try {
          const res = await fetch(`/api/test-cases/${testCaseIdParam}`);
          if (!res.ok) throw new Error('Test case not found');
          const data = await res.json();
          
          setUrl(data.websiteUrl || '');
          setAppName(data.title || '');
          setModuleName(data.moduleName || '');
          setStepsText(data.stepsText || '');
          setRunStatus('form');
          
          // Allow state updates to settle before enabling local saving
          setTimeout(() => {
            isLoadedRef.current = true;
          }, 100);
        } catch (err: any) {
          setApiError('Failed to load test case: ' + err.message);
          setRunStatus('form');
        }
      };
      loadTestCase();
    }
  }, []);

  const isLoadedRef = useRef(false);

  // Load from localStorage on mount (only if not loading a historical run or test case)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get('runId') && !params.get('testCaseId')) {
      const savedUrl = localStorage.getItem('autoqa_url');
      const savedAppName = localStorage.getItem('autoqa_app_name');
      const savedModuleName = localStorage.getItem('autoqa_module_name');
      const savedTestTitle = localStorage.getItem('autoqa_test_title');
      const savedTestDescription = localStorage.getItem('autoqa_test_description');
      const savedStepsText = localStorage.getItem('autoqa_steps_text');
      const savedExpectedResult = localStorage.getItem('autoqa_expected_result');

      if (savedUrl !== null) setUrl(savedUrl);
      if (savedAppName !== null) setAppName(savedAppName);
      if (savedModuleName !== null) setModuleName(savedModuleName);
      if (savedTestTitle !== null) setTestTitle(savedTestTitle);
      if (savedTestDescription !== null) setTestDescription(savedTestDescription);
      if (savedStepsText !== null) setStepsText(savedStepsText);
      if (savedExpectedResult !== null) setExpectedResult(savedExpectedResult);
      isLoadedRef.current = true;
    }
  }, []);

  // Save to localStorage when state changes (only after loading has completed)
  useEffect(() => {
    if (!isLoadedRef.current || typeof window === 'undefined') return;
    localStorage.setItem('autoqa_url', url);
  }, [url]);

  useEffect(() => {
    if (!isLoadedRef.current || typeof window === 'undefined') return;
    localStorage.setItem('autoqa_app_name', appName);
  }, [appName]);

  useEffect(() => {
    if (!isLoadedRef.current || typeof window === 'undefined') return;
    localStorage.setItem('autoqa_module_name', moduleName);
  }, [moduleName]);

  useEffect(() => {
    if (!isLoadedRef.current || typeof window === 'undefined') return;
    localStorage.setItem('autoqa_test_title', testTitle);
  }, [testTitle]);

  useEffect(() => {
    if (!isLoadedRef.current || typeof window === 'undefined') return;
    localStorage.setItem('autoqa_test_description', testDescription);
  }, [testDescription]);

  useEffect(() => {
    if (!isLoadedRef.current || typeof window === 'undefined') return;
    localStorage.setItem('autoqa_steps_text', stepsText);
  }, [stepsText]);

  useEffect(() => {
    if (!isLoadedRef.current || typeof window === 'undefined') return;
    localStorage.setItem('autoqa_expected_result', expectedResult);
  }, [expectedResult]);

  const handleAbortRun = async () => {
    if (!runId) return;
    try {
      await fetch('/api/run-test/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId })
      });
      setLiveLogs(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] [SYSTEM] CANCEL SIGNAL INITIATED BY USER...`
      ]);
    } catch (err) {
      console.error('Failed to send abort signal', err);
    }
  };

  const handleStartExecution = async () => {
    setRunStatus('executing');
    setSelectedFailedStep(null);
    setApiError(null);

    const clientRunId = 'run_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    setRunId(clientRunId);

    setLiveLogs([
      `[${new Date().toLocaleTimeString()}] INITIALIZING AUTOQA KERNEL...`,
      `[${new Date().toLocaleTimeString()}] SYSTEM: NODE_VERSION v20.11.0`,
      `[${new Date().toLocaleTimeString()}] LOADING TEST SUITE CONTEXT: functional_runner.ts`,
      `[${new Date().toLocaleTimeString()}] STEP: BROWSER_STARTING [IN_PROGRESS]`
    ]);

    // Reset stages
    setStages([
      { id: '1', name: 'Browser Started', status: 'running' },
      { id: '2', name: 'URL Opened', status: 'pending' },
      { id: '3', name: 'Elements Discovered', status: 'pending' },
      { id: '4', name: 'Validation Running', status: 'pending' },
      { id: '5', name: 'Evidence Collection', status: 'pending' },
      { id: '6', name: 'Report Generation', status: 'pending' },
      { id: '7', name: 'Completed', status: 'pending' },
    ]);

    // Animate stage progressions to show activity
    const stageTimer1 = setTimeout(() => {
      setStages(prev => prev.map(s => s.id === '1' ? { ...s, status: 'completed' } : s.id === '2' ? { ...s, status: 'running' } : s));
      setLiveLogs(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] STEP: BROWSER_START [SUCCESS]`,
        `[${new Date().toLocaleTimeString()}] EXEC: navigating browser page to target URL: "${url}"`
      ]);
    }, 1500);

    const stageTimer2 = setTimeout(() => {
      setStages(prev => prev.map(s => s.id === '2' ? { ...s, status: 'completed' } : s.id === '3' ? { ...s, status: 'running' } : s));
      setLiveLogs(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] STEP: URL_OPEN [SUCCESS]`,
        `[${new Date().toLocaleTimeString()}] SCAN: Identifying DOM interactive element candidates...`
      ]);
    }, 3000);

    const stageTimer3 = setTimeout(() => {
      setStages(prev => prev.map(s => s.id === '3' ? { ...s, status: 'completed' } : s.id === '4' ? { ...s, status: 'running' } : s));
      setLiveLogs(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] STEP: ELEMENTS_DISCOVERED [SUCCESS]`,
        `[${new Date().toLocaleTimeString()}] EXEC: Initiating rule-based steps runner loop...`
      ]);
    }, 4500);

    // Poll server-side activeLogs for real-time progress logging
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/run-test?runId=${clientRunId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.logs && data.logs.length > 0) {
            setLiveLogs(data.logs);
          }
        }
      } catch (err) {
        // ignore polling error
      }
    }, 600);

    try {
      const response = await fetch('/api/run-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: clientRunId,
          url,
          appName: appName.trim() || testTitle.trim() || 'AutoQA Target',
          moduleName: moduleName.trim() || 'Default Flow',
          execType,
          // Only send pure steps + expected result — title & description are UI-only metadata
          stepsText: [
            stepsText.trim(),
            expectedResult.trim() ? expectedResult.trim() : '',
          ].filter(Boolean).join('\n'),
          browser,
          deviceMode,
          maxWorkers,
          config
        })
      });

      // Clear layout timers and polling loop
      clearTimeout(stageTimer1);
      clearTimeout(stageTimer2);
      clearTimeout(stageTimer3);
      clearInterval(pollInterval);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.details?.fieldErrors?.stepsText?.[0] || 'Browser automation run failed');
      }

      setRunId(data.runId);
      setGeneratedScriptPath(data.generatedScriptPath);
      setRunDuration(data.durationMs);
      setVideoPath(data.videoPath);
      setNetworkRequests(data.networkRequests || []);

      // Map step results
      const results: StepExecution[] = data.steps.map((s: any) => ({
        stepIndex: s.stepIndex,
        rawText: s.rawText,
        status: s.status,
        durationMs: s.durationMs,
        resolvedSelector: s.resolvedSelector,
        screenshot: s.screenshot,
        error: s.error,
        expectedResult: s.status === 'failed' ? 'Assertion verify target element text visible.' : undefined,
        actualResult: s.error ? s.error : undefined,
        consoleLogs: s.consoleLogs || []
      }));

      setStepResults(results);

      // Finish stages
      const isFailed = data.status === 'failed';
      setStages([
        { id: '1', name: 'Browser Started', status: 'completed' },
        { id: '2', name: 'URL Opened', status: 'completed' },
        { id: '3', name: 'Elements Discovered', status: 'completed' },
        { id: '4', name: 'Validation Running', status: isFailed ? 'failed' : 'completed' },
        { id: '5', name: 'Evidence Collection', status: 'completed' },
        { id: '6', name: 'Report Generation', status: 'completed' },
        { id: '7', name: 'Completed', status: isFailed ? 'failed' : 'completed' },
      ]);

      // Process steps logs dynamically
      const executionLogs: string[] = [];
      data.steps.forEach((s: any) => {
        const timeStr = new Date().toLocaleTimeString();
        if (s.status === 'passed') {
          executionLogs.push(`[${timeStr}] [SUCCESS] STEP ${s.stepIndex}: "${s.rawText}" -> duration: ${s.durationMs}ms, selector: "${s.resolvedSelector || 'N/A'}"`);
        } else if (s.status === 'failed') {
          executionLogs.push(`[${timeStr}] [FAILURE] STEP ${s.stepIndex}: "${s.rawText}" -> ERROR: ${s.error}`);
        } else {
          executionLogs.push(`[${timeStr}] [SKIPPED] STEP ${s.stepIndex}: "${s.rawText}"`);
        }
      });

      setLiveLogs(prev => [
        ...prev,
        ...executionLogs,
        `[${new Date().toLocaleTimeString()}] RUN COMPLETED with status: ${data.status.toUpperCase()}`,
        `[${new Date().toLocaleTimeString()}] Total steps processed: ${data.totalCount} (Passed: ${data.passedCount}, Failed: ${data.failedCount})`
      ]);

      // Delay transition for 1s to let the user see the completed checklist
      setTimeout(() => {
        setRunStatus('results');
      }, 1000);

    } catch (err: any) {
      clearTimeout(stageTimer1);
      clearTimeout(stageTimer2);
      clearTimeout(stageTimer3);
      clearInterval(pollInterval);
      
      const errMsg = err?.message || 'Failed to communicate with execution server.';
      setApiError(errMsg);
      setLiveLogs(prev => [
        ...prev,
        `[${new Date().toLocaleTimeString()}] [FATAL SYSTEM EXCEPTION]: ${errMsg}`
      ]);
      setRunStatus('form');
    }
  };

  return (
    <div className="flex flex-col gap-6 w-full text-[#f9fafb]">
      
      {/* 1. SETUP STATE PANEL (Image 1 Layout) */}
      {runStatus === 'form' && (
        <div className="flex flex-col gap-6 w-full animate-fade-in">
          
          {/* Main Title Banner */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight text-white">Configuration Dashboard</h2>
              <p className="text-base sm:text-lg text-zinc-400 mt-2">Initialize and sequence your automated test suite</p>
            </div>
            <span className="text-xs sm:text-sm font-mono font-bold tracking-wider bg-blue-600/10 border border-blue-500/20 text-blue-400 px-4 py-2 rounded-lg select-none">
              V2.4.0-STABLE
            </span>
          </div>

          {apiError && (
            <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 p-4.5 rounded-xl flex items-start gap-3">
              <ShieldAlert className="h-6 w-6 shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-sm font-bold uppercase tracking-wider">Execution Failure</h4>
                <p className="text-sm mt-1 leading-relaxed">{apiError}</p>
              </div>
              <button onClick={() => setApiError(null)} className="text-zinc-500 hover:text-zinc-300 shrink-0">
                <X className="h-5 w-5" />
              </button>
            </div>
          )}

          {/* Form input parameters */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-6 bg-[#101524] border border-zinc-800 p-6 rounded-2xl">
            <div className="flex flex-col gap-2.5">
              <label className="text-sm sm:text-base font-bold text-zinc-400 uppercase tracking-wider">Application URL</label>
              <input
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://your-website.com/login"
                className="bg-[#090d16] border border-[#1c253c] rounded-xl px-5 py-4 text-base sm:text-lg text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div className="flex flex-col gap-2.5">
              <label className="text-sm sm:text-base font-bold text-zinc-400 uppercase tracking-wider">Application Name</label>
              <input
                type="text"
                value={appName}
                onChange={e => setAppName(e.target.value)}
                placeholder="e.g. Enterprise Portal"
                className="bg-[#090d16] border border-[#1c253c] rounded-xl px-5 py-4 text-base sm:text-lg text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div className="flex flex-col gap-2.5">
              <label className="text-sm sm:text-base font-bold text-zinc-400 uppercase tracking-wider">Module Name</label>
              <input
                type="text"
                value={moduleName}
                onChange={e => setModuleName(e.target.value)}
                placeholder="e.g. Authentication Flow"
                className="bg-[#090d16] border border-[#1c253c] rounded-xl px-5 py-4 text-base sm:text-lg text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div className="flex flex-col gap-2.5">
              <label className="text-sm sm:text-base font-bold text-zinc-400 uppercase tracking-wider">Execution Type</label>
              <select
                value={execType}
                onChange={e => setExecType(e.target.value as any)}
                className="bg-[#090d16] border border-[#1c253c] rounded-xl px-5 py-4 text-base sm:text-lg text-white focus:outline-none focus:border-blue-500 transition-colors font-semibold"
              >
                <option value="Functional">Functional</option>
                <option value="Smoke">Smoke</option>
                <option value="Regression">Regression</option>
              </select>
            </div>
          </div>

          {/* Core content split panel */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Left: Structured Test Case Editor */}
            <div className="lg:col-span-2 border border-zinc-800 bg-[#101524] rounded-2xl flex flex-col">
              
              {/* Editor Header */}
              <div className="px-6 py-5 border-b border-zinc-800 flex items-center justify-between gap-4 flex-wrap">
                <div className="text-sm sm:text-base font-bold text-zinc-300 font-mono tracking-wider flex items-center gap-1.5">
                  <ClipboardList className="h-5 w-5 text-blue-500" />
                  TEST_CASE_EDITOR
                </div>

                <div className="flex items-center gap-3">
                  <button className="text-sm sm:text-base font-bold text-zinc-400 hover:text-white border border-zinc-800 bg-[#090d16] px-4 py-2.5 rounded-xl flex items-center gap-1.5 transition-all">
                    <Upload className="h-4.5 w-4.5" />
                    Import File
                  </button>
                  <button
                    type="button"
                    onClick={handleInsertTemplate}
                    className="text-sm sm:text-base font-bold text-zinc-400 hover:text-white border border-zinc-800 bg-[#090d16] px-4 py-2.5 rounded-xl flex items-center gap-1.5 transition-all"
                  >
                    <LayoutTemplate className="h-4.5 w-4.5" />
                    Insert Template
                  </button>
                  <button
                    type="button"
                    onClick={handleClearEditor}
                    className="text-sm sm:text-base font-bold text-rose-400 hover:text-rose-300 border border-rose-500/10 bg-rose-500/5 px-4 py-2.5 rounded-xl flex items-center gap-1.5 transition-all"
                  >
                    <Trash2 className="h-4.5 w-4.5" />
                    Clear All
                  </button>
                </div>
              </div>

              <div className="flex flex-col divide-y divide-zinc-800/60">

                {/* FIELD 1: Test Case Title */}
                <div className="flex gap-0 group">
                  <div className="w-1.5 rounded-tl-none bg-blue-500/40 group-focus-within:bg-blue-500 transition-colors shrink-0" />
                  <div className="flex-1 px-5 py-4 flex flex-col gap-1.5">
                    <label className="text-[10px] sm:text-xs font-bold uppercase tracking-widest text-blue-400 flex items-center gap-1.5">
                      <span className="h-4 w-4 rounded bg-blue-500/15 border border-blue-500/30 text-blue-400 flex items-center justify-center text-[9px] font-black">1</span>
                      Test Case Title
                      <span className="text-zinc-600 font-normal normal-case tracking-normal ml-1">— short name for this test scenario</span>
                    </label>
                    <input
                      type="text"
                      value={testTitle}
                      onChange={e => setTestTitle(e.target.value)}
                      placeholder="e.g. Verify Login with Valid Credentials"
                      className="bg-transparent text-base sm:text-lg font-semibold text-white placeholder-zinc-600 focus:outline-none w-full"
                    />
                  </div>
                </div>

                {/* FIELD 2: Description */}
                <div className="flex gap-0 group">
                  <div className="w-1.5 bg-purple-500/40 group-focus-within:bg-purple-500 transition-colors shrink-0" />
                  <div className="flex-1 px-5 py-4 flex flex-col gap-1.5">
                    <label className="text-[10px] sm:text-xs font-bold uppercase tracking-widest text-purple-400 flex items-center gap-1.5">
                      <span className="h-4 w-4 rounded bg-purple-500/15 border border-purple-500/30 text-purple-400 flex items-center justify-center text-[9px] font-black">2</span>
                      Description
                      <span className="text-zinc-600 font-normal normal-case tracking-normal ml-1">— what this test verifies (not executed)</span>
                    </label>
                    <textarea
                      value={testDescription}
                      onChange={e => setTestDescription(e.target.value)}
                      placeholder="e.g. This test ensures a registered user can authenticate successfully using their email and password, and is redirected to the secure dashboard."
                      rows={2}
                      className="bg-transparent text-sm sm:text-base text-zinc-300 placeholder-zinc-600 focus:outline-none resize-none leading-relaxed w-full"
                    />
                  </div>
                </div>

                {/* FIELD 3: Automation Steps — code editor with line numbers */}
                <div className="flex gap-0 group flex-col">
                  <div className="flex gap-0 flex-1">
                    <div className="w-1.5 bg-emerald-500/40 group-focus-within:bg-emerald-500 transition-colors shrink-0" />
                    <div className="flex-1 px-5 pt-4 pb-2 flex flex-col gap-1.5">
                      <label className="text-[10px] sm:text-xs font-bold uppercase tracking-widest text-emerald-400 flex items-center gap-1.5">
                        <span className="h-4 w-4 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center text-[9px] font-black">3</span>
                        Automation Steps
                        <span className="text-zinc-600 font-normal normal-case tracking-normal ml-1">— one step per line, executed in order</span>
                      </label>
                    </div>
                  </div>

                  {/* Code editor with line numbers */}
                  <div className="relative flex min-h-[220px] bg-[#090d16]/50 overflow-hidden border-t border-zinc-800/40">
                    {!stepsText && !isFocused && (
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs font-bold text-zinc-700 tracking-widest uppercase gap-2 select-none">
                        <Upload className="h-4 w-4 text-zinc-700" />
                        Drag and drop .TCE files or type steps below
                      </div>
                    )}
                    {/* Line numbers */}
                    <div className="w-12 bg-zinc-950/20 text-right pr-3 py-4 border-r border-[#1c253c]/30 font-mono text-xs text-zinc-700 select-none leading-relaxed flex flex-col shrink-0">
                      {Array.from({ length: Math.max(lineCount, 10) }).map((_, i) => (
                        <div key={i}>{String(i + 1).padStart(2, '0')}</div>
                      ))}
                    </div>
                    <textarea
                      ref={textareaRef}
                      value={stepsText}
                      onChange={e => setStepsText(e.target.value)}
                      onFocus={() => setIsFocused(true)}
                      onBlur={() => setIsFocused(false)}
                      placeholder={`Navigate to "https://your-website.com/login"\nEnter "your_email@example.com" into input "email"\nEnter "your_password" into input "password"\nClick the "Sign In" button`}
                      className="flex-1 p-4 bg-transparent text-sm sm:text-base font-mono text-zinc-100 placeholder-zinc-700/70 focus:outline-none leading-relaxed resize-y min-h-[220px] z-10"
                    />
                  </div>
                  {/* Steps footer */}
                  <div className="px-5 py-2.5 bg-[#090d16]/30 border-t border-zinc-800/60 flex items-center justify-between text-[10px] sm:text-xs font-mono text-zinc-600">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/60" />
                      {lineCount} step{lineCount !== 1 ? 's' : ''} · UTF-8
                    </span>
                    <span>{charCount} / 5000 chars</span>
                  </div>
                </div>

                {/* FIELD 4: Expected Result */}
                <div className="flex gap-0 group">
                  <div className="w-1.5 bg-amber-500/40 group-focus-within:bg-amber-500 transition-colors shrink-0 rounded-bl-2xl" />
                  <div className="flex-1 px-5 py-4 flex flex-col gap-1.5">
                    <label className="text-[10px] sm:text-xs font-bold uppercase tracking-widest text-amber-400 flex items-center gap-1.5">
                      <span className="h-4 w-4 rounded bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center text-[9px] font-black">4</span>
                      Expected Result
                      <span className="text-zinc-600 font-normal normal-case tracking-normal ml-1">— assertion / verification to run at the end</span>
                    </label>
                    <textarea
                      value={expectedResult}
                      onChange={e => setExpectedResult(e.target.value)}
                      placeholder={`Verify success message "Welcome to the dashboard" exists\nVerify URL contains "/dashboard"\nVerify element "Logout button" is visible`}
                      rows={3}
                      className="bg-transparent text-sm sm:text-base font-mono text-amber-100/80 placeholder-zinc-600 focus:outline-none resize-none leading-relaxed w-full"
                    />
                  </div>
                </div>

              </div>
            </div>

            {/* Right: Parameter Toggles & Environment summary */}
            <div className="flex flex-col gap-6">
              
              {/* ---- BROWSER ENGINE SELECTOR ---- */}
              <div className="border border-zinc-800 bg-[#101524] rounded-2xl p-6 flex flex-col gap-4">
                <h3 className="text-sm sm:text-base font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                  <Globe className="h-4 w-4 text-blue-400" />
                  Browser Engine
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { id: 'chromium', label: 'Chrome', color: 'blue' },
                    { id: 'firefox', label: 'Firefox', color: 'orange' },
                    { id: 'webkit', label: 'Safari', color: 'emerald' },
                  ] as { id: BrowserEngine; label: string; color: string }[]).map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setBrowser(b.id)}
                      className={`py-3 px-2 rounded-xl border text-xs sm:text-sm font-bold transition-all cursor-pointer ${
                        browser === b.id
                          ? b.color === 'blue'
                            ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                            : b.color === 'orange'
                            ? 'bg-orange-600/20 border-orange-500/50 text-orange-300'
                            : 'bg-emerald-600/20 border-emerald-500/50 text-emerald-300'
                          : 'bg-zinc-900/30 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ---- DEVICE MODE SELECTOR ---- */}
              <div className="border border-zinc-800 bg-[#101524] rounded-2xl p-6 flex flex-col gap-4">
                <h3 className="text-sm sm:text-base font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-purple-400" />
                  Device Mode
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'desktop', label: 'Desktop', sub: '1280×800', Icon: Monitor },
                    { id: 'mobile-iphone14', label: 'iPhone 14', sub: '390×844', Icon: Smartphone },
                    { id: 'mobile-android', label: 'Android', sub: '412×915', Icon: Smartphone },
                    { id: 'tablet-ipad', label: 'iPad', sub: '820×1180', Icon: Tablet },
                  ] as { id: DeviceMode; label: string; sub: string; Icon: any }[]).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDeviceMode(d.id)}
                      className={`py-3 px-3 rounded-xl border text-left transition-all cursor-pointer flex items-center gap-2 ${
                        deviceMode === d.id
                          ? 'bg-purple-600/20 border-purple-500/50 text-purple-300'
                          : 'bg-zinc-900/30 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <d.Icon className="h-4 w-4 shrink-0" />
                      <div>
                        <div className="text-xs sm:text-sm font-bold leading-none">{d.label}</div>
                        <div className="text-[10px] sm:text-xs font-mono mt-0.5 opacity-70">{d.sub}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* ---- PARALLEL WORKERS ---- */}
              <div className="border border-zinc-800 bg-[#101524] rounded-2xl p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm sm:text-base font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-400" />
                    Parallel Workers
                  </h3>
                  <span className="text-base sm:text-lg font-mono font-bold text-amber-400">{maxWorkers}x</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={1}
                  value={maxWorkers}
                  onChange={(e) => setMaxWorkers(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] sm:text-xs font-mono text-zinc-600">
                  <span>1 (sequential)</span>
                  <span>2</span>
                  <span>3</span>
                  <span>4 (fastest)</span>
                </div>
                <p className="text-[10px] sm:text-xs text-zinc-500">
                  Each test case (TC01, TC02…) runs in its own browser. Multiple TCs run simultaneously up to this limit.
                </p>
              </div>

              {/* ---- EXECUTION TOGGLE SWITCHES ---- */}
              <div className="border border-zinc-800 bg-[#101524] rounded-2xl p-6 flex flex-col gap-5">
                <h3 className="text-sm sm:text-base font-extrabold uppercase tracking-wider text-zinc-400">Execution Options</h3>
                
                <div className="flex flex-col gap-5">
                  {[
                    { id: 'generateScript', label: 'Generate Playwright Script', desc: 'Auto-convert test cases to Node.js' },
                    { id: 'captureScreenshots', label: 'Capture Screenshots', desc: 'Step-by-step visual documentation' },
                    { id: 'captureConsoleLogs', label: 'Capture Console Logs', desc: 'Record browser STDOUT/STDERR' },
                    { id: 'captureNetworkLogs', label: 'Capture Network Logs', desc: 'HAR file generation for API calls' },
                    { id: 'headless', label: 'Headless Execution', desc: 'Optimized performance (no UI)' },
                  ].map((cfg) => {
                    const active = (config as any)[cfg.id];
                    return (
                      <div key={cfg.id} className="flex items-center justify-between gap-4">
                        <div className="flex flex-col">
                          <span className="text-sm sm:text-base font-bold text-zinc-300">{cfg.label}</span>
                          <span className="text-xs sm:text-sm text-zinc-500 leading-normal mt-0.5">{cfg.desc}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfig(prev => ({ ...prev, [cfg.id]: !active }))}
                          className={`h-7 w-13 rounded-full relative transition-colors cursor-pointer select-none ${
                            active ? 'bg-blue-600' : 'bg-zinc-800'
                          }`}
                        >
                          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all shadow ${
                            active ? 'right-0.5' : 'left-0.5'
                          }`}></span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ---- DYNAMIC ENVIRONMENT SUMMARY ---- */}
              <div className="border border-[#1c253c]/80 bg-[#101524] rounded-2xl p-6 flex flex-col gap-4">
                <h4 className="text-xs sm:text-sm font-bold uppercase tracking-widest text-zinc-500">Environment Summary</h4>
                <div className="flex flex-col gap-3 text-sm sm:text-base">
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-500 font-semibold">Browser:</span>
                    <span className="font-mono text-zinc-300 font-bold capitalize">
                      {browser === 'chromium' ? 'Chrome' : browser === 'webkit' ? 'Safari' : 'Firefox'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-500 font-semibold">Device:</span>
                    <span className="font-mono text-zinc-300 font-bold">
                      {deviceMode === 'desktop' ? 'Desktop' : deviceMode === 'mobile-iphone14' ? 'iPhone 14' : deviceMode === 'mobile-android' ? 'Android' : 'iPad'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-500 font-semibold">Workers:</span>
                    <span className="font-mono text-amber-400 font-bold">{maxWorkers}x parallel</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-500 font-semibold">Mode:</span>
                    <span className="font-mono text-zinc-300 font-bold">{config.headless ? 'Headless' : 'Headed'}</span>
                  </div>
                </div>
              </div>

            </div>

          </div>

          {/* Bottom stats summary bar */}
          <div className="border border-zinc-800 bg-[#101524] rounded-2xl p-6 flex flex-col sm:flex-row items-center justify-between gap-5 mt-2">
            <div className="flex gap-8 text-sm sm:text-base">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs sm:text-sm font-bold text-zinc-500 uppercase tracking-widest">Estimated Time</span>
                <span className="font-mono text-zinc-300 font-bold text-base sm:text-lg">~ 2m 45s</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs sm:text-sm font-bold text-zinc-500 uppercase tracking-widest">Credits Required</span>
                <span className="font-mono text-amber-500 font-extrabold text-base sm:text-lg">12.50</span>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <button className="text-sm sm:text-base text-zinc-400 hover:text-white font-bold transition-all">
                Save as Draft
              </button>
              <button
                type="button"
                onClick={handleStartExecution}
                className="px-8 py-4 rounded-xl font-bold bg-[#3b82f6] text-white hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-500/20 active:scale-[0.99] border border-blue-400/20 flex items-center gap-2 select-none cursor-pointer transition-all text-base sm:text-lg"
              >
                <Play className="h-5 w-5 fill-current" />
                Run Test
              </button>
            </div>
          </div>

        </div>
      )}

      {/* 2. LIVE RUN TIME STATE (Image 2 Layout) */}
      {runStatus === 'executing' && (
        <div className="flex flex-col gap-6 w-full animate-fade-in">
          
          {/* Header titles */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-sm sm:text-base font-bold text-zinc-500 uppercase tracking-wider font-mono">
                AutoQA &gt; {appName.trim() || 'AutoQA Target'} &gt; RUN_#ACTIVE
              </div>
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-white mt-2 flex items-center gap-3">
                Live Execution: {execType} Suite
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-extrabold uppercase bg-blue-500/10 border border-blue-500/25 text-blue-400 animate-pulse">
                  ● In Progress
                </span>
              </h2>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleAbortRun}
                className="px-4.5 py-2.5 rounded-xl border border-zinc-800 bg-zinc-900/60 text-rose-400 hover:bg-zinc-900 text-sm sm:text-base font-bold transition-all flex items-center gap-1.5 cursor-pointer"
              >
                Abort Run
              </button>
              <button className="px-4.5 py-2.5 rounded-xl border border-zinc-850 bg-zinc-900/40 text-zinc-400 hover:text-white text-sm sm:text-base font-bold transition-all">
                Share Live Link
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            
            {/* Left: Pipeline flow */}
            <div className="border border-zinc-800 bg-[#101524] rounded-2xl p-6 flex flex-col gap-5">
              <h3 className="text-sm sm:text-base font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2 border-b border-zinc-900 pb-3">
                <ClipboardList className="h-5 w-5 text-purple-400" />
                Pipeline Flow
              </h3>

              <div className="flex flex-col gap-4 relative">
                {/* Connection line */}
                <div className="absolute left-4 top-2.5 bottom-2 w-px bg-zinc-800"></div>

                {stages.map((stage) => {
                  const isComp = stage.status === 'completed';
                  const isRun = stage.status === 'running';

                  let badgeColor = 'bg-zinc-900 text-zinc-500 border border-zinc-850';
                  let detail = 'PENDING';
                  
                  if (isComp) {
                    badgeColor = 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25';
                    detail = stage.name === 'Browser Started' 
                      ? 'SUCCESS • HEADLESS CHROME' 
                      : stage.name === 'URL Opened' 
                        ? `SUCCESS • ${url}` 
                        : 'SUCCESS • DOM INTERACTIVE NODES MAPPED';
                  } else if (isRun) {
                    badgeColor = 'bg-blue-500/10 text-blue-400 border border-blue-500/25 animate-pulse';
                    detail = 'ACTIVE • RUNNING AUTOMATION SESSION...';
                  }

                  return (
                    <div key={stage.id} className="flex gap-4.5 relative py-0.5">
                      {/* Connection node icon */}
                      <span className={`h-8.5 w-8.5 rounded-full border flex items-center justify-center shrink-0 z-10 ${
                        isComp 
                          ? 'bg-emerald-500 border-emerald-400 text-white' 
                          : isRun 
                            ? 'bg-blue-600 border-blue-400 text-white' 
                            : 'bg-zinc-950 border-zinc-800 text-zinc-650'
                      }`}>
                        {isComp ? (
                          <CheckCircle className="h-5 w-5" />
                        ) : isRun ? (
                          <Play className="h-4 w-4 fill-current" />
                        ) : (
                          <Clock className="h-4 w-4" />
                        )}
                      </span>

                      <div className="flex flex-col gap-0.5">
                        <span className={`text-sm sm:text-base font-bold ${isRun ? 'text-white' : 'text-zinc-400'}`}>{stage.name}</span>
                        <span className="text-xs sm:text-sm font-mono font-medium text-zinc-500 tracking-wide uppercase mt-0.5">{detail}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Metrics & Live Console terminal */}
            <div className="lg:col-span-2 flex flex-col gap-6 w-full">
              
              {/* Metrics cards row - all dynamic from live stages */}
              <div className="grid grid-cols-4 gap-4">
                {((): { label: string; val: string; color: string }[] => {
                  const completedStages = stages.filter(s => s.status === 'completed').length;
                  const totalStages = stages.length;
                  const runningStage = stages.find(s => s.status === 'running');
                  return [
                    { label: 'Pipeline', val: `${completedStages}/${totalStages}`, color: 'text-white' },
                    { label: 'Completed', val: String(completedStages), color: 'text-emerald-400' },
                    { label: 'Pending', val: String(stages.filter(s => s.status === 'pending').length), color: 'text-amber-400' },
                    { label: 'Active Stage', val: runningStage ? runningStage.name.split(' ')[0] : (completedStages === totalStages ? 'Done' : '—'), color: 'text-blue-400' },
                  ];
                })().map((item, idx) => (
                  <div key={idx} className="bg-[#101524] border border-zinc-800 rounded-xl p-4 text-center flex flex-col gap-1">
                    <span className="text-xs sm:text-sm font-bold text-zinc-500 uppercase tracking-widest">{item.label}</span>
                    <span className={`text-base sm:text-lg font-mono font-bold ${item.color}`}>{item.val}</span>
                  </div>
                ))}
              </div>

              {/* Console terminal window */}
              <div className="border border-zinc-800 bg-zinc-950 rounded-2xl overflow-hidden shadow-2xl flex flex-col">
                {/* Terminal Header */}
                <div className="bg-[#101524] border-b border-zinc-850 px-5 py-4 flex items-center justify-between text-zinc-400 font-mono text-sm sm:text-base">
                  <span className="font-bold uppercase tracking-wider flex items-center gap-1.5">
                    <TerminalIcon className="h-5 w-5 text-blue-500" />
                    Live Console Output
                  </span>
                  <div className="flex items-center gap-1.5 select-none">
                    <span className="h-2 w-2 rounded-full bg-rose-500/80"></span>
                    <span className="h-2 w-2 rounded-full bg-amber-500/80"></span>
                    <span className="h-2 w-2 rounded-full bg-emerald-500/80"></span>
                  </div>
                </div>

                {/* Console text screen */}
                <div className="p-5 font-mono text-xs sm:text-sm leading-relaxed text-zinc-300 max-h-[450px] overflow-y-auto bg-black flex flex-col gap-1.5">
                  {liveLogs.map((logLine, logIdx) => {
                    let logColor = 'text-zinc-300';
                    if (logLine.includes('[SUCCESS]') || logLine.includes('passed') || logLine.includes('PASSED')) {
                      logColor = 'text-emerald-400';
                    } else if (logLine.includes('[FAILURE]') || logLine.includes('[ERROR]') || logLine.includes('[FATAL') || logLine.includes('failed') || logLine.includes('FAILED')) {
                      logColor = 'text-rose-400';
                    } else if (logLine.includes('[SKIPPED]') || logLine.includes('skipped')) {
                      logColor = 'text-zinc-500';
                    } else if (logLine.includes('[SCAN') || logLine.includes('Identif')) {
                      logColor = 'text-zinc-500 font-semibold';
                    }
                    return (
                      <div key={logIdx} className={`${logColor}`}>
                        {logLine}
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>

          </div>

        </div>
      )}

      {/* 3. RUN OUTCOME DETAILS STATE (Image 3 Layout) */}
      {runStatus === 'results' && (
        <div className="flex flex-col gap-6 w-full animate-fade-in">
          
          {/* Header block breadcrumbs */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-900 pb-4">
            <div>
              <div className="text-sm sm:text-base font-bold text-zinc-500 uppercase tracking-wider font-mono">
                Execution Result / #{runId}
              </div>
              <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white mt-1 flex items-center gap-2 flex-wrap">
                {appName.trim() || 'AutoQA Target'} ({moduleName.trim() || 'Default Flow'})
                {stepResults.some(s => s.status === 'failed') ? (
                  <span className="h-6 px-3 rounded bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-xs font-bold text-rose-400 gap-1 animate-pulse">
                    <XCircle className="h-4.5 w-4.5" /> FAILED
                  </span>
                ) : (
                  <span className="h-6 px-3 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-xs font-bold text-emerald-400 gap-1">
                    <CheckCircle className="h-4.5 w-4.5" /> PASSED
                  </span>
                )}
              </h2>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <button
                onClick={() => setRunStatus('form')}
                className="flex items-center gap-1.5 text-sm sm:text-base font-bold text-zinc-400 hover:text-white transition-all border border-zinc-800 bg-[#101524] hover:bg-[#1c253c] px-4.5 py-2.5 rounded-xl cursor-pointer"
              >
                <ArrowLeft className="h-4.5 w-4.5 text-blue-500" />
                Configure Run
              </button>

              <a
                href={`/reports/${runId}.html`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-sm sm:text-base font-bold text-zinc-300 hover:text-white transition-all border border-purple-500/20 bg-purple-500/10 hover:bg-purple-500/20 px-4.5 py-2.5 rounded-xl"
              >
                <Eye className="h-4.5 w-4.5 text-purple-400" />
                View HTML Dashboard
              </a>

              {generatedScriptPath && (
                <a
                  href={generatedScriptPath}
                  download
                  className="flex items-center gap-1.5 text-sm sm:text-base font-bold text-zinc-300 hover:text-white transition-all border border-blue-500/20 bg-blue-500/10 hover:bg-blue-500/20 px-4.5 py-2.5 rounded-xl"
                >
                  <FileTerminal className="h-4.5 w-4.5 text-blue-400" />
                  Download Spec
                </a>
              )}
            </div>
          </div>

          {/* Metrics overview */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: 'Total Steps', val: String(stepResults.length), color: 'text-white', rate: null },
              {
                label: 'Passed',
                val: String(stepResults.filter(s => s.status === 'passed').length),
                color: 'text-emerald-400',
                rate: stepResults.length > 0 ? `${((stepResults.filter(s => s.status === 'passed').length / stepResults.length) * 100).toFixed(1)}%` : '0.0%'
              },
              {
                label: 'Failed',
                val: String(stepResults.filter(s => s.status === 'failed').length),
                color: 'text-rose-400',
                rate: stepResults.length > 0 ? `${((stepResults.filter(s => s.status === 'failed').length / stepResults.length) * 100).toFixed(1)}%` : '0.0%'
              },
              {
                label: 'Skipped',
                val: String(stepResults.filter(s => s.status === 'skipped').length),
                color: 'text-zinc-400',
                rate: stepResults.length > 0 ? `${((stepResults.filter(s => s.status === 'skipped').length / stepResults.length) * 100).toFixed(1)}%` : '0.0%'
              },
              { label: 'Duration', val: `${(runDuration / 1000).toFixed(2)}s`, color: 'text-purple-400', rate: null },
            ].map((card, idx) => (
              <div key={idx} className="border border-zinc-800 bg-[#101524] rounded-2xl p-5 flex flex-col justify-between gap-2.5">
                <div className="flex justify-between items-start">
                  <span className="text-xs sm:text-sm font-bold text-zinc-500 uppercase tracking-widest">{card.label}</span>
                  {card.rate && (
                    <span className="text-xs sm:text-sm text-zinc-650 font-bold font-mono">{card.rate}</span>
                  )}
                </div>
                <span className={`text-3xl sm:text-4xl font-extrabold font-mono ${card.color}`}>{card.val}</span>
              </div>
            ))}
          </div>

          {/* Results Table Panel */}
          <div className="border border-zinc-800 bg-[#101524] rounded-2xl flex flex-col overflow-hidden">
            {/* Table Header toolbar */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between gap-4 flex-wrap">
              <h3 className="text-base sm:text-lg font-bold text-white">Test Results</h3>
              
              <div className="relative w-72">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                  <Search className="h-4.5 w-4.5" />
                </div>
                <input
                  type="text"
                  placeholder="Filter cases..."
                  className="w-full bg-[#090d16] border border-zinc-800/80 rounded-xl pl-10 pr-4 py-2.5 text-sm sm:text-base text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
                />
              </div>
            </div>

            {/* Results Table */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-900/35 text-xs sm:text-sm text-zinc-500 font-bold uppercase tracking-wider">
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Test Case</th>
                    <th className="px-6 py-4">Duration</th>
                    <th className="px-6 py-4">Artifacts</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900/50 text-sm sm:text-base font-semibold text-zinc-300">
                  {stepResults.map((r) => {
                    return (
                      <tr key={r.stepIndex} className="hover:bg-zinc-900/10 transition-colors">
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center gap-1.5 text-xs sm:text-sm font-bold ${
                            r.status === 'passed'
                              ? 'text-emerald-400'
                              : r.status === 'skipped'
                                ? 'text-zinc-500'
                                : 'text-rose-400'
                          }`}>
                            <span className={`h-2 w-2 rounded-full ${
                              r.status === 'passed'
                                ? 'bg-emerald-500'
                                : r.status === 'skipped'
                                  ? 'bg-zinc-500'
                                  : 'bg-rose-500'
                            }`}></span>
                            {r.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-white font-medium max-w-xs truncate">
                          {r.rawText}
                        </td>
                        <td className="px-6 py-4 text-zinc-500 font-mono">{(r.durationMs / 1000).toFixed(1)}s</td>
                        <td className="px-6 py-4">
                          {r.screenshot ? (
                            <a href={r.screenshot} target="_blank" rel="noreferrer" className="block h-8 w-12 border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950/85 hover:border-zinc-500 transition-colors relative group">
                              <img src={r.screenshot} alt="Step screenshot thumbnail" className="w-full h-full object-cover" />
                            </a>
                          ) : (
                            <span className="text-zinc-650">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-3.5 text-zinc-400">
                            <button
                              type="button"
                              onClick={() => setSelectedFailedStep(r)}
                              className="hover:text-white p-1 hover:bg-zinc-900 rounded-lg cursor-pointer transition-colors"
                            >
                              <Eye className="h-5 w-5" />
                            </button>
                            <button
                              type="button"
                              className="hover:text-white p-1 hover:bg-zinc-900 rounded-lg cursor-pointer transition-colors"
                            >
                              <FileTerminal className="h-5 w-5 text-blue-500" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer showing real count */}
            <div className="px-6 py-4 bg-[#090d16]/30 border-t border-zinc-800 flex items-center justify-between text-xs sm:text-sm font-semibold text-zinc-500">
              <span>Showing all {stepResults.length} step{stepResults.length !== 1 ? 's' : ''} from this run</span>
              <span className="font-mono text-zinc-600">Run #{runId ? runId.slice(0, 8) : '—'}</span>
            </div>

          </div>

        </div>
      )}

      {/* 4. HIGH FIDELITY AUDIT SLIDE-IN DRAWER */}
      {selectedFailedStep && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-end">
          {/* Overlay click to close */}
          <div className="absolute inset-0" onClick={() => setSelectedFailedStep(null)}></div>
          
          <div className="relative w-full max-w-2xl bg-zinc-950 border-l border-zinc-800 h-full shadow-2xl flex flex-col p-6 overflow-y-auto animate-slide-in">
            {/* Close Button Header */}
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 mb-6">
              <div className="flex items-center gap-3">
                <span className="h-8 w-8 rounded bg-zinc-900 border border-zinc-800 flex items-center justify-center font-mono text-sm text-zinc-400">{selectedFailedStep.stepIndex}</span>
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-white">Execution Step Audit</h3>
                  <p className="text-xs sm:text-sm text-zinc-500 font-mono truncate max-w-[340px]">{selectedFailedStep.rawText}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedFailedStep(null)}
                className="h-8.5 w-8.5 rounded-lg hover:bg-zinc-900 border border-zinc-850 flex items-center justify-center text-zinc-500 hover:text-white transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Tabs Navigation */}
            <div className="flex border-b border-zinc-900 mb-6 gap-2 text-xs sm:text-sm">
              {[
                { id: 'details', name: 'Details & Logs' },
                { id: 'video', name: 'Video Playback' },
                { id: 'network', name: 'Network Waterfall' }
              ].map(t => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveAuditTab(t.id as any)}
                  className={`px-3.5 py-2 font-bold transition-all border-b-2 -mb-px ${
                    activeAuditTab === t.id
                      ? 'border-purple-500 text-purple-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>

            {/* TAB CONTENTS */}
            <div className="flex-1 flex flex-col gap-5">
              
              {/* TAB 1: DETAILS & LOGS */}
              {activeAuditTab === 'details' && (
                <div className="flex flex-col gap-6">
                  <div className="flex justify-between items-center bg-zinc-900/20 p-4 rounded-xl border border-zinc-900">
                    <span className="text-sm font-semibold text-zinc-400">Step Status Outcome</span>
                    <span className={`px-3 py-1 rounded text-xs font-bold ${
                      selectedFailedStep.status === 'passed' 
                        ? 'bg-emerald-500/10 text-emerald-400' 
                        : selectedFailedStep.status === 'skipped'
                          ? 'bg-zinc-500/10 text-zinc-400 border border-zinc-800'
                          : 'bg-rose-500/10 text-rose-400'
                    }`}>
                      {selectedFailedStep.status.toUpperCase()}
                    </span>
                  </div>

                  {selectedFailedStep.status === 'failed' && (
                    <div className="flex flex-col gap-4 border border-zinc-900/60 bg-zinc-900/10 p-5 rounded-2xl">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs uppercase font-bold text-zinc-500 tracking-wider">Expected Assertion Result</span>
                        <p className="text-sm text-zinc-300 leading-relaxed bg-zinc-950 p-2.5 rounded-lg border border-zinc-900 font-medium">
                          {selectedFailedStep.expectedResult || "Expected validation text was not matched in target selectors."}
                        </p>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs uppercase font-bold text-zinc-500 tracking-wider">Actual Assertion Result</span>
                        <p className="text-sm text-rose-400 leading-relaxed bg-rose-500/5 p-2.5 rounded-lg border border-rose-500/10 font-medium">
                          {selectedFailedStep.actualResult || "Target element did not load within threshold parameters."}
                        </p>
                      </div>
                    </div>
                  )}

                  {selectedFailedStep.error && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs uppercase font-bold text-zinc-500 tracking-wider">Error Details Log</span>
                      <div className="bg-rose-500/10 border border-rose-500/25 p-3.5 rounded-xl text-xs font-mono text-rose-400 leading-normal">
                        {selectedFailedStep.error}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-xs uppercase font-bold text-zinc-505 tracking-wider">Step Execution Logs</span>
                      <select 
                        value={logFilter}
                        onChange={e => setLogFilter(e.target.value as any)}
                        className="bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-300 focus:outline-none"
                      >
                        <option value="all">All Logs</option>
                        <option value="info">Info / Success</option>
                        <option value="debug">Debug / Discovery</option>
                        <option value="error">Errors</option>
                      </select>
                    </div>

                    <div className="border border-zinc-900 bg-zinc-950 rounded-xl overflow-hidden font-mono text-xs leading-relaxed max-h-[300px] overflow-y-auto">
                      {(selectedFailedStep.consoleLogs || []).filter(log => {
                        if (logFilter === 'all') return true;
                        if (logFilter === 'info') return log.includes('INFO') || log.includes('SUCCESS') || log.includes('Starting');
                        if (logFilter === 'debug') return log.includes('DEBUG') || log.includes('SCAN') || log.includes('Resolved') || log.includes('Scanning');
                        if (logFilter === 'error') return log.includes('ERROR') || log.includes('FAILURE') || log.includes('FATAL');
                        return true;
                      }).map((log, idx) => {
                        let logColor = 'text-zinc-400';
                        if (log.includes('SUCCESS') || log.includes('passed')) logColor = 'text-emerald-400';
                        if (log.includes('ERROR') || log.includes('FAILURE')) logColor = 'text-rose-400';
                        if (log.includes('SCAN') || log.includes('Scanning')) logColor = 'text-zinc-500';
                        return (
                          <div key={idx} className={`px-3.5 py-2 border-b border-zinc-900 last:border-0 ${logColor}`}>
                            {log}
                          </div>
                        );
                      })}
                      {(!selectedFailedStep.consoleLogs || selectedFailedStep.consoleLogs.length === 0) && (
                        <div className="p-4 text-center text-zinc-650 text-xs">No logs recorded for this step.</div>
                      )}
                    </div>
                  </div>

                  {selectedFailedStep.status === 'failed' && (
                    <button
                      type="button"
                      onClick={generateBugReport}
                      className="w-full py-4.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl font-bold transition-all shadow-lg shadow-rose-500/10 flex items-center justify-center gap-2 select-none cursor-pointer mt-4"
                    >
                      <ShieldAlert className="h-5.5 w-5.5" />
                      Generate Bug Report
                    </button>
                  )}
                </div>
              )}

              {/* TAB 2: VIDEO PLAYBACK (renumbered from 3) */}

              {activeAuditTab === 'video' && (
                <div className="flex flex-col gap-4">
                  {videoPath ? (
                    <div className="flex flex-col gap-4">
                      <video src={videoPath} controls className="w-full rounded-xl border border-zinc-800 bg-black aspect-video shadow-2xl" />
                      <div className="bg-zinc-900/20 border border-zinc-900 rounded-xl p-4.5 text-xs sm:text-sm text-zinc-400 font-mono leading-relaxed">
                        <p className="font-bold text-zinc-350">Video File Details</p>
                        <p className="mt-1 break-all text-zinc-500">Route: {videoPath}</p>
                      </div>
                    </div>
                  ) : (
                    <div className="p-16 text-center text-zinc-600 border border-dashed border-zinc-850 bg-zinc-950/20 rounded-2xl flex flex-col items-center justify-center gap-4">
                      <PlayCircle className="h-12 w-12 text-zinc-700 animate-pulse" />
                      <div>
                        <h4 className="font-bold text-white text-sm">No Video Recording Captured</h4>
                        <p className="text-xs text-zinc-550 mt-1 max-w-xs">
                          Activate "Video Capture Mode" in settings to record full page browser interactions for troubleshooting.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: NETWORK WATERFALL */}
              {activeAuditTab === 'network' && (
                <div className="flex flex-col gap-4">
                  {networkRequests && networkRequests.length > 0 ? (
                    (() => {
                      const firstReqTime = Math.min(...networkRequests.map(r => new Date(r.timestamp).getTime()));
                      const lastReqTime = Math.max(...networkRequests.map(r => new Date(r.timestamp).getTime() + r.durationMs));
                      const totalDuration = lastReqTime - firstReqTime || 1;

                      return (
                        <div className="flex flex-col gap-4">
                          <div className="flex items-center justify-between text-xs font-mono text-zinc-500 border-b border-zinc-900 pb-2">
                            <span>Endpoint URL</span>
                            <span>Timeline Waterfall ({totalDuration}ms)</span>
                          </div>
                          <div className="flex flex-col gap-3.5 max-h-[420px] overflow-y-auto pr-1">
                            {networkRequests.map((req, idx) => {
                              const reqStart = new Date(req.timestamp).getTime();
                              const startOffset = reqStart - firstReqTime;
                              const leftPercent = (startOffset / totalDuration) * 100;
                              const widthPercent = (req.durationMs / totalDuration) * 100;
                              const isSuccess = req.status >= 200 && req.status < 400;

                              return (
                                <div key={idx} className="flex flex-col gap-1.5 border-b border-zinc-900/30 pb-2.5 last:border-0">
                                  <div className="flex justify-between items-start gap-3 text-[11px] font-mono">
                                    <span className="truncate text-zinc-300 font-semibold max-w-[280px]" title={req.url}>
                                      {req.method} {req.url.replace(/^https?:\/\/[^\/]+/i, '') || '/'}
                                    </span>
                                    <span className={`font-bold shrink-0 ${isSuccess ? 'text-emerald-400' : 'text-rose-400'}`}>
                                      {req.status || 'FAIL'}
                                    </span>
                                  </div>
                                  
                                  {/* Bar diagram */}
                                  <div className="w-full bg-zinc-950 h-3.5 rounded overflow-hidden flex relative border border-zinc-900/60">
                                    <div style={{ width: `${leftPercent}%` }} className="shrink-0"></div>
                                    <div 
                                      style={{ width: `${Math.max(widthPercent, 1.5)}%` }} 
                                      className={`h-full rounded-sm ${isSuccess ? 'bg-purple-600/60 border border-purple-500/20' : 'bg-rose-600/60 border border-rose-500/20'}`}
                                      title={`Duration: ${req.durationMs}ms`}
                                    ></div>
                                    <span className="absolute right-2 top-0 text-[9px] text-zinc-550 font-mono leading-none flex items-center h-full">
                                      {req.durationMs}ms
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()
                  ) : (
                    <div className="p-16 text-center text-zinc-650 border border-dashed border-zinc-850 bg-zinc-950/20 rounded-2xl flex flex-col items-center justify-center gap-4 animate-pulse">
                      <Globe className="h-12 w-12 text-zinc-705" />
                      <div>
                        <h4 className="font-bold text-white text-sm">No Network Telemetry Discovered</h4>
                        <p className="text-xs text-zinc-550 mt-1 max-w-xs">
                          Enable "Capture Network Logs" in configurations before launching browser automation execution.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* 5. DYNAMIC GENERATIVE BUG REPORT MODAL */}
      {showBugReport && (
        <div className="fixed inset-0 z-55 bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
          <div className="relative w-full max-w-3xl bg-zinc-950 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col p-6 max-h-[85vh] animate-fade-in text-[#f9fafb]">

            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 mb-4">
              <div className="flex items-center gap-3">
                <ShieldAlert className="h-6 w-6 text-rose-500" />
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-white">Generative Bug Report Evidence</h3>
                  <p className="text-xs sm:text-sm text-zinc-500">Copy this pre-formatted markdown bug report for JIRA/Github issues.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowBugReport(false);
                  setBugCopied(false);
                }}
                className="h-8.5 w-8.5 rounded-lg hover:bg-zinc-900 border border-zinc-850 flex items-center justify-center text-zinc-500 hover:text-white transition-all"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            {/* Scrollable markdown text */}
            <div className="overflow-y-auto flex-1 bg-zinc-900/40 p-5 rounded-2xl border border-zinc-900/80 font-mono text-xs sm:text-sm text-zinc-300 leading-relaxed max-h-[50vh]">
              <pre className="whitespace-pre-wrap select-all">{bugReportContent}</pre>
            </div>

            {/* Actions footer */}
            <div className="flex items-center justify-between border-t border-zinc-900 pt-4 mt-4 text-xs sm:text-sm font-mono text-zinc-500">
              <span className="flex items-center gap-1.5 font-bold text-rose-400">
                <Sparkles className="h-5 w-5" />
                Bug report parsed with high-fidelity evidence
              </span>
              <div className="flex gap-3">
                {generatedScriptPath && (
                  <a
                    href={generatedScriptPath}
                    download
                    className="px-5 py-3 border border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10 text-blue-400 rounded-xl font-bold text-xs sm:text-sm transition-all"
                  >
                    Download Spec / Script
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(bugReportContent);
                    setBugCopied(true);
                    setTimeout(() => setBugCopied(false), 2000);
                  }}
                  className="px-5 py-3 bg-rose-600 hover:bg-rose-500 rounded-xl font-bold text-white text-xs sm:text-sm transition-all cursor-pointer shadow-md flex items-center gap-2"
                >
                  {bugCopied ? 'Copied Successfully!' : 'Copy Bug Report'}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
