import { BugReport, APILog, ConsoleLog, StepReport } from '../types';

export interface RCADecision {
  name: string;
  likelihood: number; // percentage (0 - 100)
  reasons: string[];
}

export class BugAutoGenerator {
  /**
   * Generates a complete BugReport for a failed test run.
   */
  async generateBugReport(
    testReportId: string,
    testTitle: string,
    steps: StepReport[],
    apiLogs: APILog[],
    consoleLogs: ConsoleLog[]
  ): Promise<BugReport> {
    const failedStep = steps.find(s => s.status === 'failed');
    const errorMessage = failedStep?.errorMessage || 'Unknown error occurred';
    
    const title = this.generateTitle(failedStep, errorMessage);
    const severity = this.calculateSeverity(failedStep, errorMessage, apiLogs, consoleLogs);
    const rcaRanked = this.analyzeRootCause(failedStep, errorMessage, apiLogs, consoleLogs);
    const rootCauseSummary = this.formatRCASummary(rcaRanked);
    const recommendations = this.generateRecommendations(rcaRanked, failedStep, apiLogs);
    const description = this.generateDescription(
      testTitle, failedStep, errorMessage, steps, apiLogs, consoleLogs, rcaRanked, recommendations
    );
    const category = this.determineCategory(rcaRanked, title);

    const bug: BugReport = {
      id: `bug-${Math.random().toString(36).substring(2, 11)}`,
      testReportId,
      title,
      description,
      severity,
      category,
      rootCause: rootCauseSummary,
      suggestedFix: recommendations.join('\n'),
      status: 'new'
    };

    return bug;
  }

  private generateTitle(failedStep: StepReport | undefined, errorMessage: string): string {
    if (!failedStep) return `Test failed with: ${errorMessage}`;
    let shortErr = errorMessage.split('\n')[0];
    if (shortErr.length > 80) shortErr = shortErr.substring(0, 77) + '...';
    return `Step ${failedStep.stepNumber} failed: ${failedStep.action} - ${shortErr}`;
  }

  private calculateSeverity(
    failedStep: StepReport | undefined,
    errorMessage: string,
    apiLogs: APILog[],
    consoleLogs: ConsoleLog[]
  ): BugReport['severity'] {
    const context = `${failedStep?.action || ''} ${errorMessage}`.toLowerCase();
    const isCriticalKeyword = /login|auth|payment|checkout|sign-in|sign_in|credit-card|transaction|purchase|order/i.test(context);
    const has500Error = apiLogs.some(log => log.statusCode >= 500);
    const hasUncaughtCrash = consoleLogs.some(log => log.message.toLowerCase().includes('uncaught') || log.stackTrace);

    if (isCriticalKeyword && (has500Error || hasUncaughtCrash)) return 'critical';
    if (isCriticalKeyword || has500Error || hasUncaughtCrash) return 'high';
    const isMediumKeyword = /search|filter|sorting|visual|ui|link|nav/i.test(context);
    if (isMediumKeyword) return 'medium';
    return 'low';
  }

