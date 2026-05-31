import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';

export interface IScreenshotManager {
  capture(page: Page, runId: string, stepIndex: number): Promise<string>;
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

  public async capture(page: Page, runId: string, stepIndex: number): Promise<string> {
    try {
      const fileName = `run-${runId}-step-${stepIndex}.png`;
      const filePath = path.join(this.outputDir, fileName);
      
      // Capture full-page screenshot
      await page.screenshot({ path: filePath, fullPage: true });
      
      logger.info(`Captured screenshot: ${fileName}`);
      
      // Return static route served by Next.js
      return `/screenshots/${fileName}`;
    } catch (error) {
      logger.error('Failed to capture screenshot', error);
      return '';
    }
  }
}
