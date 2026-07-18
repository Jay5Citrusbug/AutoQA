import { ExecutionContext } from '@/types/execution';
import { fileHelper } from '@/utils/fileHelper';
import path from 'path';
import fs from 'fs';
import { logger } from '@/utils/logger';
import { toEnvName, VAR_PATTERN } from '@/utils/testData';

export interface IPlaywrightGenerator {
  generateSpec(context: ExecutionContext, tcId?: string): Promise<string>;
}

export class PlaywrightGenerator implements IPlaywrightGenerator {
  private outputDir: string;
  private publicDir: string;

  /**
   * True unless the selector is one of the old blind fallbacks that should never
   * be baked into a regression script (it would click an arbitrary element).
   */
  private isReliableSelector(sel: string): boolean {
    const s = (sel || '').trim();
    if (!s) return false;
    if (s === 'button' || s === 'input' || s === 'input:not([type="hidden"])') return false;
    if (s.includes(',')) return false; // comma-list guesses are ambiguous under strict mode
    return true;
  }

  /** Renders `page.locator('<sel>').first()` with the selector safely quoted. */
  private locatorExpr(sel: string): string {
    const escaped = sel.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `page.locator('${escaped}').first()`;
  }

  /** Ensures navigate targets are absolute URLs so page.goto() never receives a bare label. */
  private normalizeUrl(value: string | undefined, fallback?: string): string | null {
    const v = (value || '').trim().replace(/^["']|["']$/g, '');
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v)) return 'https://' + v;
    if (fallback && /^https?:\/\//i.test(fallback)) return fallback;
    return null;
  }

  /**
   * Renders a step value as a TS string expression.
   * {{var}} test-data references become process.env lookups so generated
   * specs never contain plaintext secrets.
   */
  private valueExpr(value: string): string {
    if (/\{\{/.test(value)) {
      const body = value
        .replace(/[\\`]/g, '\\$&')
        .replace(/\$\{/g, '\\${')
        .replace(VAR_PATTERN, (_raw, varName: string) => '${process.env.' + toEnvName(varName) + " ?? ''}");
      return '`' + body + '`';
    }
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

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

    const fullCode = this.buildSpecCode(context, tcId);

    // Write to root generated-tests folder
    const targetSpecPath = path.join(this.outputDir, specFileName);
    fileHelper.writeText(targetSpecPath, fullCode);
    logger.info(`Generated spec: ${targetSpecPath}`);

    // Write to public/ so browser can download
    const publicSpecPath = path.join(this.publicDir, specFileName);
    fileHelper.writeText(publicSpecPath, fullCode);

    return `/generated-tests/${specFileName}`;
  }

  /**
   * Pure spec-code builder (no filesystem side effects) — unit-testable.
   */
  public buildSpecCode(context: ExecutionContext, tcId?: string): string {
    const runId = context.runId;
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
      const rawSelector = r.resolvedSelector || '';
      const hasReliableSelector = this.isReliableSelector(rawSelector);
      const loc = hasReliableSelector ? this.locatorExpr(rawSelector) : '';

      if (step.type === 'unparsed') {
        codeLines.push(`    // SKIPPED (unparsed step): ${step.parseWarning || 'could not be understood'}`);
      } else if (step.type === 'action') {
        switch (step.action) {
          case 'navigate': {
            const targetUrl = this.normalizeUrl(step.value, context.url);
            if (targetUrl) {
              codeLines.push(`    await page.goto('${targetUrl.replace(/'/g, "\\'")}', { waitUntil: 'load', timeout: 120000 });`);
            } else {
              codeLines.push(`    // TODO: could not determine a valid URL for: ${step.rawText}`);
            }
            break;
          }
          case 'fill':
            if (step.targetField === 'credentials') {
              // Runner resolves credential steps to "userSelector & passSelector".
              // Emit env-driven fills so the spec is runnable without embedding secrets.
              const [userSel, passSel] = rawSelector.split(' & ');
              const envPrefix = step.value === 'valid' ? 'QA_VALID' : 'QA_INVALID';
              if (userSel && passSel) {
                codeLines.push(`    await ${this.locatorExpr(userSel)}.fill(process.env.${envPrefix}_USERNAME ?? '');`);
                codeLines.push(`    await ${this.locatorExpr(passSel)}.fill(process.env.${envPrefix}_PASSWORD ?? '');`);
              } else {
                codeLines.push(`    // TODO: credential fields could not be resolved for this step`);
              }
            } else if (hasReliableSelector) {
              codeLines.push(`    await ${loc}.fill(${this.valueExpr(step.value || '')});`);
            } else {
              codeLines.push(`    // TODO: no reliable locator resolved for field "${step.targetField}" — rerun to record one`);
            }
            break;
          case 'click':
            if (hasReliableSelector) {
              codeLines.push(`    await ${loc}.click();`);
              codeLines.push(`    await page.waitForLoadState('load', { timeout: 120000 }).catch(() => {});`);
            } else {
              codeLines.push(`    // TODO: no reliable locator resolved for "${step.targetField}" — rerun to record one`);
            }
            break;
          case 'select':
            if (hasReliableSelector) {
              codeLines.push(`    await ${loc}.selectOption(${this.valueExpr(step.value || '')});`);
            } else {
              codeLines.push(`    // TODO: no reliable locator resolved for dropdown "${step.targetField}"`);
            }
            break;
          case 'check':
            if (hasReliableSelector) codeLines.push(`    await ${loc}.check();`);
            else codeLines.push(`    // TODO: no reliable locator resolved for checkbox "${step.targetField}"`);
            break;
          case 'uncheck':
            if (hasReliableSelector) codeLines.push(`    await ${loc}.uncheck();`);
            else codeLines.push(`    // TODO: no reliable locator resolved for checkbox "${step.targetField}"`);
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
            if (hasReliableSelector) {
              codeLines.push(`    await expect(${loc}).toBeVisible({ timeout: 120000 });`);
            } else {
              codeLines.push(`    await expect(page.getByText(${this.valueExpr(step.value || step.targetField || '')}).first()).toBeVisible({ timeout: 120000 });`);
            }
            break;
          case 'enabled':
            if (hasReliableSelector) {
              codeLines.push(`    await expect(${loc}).toBeEnabled({ timeout: 120000 });`);
            } else {
              codeLines.push(`    // TODO: no reliable locator resolved to assert enabled: "${step.targetField}"`);
            }
            break;
          case 'success_msg':
          case 'error_msg':
          case 'text':
            codeLines.push(`    await expect(page.locator('body')).toContainText(${this.valueExpr(step.value || '')}, { timeout: 120000 });`);
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

    return codeLines.join('\n');
  }
}
