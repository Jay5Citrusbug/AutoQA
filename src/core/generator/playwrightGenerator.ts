import { ExecutionContext } from '@/types/execution';
import { fileHelper } from '@/utils/fileHelper';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';

export interface IPlaywrightGenerator {
  generateSpec(context: ExecutionContext, tcId?: string): Promise<string>;
}

export class PlaywrightGenerator implements IPlaywrightGenerator {
  private outputDir: string;
  private publicDir: string;

  constructor() {
    this.outputDir = path.join(process.cwd(), 'generated-tests');
    this.publicDir = path.join(process.cwd(), 'public', 'generated-tests');

    [this.outputDir, this.publicDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  public async generateSpec(context: ExecutionContext, tcId?: string): Promise<string> {
    const runId = context.runId;
    const cleanUrlName = context.url
      .replace(/^https?:\/\//i, '')
      .replace(/[^a-zA-Z0-9]/g, '_');

    const suiteTag = tcId ? `_${tcId.toLowerCase()}` : '';
    const specFileName = `test_${cleanUrlName}${suiteTag}_${runId.substring(0, 8)}.spec.ts`;

    const browser = context.browser ?? 'chromium';
    const deviceMode = context.deviceMode ?? 'desktop';

    const codeLines: string[] = [];

    // Header
    codeLines.push(`import { test, expect } from '@playwright/test';`);
    codeLines.push(``);
    codeLines.push(`// AutoQA Generated Playwright Spec`);
    codeLines.push(`// Browser: ${browser}  |  Device: ${deviceMode}`);
    codeLines.push(`// Run ID: ${runId}${tcId ? `  |  TC: ${tcId}` : ''}`);
    codeLines.push(``);
    codeLines.push(`test.describe('AutoQA Generated Test Run', () => {`);
    codeLines.push(`  test('Verify execution flow on target site', async ({ page }) => {`);
    codeLines.push(`    test.setTimeout(300000); // 5 min — handles slow redirects`);
    codeLines.push(``);

    context.stepResults.forEach((r) => {
      codeLines.push(`    // Step ${r.stepIndex}: ${r.step.rawText}`);

      const step = r.step;
      const selector = r.resolvedSelector || `[name="${step.targetField}"]`;

      if (step.type === 'action') {
        switch (step.action) {
          case 'navigate':
            codeLines.push(`    await page.goto('${step.value}', { waitUntil: 'networkidle', timeout: 120000 });`);
            break;
          case 'fill':
            codeLines.push(`    await page.locator('${selector}').fill('${(step.value || '').replace(/'/g, "\\'")}');`);
            break;
          case 'click':
            codeLines.push(`    await page.locator('${selector}').click();`);
            codeLines.push(`    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});`);
            break;
          case 'select':
            codeLines.push(`    await page.locator('${selector}').selectOption('${step.value || ''}');`);
            break;
          case 'check':
            codeLines.push(`    await page.locator('${selector}').check();`);
            break;
          case 'uncheck':
            codeLines.push(`    await page.locator('${selector}').uncheck();`);
            break;
          case 'wait':
            codeLines.push(`    await page.waitForTimeout(${step.waitMs || 1000});`);
            break;
          default:
            codeLines.push(`    // Unsupported action: ${step.action}`);
        }
      } else if (step.type === 'validation') {
        switch (step.validation) {
          case 'url': {
            // Use string-based URL check to avoid invalid regex with slashes
            const escapedVal = (step.value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            codeLines.push(`    await expect(page).toHaveURL(new RegExp(${JSON.stringify(escapedVal)}), { timeout: 120000 });`);
            break;
          }
          case 'visible':
            codeLines.push(`    await expect(page.locator('${selector}')).toBeVisible({ timeout: 120000 });`);
            break;
          case 'enabled':
            codeLines.push(`    await expect(page.locator('${selector}')).toBeEnabled({ timeout: 120000 });`);
            break;
          case 'success_msg':
          case 'error_msg':
          case 'text':
            codeLines.push(`    await expect(page.locator('body')).toContainText('${(step.value || '').replace(/'/g, "\\'")}', { timeout: 120000 });`);
            break;
          default:
            codeLines.push(`    // Unsupported validation: ${step.validation}`);
        }
      }

      codeLines.push(``);
    });

    codeLines.push(`  });`);
    codeLines.push(`});`);
    codeLines.push(``);

    const fullCode = codeLines.join('\n');

    // Write to root generated-tests folder
    const targetSpecPath = path.join(this.outputDir, specFileName);
    fileHelper.writeText(targetSpecPath, fullCode);
    logger.info(`Generated spec: ${targetSpecPath}`);

    // Write to public/ so browser can download
    const publicSpecPath = path.join(this.publicDir, specFileName);
    fileHelper.writeText(publicSpecPath, fullCode);

    return `/generated-tests/${specFileName}`;
  }
}
