import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';
import { RemoteArtifact } from '@/lib/report-bug-tracker/types';
import { isCloudinaryConfigured, uploadFile } from '@/core/storage/cloudinaryStorage';

export interface CaptureResult {
  /** Where to point a viewer: the Cloudinary url when uploaded, else the local static route. */
  url: string;
  /** Absolute path of the file written on this machine. Always set on success. */
  localPath: string;
  sizeBytes: number;
  remote?: RemoteArtifact;
}

export interface IScreenshotManager {
  capture(page: Page, runId: string, stepIndex: number, opts?: { fullPage?: boolean }): Promise<string>;
  captureDetailed(
    page: Page,
    runId: string,
    stepIndex: number,
    opts?: { fullPage?: boolean },
  ): Promise<CaptureResult | null>;
}

export class ScreenshotManager implements IScreenshotManager {
  private outputDir: string;

  constructor() {
    // Written inside the Next.js public directory so the frontend can serve them
    // statically. Cloudinary is the durable copy; this one is what survives when
    // no credentials are configured, and what the upload is read from.
    this.outputDir = path.join(process.cwd(), 'public', 'screenshots');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Captures the page and returns the url to show it at.
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
    const result = await this.captureDetailed(page, runId, stepIndex, opts);
    return result?.url ?? '';
  }

  /**
   * Same capture, but hands back the local path and the Cloudinary copy as well,
   * which is what the evidence record needs in order to say where the file
   * actually lives.
   */
  public async captureDetailed(
    page: Page,
    runId: string,
    stepIndex: number,
    opts: { fullPage?: boolean } = {},
  ): Promise<CaptureResult | null> {
    try {
      const fileName = `run-${runId}-step-${stepIndex}.png`;
      const filePath = path.join(this.outputDir, fileName);

      await page.screenshot({ path: filePath, fullPage: opts.fullPage ?? false });

      const sizeBytes = fs.statSync(filePath).size;
      logger.info(`Captured screenshot: ${fileName}`);

      // Static route served by Next.js — the fallback when there is no CDN copy.
      const localUrl = `/screenshots/${fileName}`;

      if (!isCloudinaryConfigured()) {
        return { url: localUrl, localPath: filePath, sizeBytes };
      }

      const uploaded = await uploadFile(filePath, {
        folder: `screenshots/run-${runId}`,
        resourceType: 'image',
        publicId: `step-${stepIndex}`,
      });

      if (!uploaded) {
        // Upload failed and said so in the log; the local copy still stands.
        return { url: localUrl, localPath: filePath, sizeBytes };
      }

      return {
        url: uploaded.secureUrl,
        localPath: filePath,
        sizeBytes: uploaded.bytes || sizeBytes,
        remote: {
          url: uploaded.secureUrl,
          publicId: uploaded.publicId,
          sizeBytes: uploaded.bytes,
        },
      };
    } catch (error) {
      logger.error('Failed to capture screenshot', error);
      return null;
    }
  }
}
