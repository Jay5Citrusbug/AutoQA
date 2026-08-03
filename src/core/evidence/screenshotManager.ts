import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';

export interface IScreenshotManager {
  capture(page: Page, runId: string, stepIndex: number, opts?: { fullPage?: boolean }): Promise<string>;
}

export class ScreenshotManager implements IScreenshotManager {
  private outputDir: string;

  constructor() {
    // Write directly inside Next.js public directory so the frontend can serve them statically
    this.outputDir = path.join(process.cwd(), 'public', 'screenshots');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Captures the page.
   *
   * `fullPage` stitches the whole scrollable document together, which on a long
   * dashboard means scrolling it end to end and costs seconds — per step. Passing
   * evidence only needs to show what the tester would have been looking at, so
   * successful steps capture the viewport and failures get the full page, where
   * the off-screen part of the document is genuinely diagnostic.
   */
  public async capture(
    page: Page,
    runId: string,
    stepIndex: number,
    opts: { fullPage?: boolean } = {},
  ): Promise<string> {
    try {
      const fileName = `run-${runId}-step-${stepIndex}.png`;
      const filePath = path.join(this.outputDir, fileName);

      await page.screenshot({ path: filePath, fullPage: opts.fullPage ?? false });

      logger.info(`Captured screenshot: ${fileName}`);
      
      // Return static route served by Next.js
      return `/screenshots/${fileName}`;
    } catch (error) {
      logger.error('Failed to capture screenshot', error);
      return '';
    }
  }
}