  private analyzeRootCause(
    failedStep: StepReport | undefined,
    errorMessage: string,
    apiLogs: APILog[],
    consoleLogs: ConsoleLog[]
  ): RCADecision[] {
    const context = `${failedStep?.action || ''} ${errorMessage}`.toLowerCase();
    
    let dbScore = 5, configScore = 5, serviceScore = 5, testDataScore = 5, uiScore = 5;
    const dbReasons: string[] = [], configReasons: string[] = [], serviceReasons: string[] = [];
    const testDataReasons: string[] = [], uiReasons: string[] = [];

    const failedAPIs = apiLogs.filter(log => log.statusCode >= 400);
    for (const api of failedAPIs) {
      if (api.statusCode >= 500) {
        serviceScore += 25;
        serviceReasons.push(`API ${api.method} ${api.endpoint} returned ${api.statusCode} Server Error`);
        const payloadStr = JSON.stringify(api.responsePayload || {}).toLowerCase();
        if (payloadStr.includes('database') || payloadStr.includes('sql') || payloadStr.includes('postgres')) {
          dbScore += 35;
          dbReasons.push(`Database error trace found in response payload of ${api.endpoint}`);
        }
      } else if (api.statusCode === 401 || api.statusCode === 403) {
        testDataScore += 25;
        testDataReasons.push(`API ${api.method} ${api.endpoint} returned ${api.statusCode} Unauthorized/Forbidden`);
        configScore += 15;
        configReasons.push(`API key or config credential mismatch suspected (${api.statusCode})`);
      } else if (api.statusCode === 404) {
        if (api.endpoint.includes('config') || api.endpoint.includes('.env')) {
          configScore += 30;
          configReasons.push(`Config endpoint returned 404: ${api.endpoint}`);
        } else {
          serviceScore += 10;
          serviceReasons.push(`Endpoint returned 404: ${api.endpoint}`);
        }
      }
    }

    const consoleErrors = consoleLogs.filter(log => log.level === 'error');
    for (const log of consoleErrors) {
      const msg = log.message.toLowerCase();
      if (msg.includes('uncaught') || log.stackTrace) { uiScore += 20; uiReasons.push(`Uncaught JS Exception: "${log.message}"`); }
      if (msg.includes('database') || msg.includes('postgres')) { dbScore += 20; dbReasons.push(`Console DB issue: "${log.message}"`); }
      if (msg.includes('failed to fetch') || msg.includes('cors')) { serviceScore += 20; serviceReasons.push(`Network error: "${log.message}"`); }
    }

    const errLower = errorMessage.toLowerCase();
    if (errLower.includes('database') || errLower.includes('sql') || errLower.includes('query')) { dbScore += 40; dbReasons.push(`Error message contains SQL/Database keywords`); }
    if (errLower.includes('config') || errLower.includes('env') || errLower.includes('api_key')) { configScore += 35; configReasons.push(`Error mentions config parameters`); }
    if (errLower.includes('login') || errLower.includes('credentials') || errLower.includes('unauthorized')) { testDataScore += 35; testDataReasons.push(`Authentication error detected`); }
    if (errLower.includes('timeout') || errLower.includes('not found') || errLower.includes('waiting for selector')) { uiScore += 15; uiReasons.push(`Playwright timeout or missing element`); }

    if (failedAPIs.length === 0 && consoleErrors.length === 0) {
      uiScore += 30;
      uiReasons.push('No backend API failures or console errors recorded. Likely frontend/UI selector issue.');
    }

    const sum = dbScore + configScore + serviceScore + testDataScore + uiScore;
    return [
      { name: 'DATABASE ISSUE', likelihood: Math.round((dbScore / sum) * 100), reasons: dbReasons },
      { name: 'CONFIGURATION ISSUE', likelihood: Math.round((configScore / sum) * 100), reasons: configReasons },
      { name: 'SERVICE ISSUE', likelihood: Math.round((serviceScore / sum) * 100), reasons: serviceReasons },
      { name: 'TEST DATA ISSUE', likelihood: Math.round((testDataScore / sum) * 100), reasons: testDataReasons },
      { name: 'UI / SELECTOR ISSUE', likelihood: Math.round((uiScore / sum) * 100), reasons: uiReasons }
    ].sort((a, b) => b.likelihood - a.likelihood);
  }

  private formatRCASummary(rca: RCADecision[]): string {
    return rca.map((item, idx) => {
      const stars = '⭐'.repeat(Math.max(1, Math.min(5, Math.ceil(item.likelihood / 20))));
      let output = `${idx + 1}. ${stars} ${item.name} (${item.likelihood}% likely)\n`;
      if (item.reasons.length > 0) output += item.reasons.map(r => `   └─ ${r}`).join('\n') + '\n';
      return output;
    }).join('\n');
  }

