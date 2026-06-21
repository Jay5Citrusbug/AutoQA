import { 
  TestReport, 
  StepReport, 
  APILog, 
  ConsoleLog, 
  BugReport, 
  EvidenceMetadata,
  ExecutionContext
} from '../types';

export class DbRepository {
  // In-memory tables
  private testReports: Map<string, TestReport> = new Map();
  private stepReports: Map<string, StepReport[]> = new Map(); // Key: reportId
  private apiLogs: Map<string, APILog[]> = new Map(); // Key: executionId
  private consoleLogs: Map<string, ConsoleLog[]> = new Map(); // Key: executionId
  private bugReports: Map<string, BugReport> = new Map(); // Key: id, but we also search by testReportId
  private evidenceMetadata: Map<string, EvidenceMetadata[]> = new Map(); // Key: executionId
  private executions: Map<string, ExecutionContext> = new Map();
  private users: Map<string, { id: string; name: string; email: string; role: string }> = new Map();

  constructor() {
    // Seed some mock users and default values
    this.seedDefaultData();
  }

  private seedDefaultData() {
    const defaultUser = {
      id: 'usr-999f888e-777d-666c-555b-444a33332222',
      name: 'John Dev',
      email: 'dev-team-lead@company.com',
      role: 'Lead Developer'
    };
    this.users.set(defaultUser.id, defaultUser);
  }

  // ExecutionContext
  async saveExecutionContext(context: ExecutionContext): Promise<void> {
    this.executions.set(context.executionId, context);
  }

  async getExecutionContext(executionId: string): Promise<ExecutionContext | undefined> {
    return this.executions.get(executionId);
  }

  // TestReport
  async saveTestReport(report: TestReport): Promise<void> {
    this.testReports.set(report.id, {
      ...report,
      createdAt: report.createdAt || new Date().toISOString()
    });
  }

  async getTestReport(id: string): Promise<TestReport | undefined> {
    return this.testReports.get(id);
  }

  async getAllTestReports(): Promise<TestReport[]> {
    return Array.from(this.testReports.values());
  }

  // StepReport
  async saveStepReports(steps: StepReport[]): Promise<void> {
    if (steps.length === 0) return;
    const reportId = steps[0].reportId;
    const existing = this.stepReports.get(reportId) || [];
    
    const updated = [...existing];
    for (const step of steps) {
      const idx = updated.findIndex(s => s.id === step.id || s.stepNumber === step.stepNumber);
      if (idx >= 0) {
        updated[idx] = { ...step, createdAt: step.createdAt || new Date().toISOString() };
      } else {
        updated.push({ ...step, createdAt: step.createdAt || new Date().toISOString() });
      }
    }
    
    this.stepReports.set(reportId, updated.sort((a, b) => a.stepNumber - b.stepNumber));
  }

  async getStepReports(reportId: string): Promise<StepReport[]> {
    return this.stepReports.get(reportId) || [];
  }

  // APILogs
  async saveAPILogs(logs: APILog[]): Promise<void> {
    for (const log of logs) {
      const executionId = log.executionId;
      const list = this.apiLogs.get(executionId) || [];
      list.push(log);
      this.apiLogs.set(executionId, list);
    }
  }

  async getAPILogs(executionId: string): Promise<APILog[]> {
    return this.apiLogs.get(executionId) || [];
  }

  // ConsoleLogs
  async saveConsoleLogs(logs: ConsoleLog[]): Promise<void> {
    for (const log of logs) {
      const executionId = log.executionId;
      const list = this.consoleLogs.get(executionId) || [];
      list.push(log);
      this.consoleLogs.set(executionId, list);
    }
  }

  async getConsoleLogs(executionId: string): Promise<ConsoleLog[]> {
    return this.consoleLogs.get(executionId) || [];
  }

  // BugReports
  async saveBugReport(bug: BugReport): Promise<void> {
    this.bugReports.set(bug.id, {
      ...bug,
      createdAt: bug.createdAt || new Date().toISOString(),
      updatedAt: bug.updatedAt || new Date().toISOString()
    });
  }

  async getBugReport(id: string): Promise<BugReport | undefined> {
    return this.bugReports.get(id);
  }

  async getBugReportByTestReport(testReportId: string): Promise<BugReport | undefined> {
    return Array.from(this.bugReports.values()).find(bug => bug.testReportId === testReportId);
  }

  async getAllBugReports(): Promise<BugReport[]> {
    return Array.from(this.bugReports.values());
  }

  async updateBugReport(id: string, updates: Partial<BugReport>): Promise<void> {
    const existing = this.bugReports.get(id);
    if (!existing) {
      throw new Error(`Bug report with ID ${id} not found.`);
    }
    this.bugReports.set(id, {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    });
  }

  // EvidenceMetadata
  async saveEvidenceMetadata(metadata: EvidenceMetadata[]): Promise<void> {
    for (const item of metadata) {
      const executionId = item.executionId;
      const list = this.evidenceMetadata.get(executionId) || [];
      list.push({
        ...item,
        createdAt: item.createdAt || new Date().toISOString()
      });
      this.evidenceMetadata.set(executionId, list);
    }
  }

  async getEvidenceMetadata(executionId: string): Promise<EvidenceMetadata[]> {
    return this.evidenceMetadata.get(executionId) || [];
  }

  // Users lookup
  async getUser(id: string): Promise<{ id: string; name: string; email: string; role: string } | undefined> {
    return this.users.get(id);
  }

  async getAllUsers(): Promise<Array<{ id: string; name: string; email: string; role: string }>> {
    return Array.from(this.users.values());
  }

  async addUser(user: { id: string; name: string; email: string; role: string }): Promise<void> {
    this.users.set(user.id, user);
  }

  // Clear in-memory db (for testing)
  clear(): void {
    this.testReports.clear();
    this.stepReports.clear();
    this.apiLogs.clear();
    this.consoleLogs.clear();
    this.bugReports.clear();
    this.evidenceMetadata.clear();
    this.executions.clear();
    this.users.clear();
    this.seedDefaultData();
  }
}
