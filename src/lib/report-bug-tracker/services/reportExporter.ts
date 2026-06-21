import { TestReport, StepReport, APILog, ConsoleLog, BugReport, EvidenceMetadata } from '../types';

export class ReportExporter {
  /**
   * Serializes a test execution report to a structured JSON string.
   */
  exportToJson(
    report: TestReport,
    steps: StepReport[],
    apiLogs: APILog[],
    consoleLogs: ConsoleLog[],
    bug?: BugReport,
    evidence?: EvidenceMetadata[]
  ): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        report,
        steps,
        evidence: {
          metadata: evidence || [],
          apiLogs,
          consoleLogs
        },
        bugReport: bug || null
      },
      null,
      2
    );
  }

  /**
   * Generates a clean HTML summary template suitable for transactional emails.
   */
  exportToEmail(
    report: TestReport,
    steps: StepReport[],
    apiLogs: APILog[],
    consoleLogs: ConsoleLog[],
    bug?: BugReport,
    evidence?: EvidenceMetadata[]
  ): string {
    const isPass = report.status === 'passed';
    const statusColor = isPass ? '#10B981' : '#EF4444';
    const statusText = isPass ? '✅ PASSED' : '❌ FAILED';
    
    let bugSection = '';
    if (bug) {
      bugSection = `
        <div style="margin-top: 20px; padding: 15px; border-left: 4px solid #EF4444; background-color: #FEF2F2; border-radius: 4px;">
          <h3 style="color: #991B1B; margin-top: 0;">Bug Report Created</h3>
          <p><strong>Title:</strong> ${bug.title}</p>
          <p><strong>Severity:</strong> <span style="background-color: #FEE2E2; color: #991B1B; padding: 2px 6px; border-radius: 4px; font-weight: bold;">${bug.severity.toUpperCase()}</span></p>
          <p><strong>Jira Ticket:</strong> <a href="${bug.jiraUrl || '#'}" style="color: #2563EB; font-weight: bold;">${bug.jiraIssueId || 'N/A'}</a></p>
          <p><strong>Root Cause:</strong></p>
          <pre style="background: #FFF; padding: 10px; border: 1px solid #E5E7EB; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 12px; max-height: 200px;">${bug.rootCause || 'N/A'}</pre>
        </div>
      `;
    }

    const stepList = steps
      .map(
        s => `
        <li style="margin-bottom: 8px; font-size: 14px;">
          <span style="color: ${s.status === 'passed' ? '#10B981' : s.status === 'failed' ? '#EF4444' : '#9CA3AF'}">
            ${s.status === 'passed' ? '●' : s.status === 'failed' ? '✖' : '○'}
          </span>
          <strong>Step ${s.stepNumber}:</strong> ${s.action} - 
          <em>${s.status.toUpperCase()}</em>
        </li>
      `
      )
      .join('');

    return `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
        <!-- Header -->
        <div style="background-color: ${statusColor}; color: white; padding: 20px; text-align: center;">
          <h2 style="margin: 0; font-size: 22px;">Test Run Notification</h2>
          <p style="margin: 5px 0 0 0; opacity: 0.9; font-size: 16px; font-weight: bold;">${statusText}</p>
        </div>
        
        <!-- Body -->
        <div style="padding: 25px; color: #1F2937; line-height: 1.5; background-color: #FFFFFF;">
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
            <tr>
              <td style="padding: 6px 0; color: #6B7280; font-size: 14px; width: 40%;"><strong>Execution ID:</strong></td>
              <td style="padding: 6px 0; font-size: 14px; font-family: monospace;">${report.executionId}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #6B7280; font-size: 14px;"><strong>Test Case ID:</strong></td>
              <td style="padding: 6px 0; font-size: 14px; font-family: monospace;">${report.testCaseId}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #6B7280; font-size: 14px;"><strong>Duration:</strong></td>
              <td style="padding: 6px 0; font-size: 14px;">${(report.durationMs / 1000).toFixed(2)} seconds</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #6B7280; font-size: 14px;"><strong>Completed At:</strong></td>
              <td style="padding: 6px 0; font-size: 14px;">${new Date(report.completedAt).toUTCString()}</td>
            </tr>
          </table>

          <hr style="border: 0; border-top: 1px solid #E5E7EB; margin: 20px 0;" />

          <h3 style="margin-top: 0; color: #374151;">Step Overview</h3>
          <ul style="list-style-type: none; padding-left: 0; margin: 0;">
            ${stepList}
          </ul>

          ${bugSection}

          <div style="margin-top: 25px; text-align: center;">
            <a href="https://s3.amazonaws.com/qa-reports-bucket/reports/execution-${report.executionId}.html" 
               style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 14px;">
              View Full Test Report Dashboard
            </a>
          </div>
        </div>

        <!-- Footer -->
        <div style="background-color: #F9FAFB; padding: 15px; text-align: center; border-top: 1px solid #E5E7EB; font-size: 12px; color: #9CA3AF;">
          This is an automated notification from the AutoQA Reporting System.
        </div>
      </div>
    `;
  }

  /**
   * Generates a fully loaded HTML test execution dashboard.
   * Utilizes a highly premium, modern dark mode design with glassmorphism overlays and vibrant status widgets.
   */
  exportToHtml(
    report: TestReport,
    steps: StepReport[],
    apiLogs: APILog[],
    consoleLogs: ConsoleLog[],
    bug?: BugReport,
    evidence?: EvidenceMetadata[]
  ): string {
    const isPass = report.status === 'passed';
    const statusClass = isPass ? 'status-pass' : 'status-fail';
    const statusText = isPass ? 'PASSED' : 'FAILED';
    const statusIcon = isPass ? '✓' : '✖';
    const totalSteps = steps.length;
    const passedStepsCount = steps.filter(s => s.status === 'passed').length;
    const passPercentage = totalSteps > 0 ? Math.round((passedStepsCount / totalSteps) * 100) : 100;

    // Create steps markup
    const stepsHtml = steps
      .map(
        s => `
      <div class="step-card ${s.status}">
        <div class="step-header">
          <span class="step-number">Step ${s.stepNumber}</span>
          <span class="step-badge ${s.status}">${s.status.toUpperCase()}</span>
        </div>
        <div class="step-body">
          <div class="step-desc"><strong>Action:</strong> ${s.action}</div>
          <div class="step-grid">
            <div>
              <div class="grid-label">Expected Result</div>
              <div class="grid-val">${s.expectedResult}</div>
            </div>
            <div>
              <div class="grid-label">Actual Result</div>
              <div class="grid-val">${s.actualResult}</div>
            </div>
          </div>
          ${s.errorMessage ? `<div class="step-error"><strong>Error Message:</strong> ${s.errorMessage}</div>` : ''}
          ${
            s.screenshotPath
              ? `
            <div class="screenshot-container">
              <div class="screenshot-label">📸 Step Screenshot</div>
              <a href="${s.screenshotPath}" target="_blank">
                <img src="${s.screenshotPath}" alt="Step ${s.stepNumber} Screenshot" class="step-img" onerror="this.src='https://placehold.co/600x400/222/FFF?text=Screenshot+Logged'"/>
              </a>
            </div>
          `
              : ''
          }
        </div>
      </div>
    `
      )
      .join('');

    // Create API logs table rows
    const apiLogsHtml = apiLogs.length > 0
      ? apiLogs
          .map(
            log => `
      <tr class="${log.statusCode >= 400 ? 'row-error' : ''}">
        <td class="method-cell"><span class="method-badge ${log.method}">${log.method}</span></td>
        <td class="url-cell" title="${log.fullUrl}"><strong>${log.endpoint}</strong></td>
        <td><span class="status-badge ${log.statusCode >= 400 ? 'err' : 'ok'}">${log.statusCode} ${log.statusText}</span></td>
        <td>${log.duration.toFixed(0)}ms</td>
        <td>${(log.responseSize / 1024).toFixed(2)} KB</td>
        <td class="btn-cell">
          <button onclick="toggleDetails('${log.id}')" class="btn-action">Payload</button>
        </td>
      </tr>
      <tr id="details-${log.id}" class="details-row" style="display: none;">
        <td colspan="6">
          <div class="payload-box">
            <div class="payload-sec">
              <strong>Sanitized Headers:</strong>
              <pre>${JSON.stringify(log.headers, null, 2)}</pre>
            </div>
            <div class="payload-sec">
              <strong>Request Body:</strong>
              <pre>${JSON.stringify(log.requestPayload, null, 2)}</pre>
            </div>
            <div class="payload-sec">
              <strong>Response Body:</strong>
              <pre>${JSON.stringify(log.responsePayload, null, 2)}</pre>
            </div>
          </div>
        </td>
      </tr>
    `
          )
          .join('')
      : `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No API traffic intercepted.</td></tr>`;

    // Console logs rows
    const consoleLogsHtml = consoleLogs.length > 0
      ? consoleLogs
          .map(
            log => `
      <div class="console-item ${log.level}">
        <span class="console-timestamp">[${new Date(log.timestamp).toLocaleTimeString()}]</span>
        <span class="console-level level-${log.level}">${log.level.toUpperCase()}</span>
        <span class="console-message">${log.message}</span>
        ${log.sourceFile ? `<div class="console-source">Source: ${log.sourceFile}:${log.lineNumber || 0}</div>` : ''}
        ${log.stackTrace ? `<pre class="console-stack">${log.stackTrace}</pre>` : ''}
      </div>
    `
          )
          .join('')
      : `<div style="text-align: center; color: var(--text-muted); padding: 15px;">No console logs captured.</div>`;

    // Bug report card
    let bugHtml = '';
    if (bug) {
      bugHtml = `
      <div class="dashboard-card bug-card-premium">
        <div class="bug-header-bar">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div class="bug-icon-badge">🐞</div>
            <div>
              <h2 style="margin: 0; color: #FFF; font-size: 1.3rem;">Automated Failure Bug Report</h2>
              <span class="bug-meta-text">Ticket Reference: <a href="${bug.jiraUrl || '#'}" target="_blank" class="jira-anchor">${bug.jiraIssueId || 'STUB_LOG'}</a></span>
            </div>
          </div>
          <div class="bug-badge-group">
            <span class="severity-badge ${bug.severity}">${bug.severity.toUpperCase()} SEVERITY</span>
            <span class="status-badge bug-status">${bug.status.toUpperCase()}</span>
          </div>
        </div>
        
        <div class="bug-content-grid">
          <div class="bug-left-col">
            <div class="desc-item">
              <strong>Bug Title:</strong>
              <div class="title-preview">${bug.title}</div>
            </div>
            <div class="desc-item">
              <strong>Root Cause Analysis:</strong>
              <div class="rca-output-box">${bug.rootCause?.replace(/\n/g, '<br/>') || 'No analysis compiled.'}</div>
            </div>
          </div>
          
          <div class="bug-right-col">
            <div class="desc-item">
              <strong>Debugging Recommendations:</strong>
              <div class="recommendations-box">${bug.suggestedFix?.replace(/\n/g, '<br/>') || 'No recommendations.'}</div>
            </div>
          </div>
        </div>
      </div>
      `;
    }

    // Attachments section
    let evidenceHtml = '';
    if (evidence && evidence.length > 0) {
      evidenceHtml = evidence
        .map(
          ev => `
        <div class="evidence-pill">
          <span class="ev-type-icon">${this.getEvidenceIcon(ev.type)}</span>
          <div class="ev-details">
            <div class="ev-name">${ev.filePath.split('/').pop()}</div>
            <div class="ev-size">${(ev.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB | ${ev.storageType.toUpperCase()}</div>
          </div>
          <a href="${ev.publicUrl || ev.filePath}" target="_blank" class="btn-download">Open</a>
        </div>
      `
        )
        .join('');
    } else {
      evidenceHtml = '<p style="color: var(--text-muted);">No external evidence metadata stored.</p>';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QA Dashboard - ${report.status.toUpperCase()} - Exec #${report.executionId.substring(0, 8)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0f111a;
      --bg-card: rgba(22, 28, 45, 0.7);
      --bg-hover: rgba(30, 41, 59, 0.9);
      --border-color: rgba(255, 255, 255, 0.08);
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      
      --color-pass: #10b981;
      --color-fail: #ef4444;
      --color-warn: #f59e0b;
      --color-info: #3b82f6;
      --color-accent: #8b5cf6;
      
      --font-sans: 'Outfit', sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * {
      box-sizing: border-box;
    }

    body {
      background-color: var(--bg-dark);
      background-image: 
        radial-gradient(at 0% 0%, rgba(139, 92, 246, 0.1) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(239, 68, 68, 0.05) 0px, transparent 50%);
      color: var(--text-main);
      font-family: var(--font-sans);
      margin: 0;
      padding: 0;
      min-height: 100vh;
      line-height: 1.5;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 40px 20px;
    }

    /* Top Navigation / Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border-color);
    }

    .logo-area h1 {
      margin: 0;
      font-size: 1.8rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      background: linear-gradient(135deg, #fff 0%, var(--text-muted) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .logo-area p {
      margin: 5px 0 0 0;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .status-banner {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 0.95rem;
      border: 1px solid transparent;
    }

    .status-banner.status-pass {
      background-color: rgba(16, 185, 129, 0.1);
      color: var(--color-pass);
      border-color: rgba(16, 185, 129, 0.2);
    }

    .status-banner.status-fail {
      background-color: rgba(239, 68, 68, 0.1);
      color: var(--color-fail);
      border-color: rgba(239, 68, 68, 0.2);
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }

    .stat-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
    }

    .stat-label {
      color: var(--text-muted);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 1.8rem;
      font-weight: 700;
    }

    .stat-value.pass { color: var(--color-pass); }
    .stat-value.fail { color: var(--color-fail); }

    /* Main Dashboard Layout */
    .dashboard-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
      align-items: start;
    }

    @media (max-width: 1024px) {
      .dashboard-layout {
        grid-template-columns: 1fr;
      }
    }

    .dashboard-card {
      background: var(--bg-card);
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 30px;
    }

    .card-title {
      font-size: 1.2rem;
      font-weight: 600;
      margin-top: 0;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 12px;
    }

    /* Step Cards */
    .step-card {
      background: rgba(30, 41, 59, 0.3);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      margin-bottom: 16px;
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .step-card:hover {
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-2px);
    }

    .step-card.passed { border-left: 4px solid var(--color-pass); }
    .step-card.failed { border-left: 4px solid var(--color-fail); }
    .step-card.not_reached { border-left: 4px solid var(--text-muted); opacity: 0.6; }

    .step-header {
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.02);
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
    }

    .step-number {
      font-weight: 600;
      font-size: 0.95rem;
    }

    .step-badge {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
    }

    .step-badge.passed { background: rgba(16, 185, 129, 0.15); color: var(--color-pass); }
    .step-badge.failed { background: rgba(239, 68, 68, 0.15); color: var(--color-fail); }
    .step-badge.not_reached { background: rgba(156, 163, 175, 0.15); color: var(--text-muted); }

    .step-body {
      padding: 16px;
    }

    .step-desc {
      font-size: 0.95rem;
      margin-bottom: 12px;
    }

    .step-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
      font-size: 0.85rem;
      background: rgba(0, 0, 0, 0.2);
      padding: 10px;
      border-radius: 6px;
    }

    .grid-label {
      color: var(--text-muted);
      margin-bottom: 4px;
      text-transform: uppercase;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .grid-val {
      font-family: var(--font-sans);
    }

    .step-error {
      margin-top: 12px;
      padding: 10px;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 6px;
      color: #fca5a5;
      font-size: 0.85rem;
      font-family: var(--font-mono);
      white-space: pre-wrap;
    }

    .screenshot-container {
      margin-top: 15px;
    }

    .screenshot-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 6px;
      font-weight: 600;
    }

    .step-img {
      width: 100%;
      max-height: 250px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      cursor: pointer;
      transition: filter 0.2s;
    }

    .step-img:hover {
      filter: brightness(1.1);
    }

    /* API and Logs Tables */
    .table-container {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }

    th, td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
    }

    th {
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
    }

    tr:hover {
      background: rgba(255, 255, 255, 0.01);
    }

    tr.row-error {
      background: rgba(239, 68, 68, 0.03);
    }

    .method-badge {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 0.75rem;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .method-badge.GET { background: rgba(59, 130, 246, 0.15); color: var(--color-info); }
    .method-badge.POST { background: rgba(16, 185, 129, 0.15); color: var(--color-pass); }
    .method-badge.PUT { background: rgba(245, 158, 11, 0.15); color: var(--color-warn); }
    .method-badge.DELETE { background: rgba(239, 68, 68, 0.15); color: var(--color-fail); }

    .status-badge {
      font-size: 0.8rem;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .status-badge.ok { background: rgba(16, 185, 129, 0.1); color: var(--color-pass); }
    .status-badge.err { background: rgba(239, 68, 68, 0.1); color: var(--color-fail); }

    .btn-action {
      background: var(--color-accent);
      color: white;
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .btn-action:hover {
      opacity: 0.9;
    }

    .url-cell {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .details-row {
      background: rgba(0, 0, 0, 0.3);
    }

    .payload-box {
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
    }

    .payload-sec {
      margin-bottom: 12px;
    }

    .payload-sec pre {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 10px;
      max-height: 150px;
      overflow: auto;
      margin: 5px 0 0 0;
    }

    /* Console Logs styling */
    .console-box {
      background: #05070a;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      max-height: 400px;
      overflow-y: auto;
      padding: 10px;
      font-family: var(--font-mono);
      font-size: 0.8rem;
    }

    .console-item {
      padding: 6px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .console-timestamp {
      color: #6b7280;
    }

    .console-level {
      font-weight: 700;
      margin-right: 5px;
    }

    .level-error { color: var(--color-fail); }
    .level-warn { color: var(--color-warn); }
    .level-info { color: var(--color-info); }
    .level-debug { color: #9ca3af; }

    .console-stack {
      background: rgba(239, 68, 68, 0.03);
      border-left: 2px solid var(--color-fail);
      padding: 8px;
      margin: 5px 0 0 0;
      font-size: 0.75rem;
      color: #fca5a5;
      overflow-x: auto;
    }

    .console-source {
      color: #4b5563;
      font-size: 0.7rem;
    }

    /* Premium Bug Card */
    .bug-card-premium {
      background: linear-gradient(135deg, rgba(22, 28, 45, 0.9) 0%, rgba(139, 92, 246, 0.08) 100%);
      border: 1px solid rgba(139, 92, 246, 0.3);
      box-shadow: 0 8px 32px rgba(139, 92, 246, 0.05);
    }

    .bug-header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 15px;
    }

    .bug-icon-badge {
      font-size: 1.8rem;
    }

    .bug-meta-text {
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    .jira-anchor {
      color: #a78bfa;
      font-weight: 600;
      text-decoration: none;
      border-bottom: 1px dotted #a78bfa;
    }

    .jira-anchor:hover {
      color: white;
    }

    .bug-badge-group {
      display: flex;
      gap: 10px;
    }

    .severity-badge {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 4px;
      color: white;
    }

    .severity-badge.critical { background: #7f1d1d; border: 1px solid #f87171; }
    .severity-badge.high { background: #991b1b; border: 1px solid #ef4444; }
    .severity-badge.medium { background: #92400e; border: 1px solid #f59e0b; }
    .severity-badge.low { background: #065f46; border: 1px solid #10b981; }

    .bug-status {
      background: rgba(255,255,255,0.08);
      border: 1px solid var(--border-color);
    }

    .bug-content-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }

    @media (max-width: 768px) {
      .bug-content-grid {
        grid-template-columns: 1fr;
      }
    }

    .desc-item {
      margin-bottom: 15px;
    }

    .desc-item strong {
      color: var(--text-muted);
      font-size: 0.85rem;
      display: block;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .title-preview {
      font-size: 1.05rem;
      font-weight: 600;
      color: #fff;
    }

    .rca-output-box, .recommendations-box {
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 8px;
      padding: 12px;
      font-family: var(--font-sans);
      font-size: 0.9rem;
      line-height: 1.6;
      color: #e5e7eb;
    }

    /* Video section */
    .video-card {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }

    .video-player {
      width: 100%;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      background: #000;
    }

    /* Evidence pills */
    .evidence-pill-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 15px;
    }

    .evidence-pill {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .ev-type-icon {
      font-size: 1.4rem;
    }

    .ev-details {
      flex: 1;
      min-width: 0;
    }

    .ev-name {
      font-size: 0.85rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ev-size {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .btn-download {
      color: var(--color-accent);
      text-decoration: none;
      font-size: 0.8rem;
      font-weight: 600;
    }

    .btn-download:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <h1>QA Test Execution Dashboard</h1>
        <p>Execution ID: ${report.executionId} | Date: ${new Date(report.completedAt).toLocaleString()}</p>
      </div>
      <div class="status-banner ${statusClass}">
        <span style="font-size: 1.2rem;">${statusIcon}</span>
        <span>TEST ${statusText}</span>
      </div>
    </header>

    <!-- Stats summary widgets -->
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Duration</span>
        <span class="stat-value">${(report.durationMs / 1000).toFixed(2)}s</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Steps (Passed/Total)</span>
        <span class="stat-value">${passedStepsCount} / ${totalSteps}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Step Pass Rate</span>
        <span class="stat-value ${isPass ? 'pass' : 'fail'}">${passPercentage}%</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Environment</span>
        <span class="stat-value" style="font-size: 1.4rem; font-family: var(--font-mono);">${bug ? 'Production' : 'Production'}</span>
      </div>
    </div>

    ${bugHtml}

    <div class="dashboard-layout">
      <!-- Left Column: Steps -->
      <div>
        <div class="dashboard-card">
          <h2 class="card-title">Execution Steps Progress</h2>
          <div class="steps-container">
            ${stepsHtml}
          </div>
        </div>

        <div class="dashboard-card">
          <h2 class="card-title">Evidence & Storage Metadata</h2>
          <div class="evidence-pill-grid">
            ${evidenceHtml}
          </div>
        </div>
      </div>

      <!-- Right Column: API interception & console outputs -->
      <div>
        <div class="dashboard-card" style="margin-bottom: 30px;">
          <h2 class="card-title">Captured Console Logs</h2>
          <div class="console-box">
            ${consoleLogsHtml}
          </div>
        </div>

        <div class="dashboard-card">
          <h2 class="card-title">Captured Network API Traffic</h2>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Size</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${apiLogsHtml}
              </tbody>
            </table>
          </div>
        </div>
        
        ${
          report.videoPath
            ? `
        <div class="dashboard-card video-card">
          <h2 class="card-title">📹 Video Playback</h2>
          <video controls class="video-player">
            <source src="${report.videoPath}" type="video/webm">
            Your browser does not support the video tag.
          </video>
        </div>
        `
            : ''
        }
      </div>
    </div>
  </div>

  <script>
    function toggleDetails(logId) {
      const row = document.getElementById('details-' + logId);
      if (row.style.display === 'none') {
        row.style.display = 'table-row';
      } else {
        row.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;
  }

  private getEvidenceIcon(type: EvidenceMetadata['type']): string {
    switch (type) {
      case 'video':
        return '📹';
      case 'screenshot':
        return '📸';
      case 'console_log':
        return '📋';
      case 'network_log':
      case 'har_file':
        return '📊';
      default:
        return '📄';
    }
  }
}
