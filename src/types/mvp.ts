export type ExecutionType = 'Functional' | 'Smoke' | 'Regression';
export type StageStatus = 'pending' | 'running' | 'completed' | 'failed';

// Browser engine options available in Playwright
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

// Device emulation presets
export type DeviceMode =
  | 'desktop'
  | 'mobile-iphone14'
  | 'mobile-android'
  | 'tablet-ipad';

export interface ExecutionStage {
  id: string;
  name: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface StepExecution {
  stepIndex: number;
  rawText: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  resolvedSelector?: string;
  screenshot?: string;
  error?: string;
  consoleLogs?: string[];
  expectedResult?: string;
  actualResult?: string;
  // Which test case this step belongs to
  tcId?: string;
}

export interface MvpExecution {
  id: string;
  appName: string;
  moduleName: string;
  url: string;
  type: ExecutionType;
  status: 'passed' | 'failed';
  durationMs: number;
  timestamp: string;
  stepsCount: number;
  passedCount: number;
  failedCount: number;
  browser: BrowserEngine;
  deviceMode: DeviceMode;
  config: {
    generateScript: boolean;
    captureScreenshots: boolean;
    captureConsoleLogs: boolean;
    captureNetworkLogs: boolean;
    headless: boolean;
    maxWorkers: number;
  };
  steps: StepExecution[];
}

export interface MvpReport {
  id: string;
  appName: string;
  moduleName: string;
  url: string;
  timestamp: string;
  totalExecutions: number;
  passedCount: number;
  failedCount: number;
  successRate: number;
}

export interface GeneratedScript {
  id: string;
  scriptName: string;
  moduleName: string;
  appName: string;
  createdDate: string;
  content: string;
  browser?: BrowserEngine;
  deviceMode?: DeviceMode;
}
