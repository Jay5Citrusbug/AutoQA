import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { ReportPayload, ReportSummary } from '@/types/report';
import { TestCase } from '@/types/testCase';

// Base storage paths relative to workspace root (d:\Automation\AutoQA\qa-login-agent)
const ROOT_DIR = path.resolve(process.cwd());

export const PATHS = {
  REPORTS: path.join(ROOT_DIR, 'reports'),
  SCREENSHOTS: path.join(ROOT_DIR, 'screenshots'),
  VIDEOS: path.join(ROOT_DIR, 'videos'),
  LOGS: path.join(ROOT_DIR, 'logs'),
  GENERATED_TESTS: path.join(ROOT_DIR, 'generated-tests'),
  TEST_RUNS: path.join(ROOT_DIR, 'test-runs'),
};

export const fileHelper = {
  /**
   * Initializes all required storage folders at startup
   */
  ensureDirectories() {
    Object.values(PATHS).forEach((dirPath) => {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logger.info(`Created directory: ${dirPath}`);
      }
    });
  },

  /**
   * Safe JSON writer
   */
  writeJson(filePath: string, data: any): void {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      logger.error(`Failed to write JSON to ${filePath}`, error);
    }
  },

  /**
   * Safe JSON reader
   */
  readJson<T>(filePath: string): T | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      logger.error(`Failed to read JSON from ${filePath}`, error);
      return null;
    }
  },

  /**
   * Safe text writer
   */
  writeText(filePath: string, content: string): void {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (error) {
      logger.error(`Failed to write text to ${filePath}`, error);
    }
  },

  /**
   * Saves execution details and appends to run history log
   */
  saveReport(payload: ReportPayload) {
    this.ensureDirectories();

    const runId = payload.summary.runId;
    const jsonPath = path.join(PATHS.REPORTS, `${runId}.json`);
    
    // Save full JSON payload
    this.writeJson(jsonPath, payload);
    logger.info(`Saved report JSON to: ${jsonPath}`);

    // Append to run history database index
    const historyPath = path.join(PATHS.REPORTS, 'history-index.json');
    let history = this.readJson<ReportSummary[]>(historyPath) || [];
    
    // Ensure no duplicates
    history = history.filter(h => h.runId !== runId);
    history.unshift(payload.summary); // Add latest run first
    
    this.writeJson(historyPath, history);
    logger.info(`Updated report history list`);
  },

  /**
   * Retrieves full history log index
   */
  getHistory(): ReportSummary[] {
    const historyPath = path.join(PATHS.REPORTS, 'history-index.json');
    return this.readJson<ReportSummary[]>(historyPath) || [];
  },

  /**
   * Retrieves report details by runId
   */
  getReport(runId: string): ReportPayload | null {
    const jsonPath = path.join(PATHS.REPORTS, `${runId}.json`);
    return this.readJson<ReportPayload>(jsonPath);
  },

  /**
   * Saves or updates a testcase in the local JSON database
   */
  saveTestCase(testCase: TestCase) {
    this.ensureDirectories();
    const testCasesPath = path.join(PATHS.REPORTS, 'test-cases.json');
    let testCases = this.readJson<TestCase[]>(testCasesPath) || [];
    
    // Replace if exists, otherwise append
    testCases = testCases.filter(t => t.id !== testCase.id);
    testCases.unshift(testCase); // New/updated first
    
    this.writeJson(testCasesPath, testCases);
    logger.info(`Saved test case to: ${testCasesPath}`);
  },

  /**
   * Retrieves all saved testcases
   */
  getTestCases(): TestCase[] {
    const testCasesPath = path.join(PATHS.REPORTS, 'test-cases.json');
    return this.readJson<TestCase[]>(testCasesPath) || [];
  },

  /**
   * Retrieves a specific testcase by ID
   */
  getTestCase(id: string): TestCase | null {
    const testCases = this.getTestCases();
    return testCases.find(t => t.id === id) || null;
  },

  /**
   * Deletes a testcase by ID
   */
  deleteTestCase(id: string): boolean {
    const testCasesPath = path.join(PATHS.REPORTS, 'test-cases.json');
    let testCases = this.readJson<TestCase[]>(testCasesPath) || [];
    const initialLength = testCases.length;
    testCases = testCases.filter(t => t.id !== id);
    
    if (testCases.length < initialLength) {
      this.writeJson(testCasesPath, testCases);
      logger.info(`Deleted test case ID: ${id}`);
      return true;
    }
    return false;
  },

  /**
   * Retrieves persistent settings
   */
  getSettings(): any {
    const settingsPath = path.join(PATHS.REPORTS, 'settings.json');
    const defaults = {
      screenshotCapture: 'on-failure',
      videoCapture: 'off',
      headlessMode: true,
      defaultTimeout: 30,
      reportFormat: 'both'
    };
    const settings = this.readJson<any>(settingsPath);
    return settings ? { ...defaults, ...settings } : defaults;
  },

  /**
   * Saves settings
   */
  saveSettings(settings: any): void {
    this.ensureDirectories();
    const settingsPath = path.join(PATHS.REPORTS, 'settings.json');
    this.writeJson(settingsPath, settings);
    logger.info(`Saved settings to: ${settingsPath}`);
  }
};
