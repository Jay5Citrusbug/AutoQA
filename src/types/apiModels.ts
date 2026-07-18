import { z } from 'zod';

// --- ZOD SCHEMAS ---

// Request validation for POST /api/run-test
export const RunTestRequestSchema = z.object({
  runId: z.string().optional(),
  url: z.string().url('Invalid target URL format'),
  appName: z.string().min(1, 'Application Name is required'),
  moduleName: z.string().min(1, 'Module Name is required'),
  execType: z.enum(['Functional', 'Smoke', 'Regression']),
  stepsText: z.string().min(1, 'Test steps are required'),
  browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  deviceMode: z
    .enum(['desktop', 'mobile-iphone14', 'mobile-android', 'tablet-ipad'])
    .default('desktop'),
  maxWorkers: z.number().int().min(1).max(8).default(1),
  config: z.object({
    generateScript: z.boolean().default(true),
    verifyScript: z.boolean().default(false),
    captureScreenshots: z.boolean().default(true),
    captureConsoleLogs: z.boolean().default(false),
    captureNetworkLogs: z.boolean().default(false),
    headless: z.boolean().default(true),
  }),
});

// Query validation for GET /api/reports
export const ReportsQuerySchema = z.object({
  runId: z.string().optional(),
  appName: z.string().optional(),
  moduleName: z.string().optional(),
  status: z.enum(['passed', 'failed', 'all']).optional().default('all'),
});

// Query validation for GET /api/scripts
export const ScriptsQuerySchema = z.object({
  appName: z.string().optional(),
  moduleName: z.string().optional(),
});

// --- TYPES DERIVED FROM SCHEMAS ---

export type RunTestRequest = z.infer<typeof RunTestRequestSchema>;
export type ReportsQuery = z.infer<typeof ReportsQuerySchema>;
export type ScriptsQuery = z.infer<typeof ScriptsQuerySchema>;

// --- RESPONSE MODELS ---

export interface APIErrorResponse {
  error: string;
  details?: any;
}

export interface APIRunTestResponse {
  runId: string;
  appName: string;
  moduleName: string;
  url: string;
  type: 'Functional' | 'Smoke' | 'Regression';
  status: 'passed' | 'failed';
  durationMs: number;
  timestamp: string;
  passedCount: number;
  failedCount: number;
  totalCount: number;
  browser: string;
  deviceMode: string;
  steps: {
    stepIndex: number;
    rawText: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    resolvedSelector?: string;
    screenshot?: string;
    error?: string;
    tcId?: string;
  }[];
  generatedScriptPath?: string;
  testSuites?: {
    tcId: string;
    title: string;
    status: 'passed' | 'failed';
    durationMs: number;
    generatedScriptPath?: string;
  }[];
}
