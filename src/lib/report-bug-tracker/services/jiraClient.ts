import { BugReport } from '../types';

export interface JiraConfig {
  baseUrl: string;
  projectKey: string;
  apiToken?: string;
  email?: string;
  isMockMode?: boolean;
}

export class JiraClient {
  private config: JiraConfig;

  constructor(config: JiraConfig) {
    this.config = {
      isMockMode: true,
      ...config
    };
  }

  async createIssue(bug: BugReport): Promise<{ issueId: string; url: string }> {
    const priorityName = this.mapSeverityToJiraPriority(bug.severity);
    const componentName = bug.category || 'QA Automation';
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 1);

    const payload = {
      fields: {
        project: { key: this.config.projectKey },
        issuetype: { name: 'Bug' },
        summary: bug.title,
        description: bug.description,
        priority: { name: priorityName },
        labels: ['automation', bug.severity, 'blocked'],
        components: [{ name: componentName }],
        assignee: { name: 'dev-team-lead' },
        duedate: dueDate.toISOString().split('T')[0],
        customfield_environment: 'Production'
      }
    };

    if (this.config.isMockMode) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const mockIssueId = `${this.config.projectKey}-${Math.floor(10000 + Math.random() * 90000)}`;
      const mockUrl = `${this.config.baseUrl}/browse/${mockIssueId}`;
      console.log(`[JiraClient] [MOCK MODE] Created Jira Bug ticket ${mockIssueId}`);
      return { issueId: mockIssueId, url: mockUrl };
    } else {
      const authHeader = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
      const response = await fetch(`${this.config.baseUrl}/rest/api/2/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${authHeader}` },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Jira API returned status ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as { key: string; self: string };
      return { issueId: data.key, url: `${this.config.baseUrl}/browse/${data.key}` };
    }
  }

  private mapSeverityToJiraPriority(severity: BugReport['severity']): string {
    switch (severity) {
      case 'critical': return 'Highest';
      case 'high': return 'High';
      case 'medium': return 'Medium';
      default: return 'Low';
    }
  }
}
