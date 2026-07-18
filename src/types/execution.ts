import { ParsedStep } from './testCase';
import { BrowserEngine, DeviceMode } from './mvp';

export interface DiscoveryMatch {
  selector: string;
  score: number;
  /** Signal name from scoring engine (e.g. 'aria-label:exact', 'type-inference:input[type=email]', 'fallback') */
  strategy: string;
  tagName: string;
  attributes: Record<string, string>;
}

export interface LocatorMap {
  [fieldName: string]: DiscoveryMatch;
}

export interface StepExecutionResult {
  stepIndex: number;
  step: ParsedStep;
  status: 'passed' | 'failed' | 'skipped';
  resolvedSelector?: string;
  screenshotPath?: string;
  error?: string;
  durationMs: number;
  logs: string[];
}

export interface ConsoleMessageRecord {
  type: 'log' | 'error' | 'warn' | 'info' | 'debug';
  text: string;
  timestamp: string;
}

export interface NetworkErrorRecord {
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  errorMessage: string;
  timestamp: string;
}

export interface NetworkRequestRecord {
  url: string;
  method: string;
  status: number;
  contentType: string;
  durationMs: number;
  timestamp: string;
}

// Represents a single parsed test case block (TC01, TC02, etc.)
export interface TestSuite {
  id: string;          // e.g. "TC01"
  title: string;       // full header line
  steps: ParsedStep[];
}

export interface ExecutionContext {
  runId: string;
  url: string;
  appName?: string;
  moduleName?: string;
  browser: BrowserEngine;
  deviceMode: DeviceMode;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  durationMs?: number;
  locatorMap: LocatorMap;
  stepResults: StepExecutionResult[];
  consoleLogs: ConsoleMessageRecord[];
  networkErrors: NetworkErrorRecord[];
  networkRequests?: NetworkRequestRecord[];
  generatedScriptPath?: string;
  // Per-TC grouped results (when multiple TCs are run)
  testSuiteResults?: TestSuiteResult[];
}

export type ScriptVerificationStatus = 'verified' | 'broken' | 'skipped' | 'error';

export interface ScriptVerificationResult {
  status: ScriptVerificationStatus;
  durationMs: number;
  /** Trimmed stdout/stderr from the Playwright run, for surfacing failures. */
  output?: string;
}

export interface TestSuiteResult {
  tcId: string;
  title: string;
  status: 'passed' | 'failed';
  durationMs: number;
  stepResults: StepExecutionResult[];
  generatedScriptPath?: string;
  videoPath?: string;
  networkRequests?: NetworkRequestRecord[];
  scriptVerification?: ScriptVerificationResult;
}
