import { ExecutionContext } from './execution';

export interface ReportSummary {
  runId: string;
  url: string;
  appName?: string;
  moduleName?: string;
  title: string;
  timestamp: string;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  durationMs: number;
  status: 'passed' | 'failed';
}

export interface ReportPayload {
  summary: ReportSummary;
  details: ExecutionContext;
}

export interface RunHistory {
  runs: ReportSummary[];
}
