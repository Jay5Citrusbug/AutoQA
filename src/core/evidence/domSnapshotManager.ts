import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';

/**
 * Captures the page's HTML at the moment of a failure so a bug can be triaged
 * later without re-running. Stored as a file (DOM can be large) and served
 * statically, mirroring ScreenshotManager.
 */
export interface IDomSnapshotManager {
  capture(page: Page, runId: string, stepIndex: number): Promise<string>;
}

export class DomSnapshotManager implements IDomSnapshotManager {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'public', 'dom-snapshots');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  public async capture(page: Page, runId: string, stepIndex: number): Promise<string> {
    try {
      const html = await page.content();
      const fileName = `run-${runId}-step-${stepIndex}.html`;
      const filePath = path.join(this.outputDir, fileName);
      fs.writeFileSync(filePath, html, 'utf-8');
      logger.info(`Captured DOM snapshot: ${fileName}`);
      return `/dom-snapshots/${fileName}`;
    } catch (error) {
      logger.error('Failed to capture DOM snapshot', error);
      return '';
    }
  }
}
