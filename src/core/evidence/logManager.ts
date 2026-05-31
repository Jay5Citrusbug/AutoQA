import { Page } from '@playwright/test';
import { ConsoleMessageRecord, NetworkErrorRecord } from '@/types/execution';

export interface ILogManager {
  startListeners(page: Page): void;
  collect(page: Page): { consoleLogs: ConsoleMessageRecord[]; networkErrors: NetworkErrorRecord[] };
}

export class LogManager implements ILogManager {
  private consoleBuffer: Map<string, ConsoleMessageRecord[]> = new Map();
  private networkBuffer: Map<string, NetworkErrorRecord[]> = new Map();

  public startListeners(page: Page): void {
    const pageId = page.viewportSize() ? `${page.viewportSize()?.width}-${page.viewportSize()?.height}` : 'page-session';
    
    const consoleLogs: ConsoleMessageRecord[] = [];
    const networkErrors: NetworkErrorRecord[] = [];

    this.consoleBuffer.set(pageId, consoleLogs);
    this.networkBuffer.set(pageId, networkErrors);

    // Listen to console logs
    page.on('console', (msg) => {
      const type = msg.type() as 'log' | 'error' | 'warn' | 'info' | 'debug';
      const record: ConsoleMessageRecord = {
        type,
        text: msg.text(),
        timestamp: new Date().toISOString(),
      };
      consoleLogs.push(record);
    });

    // Listen to page errors
    page.on('pageerror', (err) => {
      const record: ConsoleMessageRecord = {
        type: 'error',
        text: `Uncaught Page Error: ${err.message}`,
        timestamp: new Date().toISOString(),
      };
      consoleLogs.push(record);
    });

    // Listen to failed network requests
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      const record: NetworkErrorRecord = {
        url: request.url(),
        method: request.method(),
        errorMessage: failure?.errorText || 'Unknown network error',
        timestamp: new Date().toISOString(),
      };
      networkErrors.push(record);
    });
  }

  public collect(page: Page): { consoleLogs: ConsoleMessageRecord[]; networkErrors: NetworkErrorRecord[] } {
    const pageId = page.viewportSize() ? `${page.viewportSize()?.width}-${page.viewportSize()?.height}` : 'page-session';
    
    const consoleLogs = this.consoleBuffer.get(pageId) || [];
    const networkErrors = this.networkBuffer.get(pageId) || [];

    // Clear buffers
    this.consoleBuffer.delete(pageId);
    this.networkBuffer.delete(pageId);

    return {
      consoleLogs,
      networkErrors,
    };
  }
}
