import { Page } from '@playwright/test';
import { ParsedStep } from '@/types/testCase';

// Universal timeout: 15 seconds max wait for any validation assertion.
// This handles slow post-login redirects and heavy SPA navigation gracefully.
const VALIDATION_TIMEOUT_MS = 15_000; // 15 seconds
const POLL_INTERVAL_MS = 500;           // check every 500ms

export interface IValidator {
  validate(page: Page, step: ParsedStep): Promise<{ success: boolean; error?: string }>;
}

export class Validator implements IValidator {
  /**
   * Polls a condition function up to VALIDATION_TIMEOUT_MS.
   * Returns true when the condition is met, false if it times out.
   */
  private async waitUntil(
    condition: () => Promise<boolean>,
    timeoutMs = VALIDATION_TIMEOUT_MS
  ): Promise<{ ok: boolean; lastValue?: string }> {
    const deadline = Date.now() + timeoutMs;
    let lastValue: string | undefined;

    while (Date.now() < deadline) {
      try {
        const result = await condition();
        if (result) return { ok: true };
      } catch {
        // page may still be navigating — swallow and retry
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return { ok: false, lastValue };
  }

  public async validate(
    page: Page,
    step: ParsedStep
  ): Promise<{ success: boolean; error?: string }> {
    const type = step.validation;
    const value = step.value;
    const target = step.targetField;

    try {
      switch (type) {
        // ------------------------------------------------------------------ //
        // URL VALIDATION — waits up to 2 min for the URL to match            //
        // ------------------------------------------------------------------ //
        case 'url': {
          if (!value) {
            return { success: false, error: 'Expected URL value was not provided.' };
          }

          let actualUrl = page.url();

          // First try Playwright's built-in waitForURL which respects navigation events
          try {
            await page.waitForURL(
              (u) => u.toString().toLowerCase().includes(value.toLowerCase()),
              { timeout: VALIDATION_TIMEOUT_MS }
            );
            return { success: true };
          } catch {
            // waitForURL may not be available in all versions — fall back to polling
          }

          // Polling fallback
          const { ok } = await this.waitUntil(async () => {
            actualUrl = page.url();
            return actualUrl.toLowerCase().includes(value.toLowerCase());
          });

          if (!ok) {
            actualUrl = page.url();
            return {
              success: false,
              error: `URL validation failed after ${VALIDATION_TIMEOUT_MS / 1000}s. Expected URL to contain "${value}", but actual URL was "${actualUrl}".`
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // VISIBILITY VALIDATION — waits up to 2 min for element to appear    //
        // ------------------------------------------------------------------ //
        case 'visible': {
          const selector =
            target.startsWith('#') || target.startsWith('.') || target.includes('[')
              ? target
              : `text="${target}"`;

          const locator = page.locator(selector).first();

          try {
            await locator.waitFor({ state: 'visible', timeout: VALIDATION_TIMEOUT_MS });
          } catch {
            return {
              success: false,
              error: `Visibility validation failed after ${VALIDATION_TIMEOUT_MS / 1000}s. Element matching "${target}" never became visible.`
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // ENABLED STATE VALIDATION — waits up to 2 min for element to enable //
        // ------------------------------------------------------------------ //
        case 'enabled': {
          const selector =
            target.startsWith('#') || target.startsWith('.') || target.includes('[')
              ? target
              : `button:has-text("${target}"), input[name="${target}"], #${target}`;

          const locator = page.locator(selector).first();

          // Wait for element to appear first, then check enabled
          try {
            await locator.waitFor({ state: 'attached', timeout: VALIDATION_TIMEOUT_MS });
          } catch {
            return {
              success: false,
              error: `Enabled validation failed after ${VALIDATION_TIMEOUT_MS / 1000}s. Element "${target}" was never found in the DOM.`
            };
          }

          const isEnabled = await locator.isEnabled({ timeout: 10_000 }).catch(() => false);
          if (!isEnabled) {
            return {
              success: false,
              error: `Enabled state validation failed. Element "${target}" exists but is not enabled.`
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // TEXT / MESSAGE VALIDATION — polls body text up to 2 min            //
        // ------------------------------------------------------------------ //
        case 'success_msg':
        case 'error_msg':
        case 'text': {
          if (!value) {
            return { success: false, error: 'Expected text value was not provided.' };
          }

          let lastBodyText = '';

          const { ok } = await this.waitUntil(async () => {
            // Wait for page to settle first (network idle with short timeout)
            try {
              await page.waitForLoadState('domcontentloaded', { timeout: 5_000 });
            } catch {
              // page still loading — body text may be partial, continue checking
            }

            lastBodyText = await page.innerText('body').catch(() => '');
            return lastBodyText.toLowerCase().includes(value.toLowerCase());
          });

          if (!ok) {
            return {
              success: false,
              error: `Text validation failed after ${VALIDATION_TIMEOUT_MS / 1000}s. Expected page to contain "${value}". Last page content preview: "${lastBodyText.substring(0, 200)}..."`
            };
          }
          break;
        }

        default:
          return { success: false, error: `Unsupported validation type: "${type}"` };
      }

      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message || 'Unknown assertion error occurred.'
      };
    }
  }
}
