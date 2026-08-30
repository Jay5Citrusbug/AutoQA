import { ParsedStep } from './testCase';
import { BrowserEngine, DeviceMode } from './mvp';
import { RemoteArtifact } from '@/lib/report-bug-tracker/types';

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
  /** Actual size of the screenshot file on disk, in bytes. */
  screenshotSizeBytes?: number;
  /** Cloudinary copy of the screenshot; absent when the upload was skipped or failed. */
  screenshotRemote?: RemoteArtifact;
  error?: string;
  durationMs: number;
  logs: string[];
  // Failure-context evidence (populated only when a step fails).
  domSnapshotPath?: string;
  pageUrl?: string;
  /**
   * True when this login step was satisfied by a cached authenticated session
   * instead of being replayed through the UI. The selector/screenshot carried
   * here come from the one real login that primed the session.
   */
  reusedSession?: boolean;
  /**
   * Why a passing assertion was accepted on something other than a literal
   * comparison — e.g. the app's landing page is /desktop/home and the test
   * asked for /dashboard. Present only on such passes, so they stay visible.
   */
  assertionNote?: string;
  /**
   * The value the runner invented because the step named a field but no value
   * ("Enter workpod name"). Recorded so the report states exactly what was
   * typed: auto-supplied data that only exists inside the run is data the
   * reader cannot reproduce or trust.
   */
  autoSuppliedValue?: string;
  /**
   * Which engine produced this result. Absent on results predating hybrid
   * execution, so readers must treat undefined as 'deterministic'.
   */
  executedBy?: 'deterministic' | 'ai';
  /**
   * The agent's own account of its verdict. Present only on AI-executed steps —
   * a verdict a reader cannot inspect is a verdict they cannot trust.
   */
  aiReasoning?: string;
  /** What the step expected, as the agent understood it. */
  aiExpected?: string;
  /** What the agent actually observed. */
  aiActual?: string;
  /**
   * Why this step left the deterministic engine. Kept even when the agent then
   * passes it, because a step that needs AI every run is a step worth rewriting.
   */
  aiHandoffReason?: string;
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
  /** `@fresh-login` in the test text — always perform a real login for this TC. */
  freshLogin?: boolean;
  /** `@reuse-session` in the test text — reuse a cached login even if this TC looks like a login test. */
  forceReuse?: boolean;
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
  // Auto-drafted/filed bug for a failed run (Phase 4.4)
  bugReport?: BugReportSummary;
  /** How login-session reuse behaved for this run. */
  sessionReuse?: SessionReuseSummary;
  /**
   * Whether a failed run failed because the application misbehaved, because the
   * automation could not carry out a step, or because of the environment. Only
   * the first is raised as a product bug.
   */
  failureClassification?: FailureClassification;
  /** What AI execution cost this run. Absent when no step escalated. */
  aiUsage?: AiUsageSummary;
}

/** Token and cost totals for a run's AI-executed steps. */
export interface AiUsageSummary {
  model: string;
  stepsExecutedByAi: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

/** Verdict on what a failed run actually tells you. See core/reporting/failureClassifier. */
export interface FailureClassification {
  kind: 'product-defect' | 'automation-gap' | 'environment';
  label: string;
  reason: string;
  nextStep: string;
  fileAsBug: boolean;
  stepIndex?: number;
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
  /** Actual size of the recording on disk, in bytes. */
  videoSizeBytes?: number;
  /** Cloudinary copy of the session recording; absent when the upload was skipped or failed. */
  videoRemote?: RemoteArtifact;
  /** Playwright trace archive (.zip), openable in the Trace Viewer. */
  tracePath?: string;
  /** Actual size of the trace archive on disk, in bytes. */
  traceSizeBytes?: number;
  /** Cloudinary copy of the trace; what makes the hosted Trace Viewer able to load it. */
  traceRemote?: RemoteArtifact;
  networkRequests?: NetworkRequestRecord[];
  scriptVerification?: ScriptVerificationResult;
  consoleLogs?: ConsoleMessageRecord[];
  networkErrors?: NetworkErrorRecord[];
  /** True when this suite started from a cached authenticated session (login UI skipped). */
  sessionReused?: boolean;
  /** True when this suite failed on a reused session and was re-run with a real login. */
  retriedWithFreshLogin?: boolean;
}

/** Aggregate view of how session reuse behaved during a run (surfaced in reports/UI). */
export interface SessionReuseSummary {
  enabled: boolean;
  /** Distinct login flows primed during this run. */
  primedLogins: number;
  /** Suites that started from a cached session instead of logging in. */
  reusedSuites: number;
  /** Suites that had to log in themselves (negative-login, logout, or cache miss). */
  freshLoginSuites: number;
  /** Estimated wall-clock saved, summed from the primed login durations. */
  estimatedSavedMs: number;
}

/** Auto-drafted bug summary surfaced on a failed run (Phase 4.4). */
export interface BugReportSummary {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category?: string;
  rootCause?: string;
  suggestedFix?: string;
  /** 'drafted' = evidence only; 'filed' = a Jira issue was created. */
  disposition: 'drafted' | 'filed';
  jiraIssueId?: string;
  jiraUrl?: string;
  jiraMock?: boolean;
}
