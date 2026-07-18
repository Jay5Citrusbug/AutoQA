import { Page } from '@playwright/test';
import { ConsoleMessageRecord, NetworkErrorRecord } from '@/types/execution';

export interface ILogManager {
  startListeners(page: Page): void;
  collect(page: Page): { consoleLogs: ConsoleMessageRecord[]; networkErrors: NetworkErrorRecord[] };
}

export class LogManager implements ILogManager {
  // Keyed by the Page object itself so parallel suites (even with identical
  // viewports) never share or overwrite each other's buffers.
  private buffers: WeakMap<Page, { consoleLogs: ConsoleMessageRecord[]; networkErrors: NetworkErrorRecord[] }> =
    new WeakMap();

  public startListeners(page: Page): void {
    const consoleLogs: ConsoleMessageRecord[] = [];
    const networkErrors: NetworkErrorRecord[] = [];

    this.buffers.set(page, { consoleLogs, networkErrors });

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
    const buf = this.buffers.get(page) || { consoleLogs: [], networkErrors: [] };
    this.buffers.delete(page);
    return {
      consoleLogs: buf.consoleLogs,
      networkErrors: buf.networkErrors,
    };
  }
}
