import { APILog, ConsoleLog, EvidenceMetadata, RemoteArtifact, LogArtifact } from '../types';

export class EvidenceCollector {
  private executionId: string;
  private testCaseId: string;
  private apiLogs: APILog[] = [];
  private consoleLogs: ConsoleLog[] = [];
  private screenshots: { stepNumber: number; path: string; sizeBytes: number; remote?: RemoteArtifact }[] = [];
  private videoInfo?: { path: string; sizeBytes: number; remote?: RemoteArtifact };
  private traceInfo?: { path: string; sizeBytes: number; remote?: RemoteArtifact };
  /** The rolled-up log files, once written out, keyed by evidence type. */
  private logArtifacts: {
    console_log?: LogArtifact;
    har_file?: LogArtifact;
  } = {};

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
  captureVideo(videoPath: string, sizeBytes: number, remote?: RemoteArtifact): void {
    this.videoInfo = {
      path: videoPath,
      sizeBytes,
      remote
    };
  }

  /**
   * Associate the Playwright trace archive for the run.
   *
   * The trace is the richest artifact there is — a step-by-step timeline with
   * DOM snapshots — but it is only useful through the Trace Viewer, which has
   * to fetch it over HTTP. That makes the uploaded copy the one that matters.
   */
  captureTrace(tracePath: string, sizeBytes: number, remote?: RemoteArtifact): void {
    this.traceInfo = {
      path: tracePath,
      sizeBytes,
      remote
    };
  }

  /**
   * Register a screenshot that already exists (captured by the runner) along
   * with its uploaded copy, if there is one.
   */
  addScreenshot(
    stepNumber: number,
    filePath: string,
    sizeBytes: number,
    remote?: RemoteArtifact
  ): void {
    this.screenshots.push({ stepNumber, path: filePath, sizeBytes, remote });
  }

  /**
   * Attach a rolled-up log file once it has been written out.
   *
   * The logs live in memory during the run and only become a file when they
   * are exported, which happens outside this class — so the caller hands back
   * where it put the file, how big it turned out to be, and the Cloudinary
   * copy if it made one.
   */
  attachLogArtifact(
    type: 'console_log' | 'har_file',
    artifact: { filePath: string; sizeBytes: number; remote?: RemoteArtifact }
  ): void {
    this.logArtifacts[type] = artifact;
  }

  // Getters
  getAPILogs(): APILog[] {
    return this.apiLogs;
  }

  getConsoleLogs(): ConsoleLog[] {
    return this.consoleLogs;
  }

  getScreenshots(): Array<{ stepNumber: number; path: string; sizeBytes: number; remote?: RemoteArtifact }> {
    return this.screenshots;
  }

  getVideoInfo(): { path: string; sizeBytes: number; remote?: RemoteArtifact } | undefined {
    return this.videoInfo;
  }

  getTraceInfo(): { path: string; sizeBytes: number; remote?: RemoteArtifact } | undefined {
    return this.traceInfo;
  }

  /**
   * Compile captured evidence into db-storable metadata.
   *
   * Artifacts that reached Cloudinary carry their CDN url and public id; the
   * rest are recorded as `local` and point at the path on the machine that ran
   * the test, which is still the truth about where that file is.
   */
  compileEvidenceMetadata(): EvidenceMetadata[] {
    const metadata: EvidenceMetadata[] = [];

    const entry = (
      type: EvidenceMetadata['type'],
      filePath: string,
      fileSizeBytes: number,
      remote?: RemoteArtifact
    ): EvidenceMetadata => ({
      id: `ev-${Math.random().toString(36).substring(2, 11)}`,
      executionId: this.executionId,
      type,
      filePath,
      // Cloudinary reports the real stored size, so it wins over local estimates.
      fileSizeBytes: remote?.sizeBytes ?? fileSizeBytes,
      storageType: remote ? 'cloudinary' : 'local',
      storageId: remote?.publicId,
      publicUrl: remote?.url ?? filePath
    });

    // Video
    if (this.videoInfo) {
      metadata.push(
        entry('video', this.videoInfo.path, this.videoInfo.sizeBytes, this.videoInfo.remote)
      );
    }

    // Trace archive
    if (this.traceInfo) {
      metadata.push(
        entry('trace', this.traceInfo.path, this.traceInfo.sizeBytes, this.traceInfo.remote)
      );
    }

    // Screenshots
    for (const screenshot of this.screenshots) {
      metadata.push(
        entry('screenshot', screenshot.path, screenshot.sizeBytes, screenshot.remote)
      );
    }

    // Console logs. Once the file has been written out its real path and size
    // are known; the estimate only stands for a caller that never exported it.
    if (this.consoleLogs.length > 0) {
      const written = this.logArtifacts.console_log;
      metadata.push(
        entry(
          'console_log',
          written?.filePath ?? `logs/execution-${this.executionId}/console.log`,
          written?.sizeBytes ?? this.consoleLogs.length * 128, // estimate
          written?.remote
        )
      );
    }

    // Network logs (HAR archive)
    if (this.apiLogs.length > 0) {
      const written = this.logArtifacts.har_file;
      metadata.push(
        entry(
          'har_file',
          written?.filePath ?? `logs/execution-${this.executionId}/network.har`,
          written?.sizeBytes ?? this.apiLogs.length * 256, // estimate
          written?.remote
        )
      );
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
