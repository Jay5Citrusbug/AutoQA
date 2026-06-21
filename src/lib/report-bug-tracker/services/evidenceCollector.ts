import { APILog, ConsoleLog, EvidenceMetadata } from '../types';

export class EvidenceCollector {
  private executionId: string;
  private testCaseId: string;
  private apiLogs: APILog[] = [];
  private consoleLogs: ConsoleLog[] = [];
  private screenshots: { stepNumber: number; path: string; sizeBytes: number }[] = [];
  private videoInfo?: { path: string; sizeBytes: number };

  constructor(executionId: string, testCaseId: string) {
    this.executionId = executionId;
    this.testCaseId = testCaseId;
  }

  /**
   * Manually append an API log. Helpful for server-side testing or non-Playwright captures.
   */
  addAPILog(log: Omit<APILog, 'id' | 'testCaseId' | 'executionId'>): void {
    this.apiLogs.push({
      ...log,
      headers: this.sanitizeHeaders(log.headers),
      id: `api-${Math.random().toString(36).substring(2, 11)}`,
      testCaseId: this.testCaseId,
      executionId: this.executionId
    });
  }

  /**
   * Manually append a console log.
   */
  addConsoleLog(log: Omit<ConsoleLog, 'id' | 'executionId'>): void {
    this.consoleLogs.push({
      ...log,
      id: `con-${Math.random().toString(36).substring(2, 11)}`,
      executionId: this.executionId
    });
  }

  /**
   * Associate the final execution video recording.
   */
  captureVideo(videoPath: string, sizeBytes: number): void {
    this.videoInfo = {
      path: videoPath,
      sizeBytes
    };
  }

  // Getters
  getAPILogs(): APILog[] {
    return this.apiLogs;
  }

  getConsoleLogs(): ConsoleLog[] {
    return this.consoleLogs;
  }

  getScreenshots(): Array<{ stepNumber: number; path: string; sizeBytes: number }> {
    return this.screenshots;
  }

  getVideoInfo(): { path: string; sizeBytes: number } | undefined {
    return this.videoInfo;
  }

  /**
   * Compile captured evidence into db-storable metadata
   */
  compileEvidenceMetadata(): EvidenceMetadata[] {
    const metadata: EvidenceMetadata[] = [];

    // Video
    if (this.videoInfo) {
      metadata.push({
        id: `ev-${Math.random().toString(36).substring(2, 11)}`,
        executionId: this.executionId,
        type: 'video',
        filePath: this.videoInfo.path,
        fileSizeBytes: this.videoInfo.sizeBytes,
        storageType: 's3',
        publicUrl: `https://s3.amazonaws.com/qa-reports-bucket/${this.videoInfo.path}`
      });
    }

    // Screenshots
    for (const screenshot of this.screenshots) {
      metadata.push({
        id: `ev-${Math.random().toString(36).substring(2, 11)}`,
        executionId: this.executionId,
        type: 'screenshot',
        filePath: screenshot.path,
        fileSizeBytes: screenshot.sizeBytes,
        storageType: 's3',
        publicUrl: `https://s3.amazonaws.com/qa-reports-bucket/${screenshot.path}`
      });
    }

    // Console logs (simulated file metadata)
    if (this.consoleLogs.length > 0) {
      metadata.push({
        id: `ev-${Math.random().toString(36).substring(2, 11)}`,
        executionId: this.executionId,
        type: 'console_log',
        filePath: `logs/execution-${this.executionId}/console.log`,
        fileSizeBytes: this.consoleLogs.length * 128, // estimate
        storageType: 's3',
        publicUrl: `https://s3.amazonaws.com/qa-reports-bucket/logs/execution-${this.executionId}/console.log`
      });
    }

    // Network logs (simulated HAR archive metadata)
    if (this.apiLogs.length > 0) {
      metadata.push({
        id: `ev-${Math.random().toString(36).substring(2, 11)}`,
        executionId: this.executionId,
        type: 'har_file',
        filePath: `logs/execution-${this.executionId}/network.har`,
        fileSizeBytes: this.apiLogs.length * 256, // estimate
        storageType: 's3',
        publicUrl: `https://s3.amazonaws.com/qa-reports-bucket/logs/execution-${this.executionId}/network.har`
      });
    }

    return metadata;
  }

  // Helpers
  private extractEndpoint(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.pathname;
    } catch {
      return url;
    }
  }

  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'authorization' || lowerKey === 'cookie' || lowerKey === 'set-cookie' || lowerKey === 'x-api-key') {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
