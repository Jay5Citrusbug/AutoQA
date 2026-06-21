// Type definitions for the Report Generation & Bug Tracking System

export interface ExecutionContext {
  executionId: string;
  testCaseId: string;
  name?: string;
  environment?: string;
  triggeredBy?: string;
  startedAt: string; // ISO date string
}

export interface APILog {
  id: string;
  timestamp: string; // ISO date string
  
  // Request Details
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint: string;
  fullUrl: string;
  
  // Headers (sanitized - Authorization redacted)
  headers: Record<string, string>;
  
  // Request Body
  requestPayload: any;
  requestSize: number; // bytes
  
  // Response Details
  statusCode: number;
  statusText: string;
  responsePayload: any;
  responseSize: number; // bytes
  
  // Timing
  requestTime: string; // ISO timestamp
  responseTime: string; // ISO timestamp
  duration: number; // milliseconds
  
  // Context
  testCaseId: string;
  executionId: string;
  stepNumber?: number;
  
  // Network
  ipAddress?: string;
  userAgent?: string;
  
  // Errors
  errorMessage?: string;
  errorCode?: string;
}

export interface ConsoleLog {
  id: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  args: any[];
  
  stackTrace?: string;
  sourceFile?: string;
  lineNumber?: number;
  
  timestamp: string; // ISO date string
  executionId: string;
}

export interface TestReport {
  id: string;
  executionId: string;
  testCaseId: string;
  status: 'passed' | 'failed';
  summary?: string;
  
  startedAt: string; // ISO date string
  completedAt: string; // ISO date string
  durationMs: number;
  
  videoPath?: string;
  videoSizeBytes?: number;
  
  reportJson?: any; // parsed object or JSON string
  reportHtml?: string;
  
  createdAt?: string; // ISO date string
}

export interface StepReport {
  id: string;
  reportId: string;
  stepNumber: number;
  
  action: string;
  expectedResult: string;
  actualResult: string;
  
  status: 'passed' | 'failed' | 'not_reached';
  errorMessage?: string;
  
  screenshotPath?: string;
  screenshotSizeBytes?: number;
  
  createdAt?: string; // ISO date string
}

export interface BugReport {
  id: string;
  testReportId: string;
  
  title: string;
  description: string;
  
  severity: 'critical' | 'high' | 'medium' | 'low';
  category?: string;
  
  rootCause?: string;
  suggestedFix?: string;
  
  jiraIssueId?: string;
  jiraUrl?: string;
  
  status: 'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'closed';
  assignedTo?: string; // User ID
  
  createdAt?: string; // ISO date string
  updatedAt?: string; // ISO date string
  resolvedAt?: string; // ISO date string
}

export interface EvidenceMetadata {
  id: string;
  executionId: string;
  type: 'video' | 'screenshot' | 'console_log' | 'network_log' | 'har_file';
  
  filePath: string;
  fileSizeBytes: number;
  storageType: 's3' | 'gcs' | 'local';
  
  publicUrl?: string;
  expirationDate?: string; // ISO date string
  
  createdAt?: string; // ISO date string
}

export interface TestExecutionData {
  context: ExecutionContext;
  steps: Array<{
    stepNumber: number;
    action: string;
    expectedResult: string;
    actualResult: string;
    status: 'passed' | 'failed' | 'not_reached';
    errorMessage?: string;
    screenshotPath?: string;
    screenshotSizeBytes?: number;
  }>;
  status: 'passed' | 'failed';
  summary?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  videoPath?: string;
  videoSizeBytes?: number;
}