  private generateRecommendations(rca: RCADecision[], failedStep: StepReport | undefined, apiLogs: APILog[]): string[] {
    const topCause = rca[0].name;
    const recs: string[] = ['For Development Team:', ''];

    if (topCause === 'DATABASE ISSUE') {
      recs.push('1. CHECK DATABASE RECORDS:', '   - Verify user table or matching entity exists.', '2. AUDIT DATABASE CONNECTION:', '   - Verify connection pool limits or lock issues.');
    } else if (topCause === 'CONFIGURATION ISSUE') {
      recs.push('1. AUDIT CONFIGURATION/ENV PARAMETERS:', '   - Check environment variables (.env / Kubernetes ConfigMaps).', '2. CHECK FEATURE FLAGS:', '   - Confirm relevant feature flag parameters are enabled.');
    } else if (topCause === 'SERVICE ISSUE') {
      const firstFail = apiLogs.find(log => log.statusCode >= 400);
      recs.push('1. CHECK API SERVICE HEALTH:');
      if (firstFail) recs.push(`   - Test endpoint health: curl -I -X ${firstFail.method} ${firstFail.fullUrl}`);
      recs.push('2. REVIEW SERVER-SIDE APPLICATION LOGS:', '   - Look for stack traces or runtime crashes.');
    } else if (topCause === 'TEST DATA ISSUE') {
      recs.push('1. VERIFY TEST USER/DATA STATUS:', '   - Check if account is suspended, locked, or expired.', '2. MATCH TEST ENVIRONMENT DATA:', '   - Verify credential values match active seeding scripts.');
    } else {
      recs.push('1. REVIEW UI SELECTORS AND STATE:');
      if (failedStep) recs.push(`   - Inspect DOM structure at failed action: "${failedStep.action}"`);
      recs.push('   - Check if elements are lazy loaded or animations delay visibility.', '2. UPDATE SELECTOR STABILITY:', '   - Prefer resilient selectors (e.g. getByRole, getByText).');
    }
    return recs;
  }

  private generateDescription(
    testTitle: string, failedStep: StepReport | undefined, errorMessage: string,
    steps: StepReport[], apiLogs: APILog[], consoleLogs: ConsoleLog[],
    rca: RCADecision[], recommendations: string[]
  ): string {
    const failedApi = apiLogs.find(l => l.statusCode >= 400);
    const apiDetails = failedApi
      ? `Failed API Endpoint: ${failedApi.method} ${failedApi.endpoint} (Status ${failedApi.statusCode})\nResponse Payload: ${JSON.stringify(failedApi.responsePayload, null, 2)}`
      : 'No backend API failures recorded.';

    const stepDetails = steps.map(s => {
      const symbol = s.status === 'passed' ? '✅' : s.status === 'failed' ? '❌' : '⚠️';
      return `${s.stepNumber}. ${s.action}\n   Expected: ${s.expectedResult}\n   Actual: ${symbol} ${s.actualResult}${s.errorMessage ? `\n   Error: ${s.errorMessage}` : ''}`;
    }).join('\n\n');

    return `BUG DESCRIPTION:\nThe test "${testTitle}" failed during execution.\n\nACTUAL FAILURE:\n${errorMessage}\n\nSTEPS TO REPRODUCE:\n${stepDetails}\n\nAPI DIAGNOSTICS:\n${apiDetails}\n\nCONSOLE ERROR LOGS:\n${consoleLogs.filter(l => l.level === 'error').map(l => `[${l.level.toUpperCase()}] ${l.message}${l.stackTrace ? `\nStack:\n${l.stackTrace}` : ''}`).join('\n') || 'No console errors recorded.'}\n\nROOT CAUSE ANALYSIS SUGGESTIONS:\n${rca.map(item => `- ${item.name} (${item.likelihood}% probability)`).join('\n')}\n\nRECOMMENDED RESOLUTION STEPS:\n${recommendations.join('\n')}`;
  }

  private determineCategory(rca: RCADecision[], title: string): string {
    const topCause = rca[0].name;
    if (topCause === 'DATABASE ISSUE') return 'Database';
    if (topCause === 'CONFIGURATION ISSUE') return 'Configuration';
    if (topCause === 'SERVICE ISSUE') return 'Backend Service';
    if (topCause === 'TEST DATA ISSUE') return 'Test Data';
    const titleLower = title.toLowerCase();
    if (titleLower.includes('login') || titleLower.includes('auth')) return 'Authentication';
    if (titleLower.includes('payment') || titleLower.includes('checkout')) return 'Payment Gateway';
    return 'Frontend UI';
  }
}
