import { Page } from '@playwright/test';
import { ParsedStep } from '@/types/testCase';
import { matchUrlLiterally, matchUrlSemantically, normaliseUrl, roleOf } from './urlMatcher';

// Universal timeout: 15 seconds max wait for any validation assertion.
// This handles slow post-login redirects and heavy SPA navigation gracefully.
const VALIDATION_TIMEOUT_MS = 15_000; // 15 seconds
const POLL_INTERVAL_MS = 200;           // check every 200ms

/**
 * How long the URL must hold still before a semantic match is considered.
 *
 * The wait exists to let a redirect chain finish — landing on `/` for a moment on
 * the way to `/desktop/home` must not be judged. Once the address bar has stopped
 * moving there is nothing further to wait for, so a URL assertion that will pass
 * semantically passes in about a second instead of burning the whole budget first.
 */
const URL_STABLE_MS = 900;

export interface ValidationOutcome {
  success: boolean;
  error?: string;
  /**
   * Set when an assertion passed on something looser than a literal comparison.
   * Always surfaced in the step log and the report — a pass the reader might
   * disagree with has to be visible, or the flexibility becomes a blind spot.
   */
  note?: string;
}

export interface IValidator {
  validate(page: Page, step: ParsedStep): Promise<ValidationOutcome>;
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

    while (Date.now() < deadline) {
      try {
        const result = await condition();
        if (result) return { ok: true };
      } catch {
        // page may still be navigating — swallow and retry
      }
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return { ok: false };
  }

  /**
   * Evidence that the browser really is inside the authenticated application,
   * used to corroborate a semantic landing-page match. A visible password field
   * means we are still at the door however the URL is spelled.
   */
  private async looksLikeAuthenticatedApp(page: Page): Promise<boolean> {
    try {
      const passwordVisible = await page
        .locator('input[type="password"]')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (passwordVisible) return false;

      // Application chrome that only renders for a signed-in user.
      const chrome = await page
        .locator('nav, header, [role="navigation"], [role="banner"], aside, [class*="sidebar" i]')
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      return chrome;
    } catch {
      return false;
    }
  }

  public async validate(
    page: Page,
    step: ParsedStep
  ): Promise<ValidationOutcome> {
    const type = step.validation;
    const value = step.value;
    const target = step.targetField;

    try {
      switch (type) {
        // ------------------------------------------------------------------ //
        // URL VALIDATION                                                      //
        //   A single polling loop, sharing ONE timeout budget, that watches   //
        //   the address bar for the literal route and accepts a corroborated  //
        //   semantic match as soon as the URL stops moving.                   //
        //                                                                     //
        //   The tiers used to run in sequence — waitForURL for the full       //
        //   budget, then an identical poll for the full budget again, and     //
        //   only then the semantic check. Both stages test the same predicate //
        //   on the same URL, so an assertion destined to pass semantically    //
        //   spent 30 seconds proving twice over what it already knew before   //
        //   returning "passed". Verdict below is unchanged; only the waiting  //
        //   is gone.                                                          //
        // ------------------------------------------------------------------ //
        case 'url': {
          if (!value) {
            return { success: false, error: 'Expected URL value was not provided.' };
          }

          // ── 1. Check the current URL immediately (zero wait) ──────────────
          // Common case: navigation already completed (e.g. after click + settle).
          const immediate = matchUrlLiterally(value, page.url());
          if (immediate.matched) return { success: true, note: immediate.note };

          const deadline = Date.now() + VALIDATION_TIMEOUT_MS;
          let actualUrl = page.url();
          let stableSince = Date.now();
          // A landing-page claim is only ever accepted with evidence from the page
          // itself, and that evidence costs a DOM read — so it is retried on a
          // slower cadence than the address-bar poll, not on every pass.
          let lastSemanticCheckAt = 0;

          const trySemantic = async (url: string): Promise<ValidationOutcome | null> => {
            if (step.strict) return null;
            const corroborated =
              roleOf(value) === 'landing' ? await this.looksLikeAuthenticatedApp(page) : true;
            const semantic = matchUrlSemantically(value, url, corroborated);
            return semantic.matched ? { success: true, note: semantic.note } : null;
          };

          while (Date.now() < deadline) {
            const currentUrl = page.url();
            if (currentUrl !== actualUrl) {
              // Still redirecting — restart the stability window.
              actualUrl = currentUrl;
              stableSince = Date.now();
              lastSemanticCheckAt = 0;
            }

            // ── 2. Literal tier — exact substring or whole path segments ────
            const literal = matchUrlLiterally(value, actualUrl);
            if (literal.matched) return { success: true, note: literal.note };

            // ── 3. Semantic tier — the test and the app name the same page ──
            // Only once the address bar has held still: a redirect chain passing
            // through a landing-shaped URL must not be judged mid-flight. Retried
            // while the budget lasts, since the signed-in chrome that corroborates
            // a landing match may still be rendering.
            const stableFor = Date.now() - stableSince;
            if (stableFor >= URL_STABLE_MS && Date.now() - lastSemanticCheckAt >= URL_STABLE_MS) {
              lastSemanticCheckAt = Date.now();
              const semantic = await trySemantic(actualUrl);
              if (semantic) return semantic;
            }

            await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
          }

          // Budget spent. One last look, so a page that finished rendering on the
          // final beat is judged on its finished state rather than a stale read.
          actualUrl = page.url();
          const lastLiteral = matchUrlLiterally(value, actualUrl);
          if (lastLiteral.matched) return { success: true, note: lastLiteral.note };
          const lastSemantic = await trySemantic(actualUrl);
          if (lastSemantic) return lastSemantic;

          const sameRole = roleOf(value) && roleOf(value) === roleOf(actualUrl);
          return {
            success: false,
            error:
              `URL validation failed after ${VALIDATION_TIMEOUT_MS / 1000}s. ` +
              `Expected URL to contain "${value}", but actual URL was "${actualUrl}".\n\n` +
              (step.strict
                ? `This step requested an exact route match, so no semantic fallback was attempted.`
                : sameRole
                  ? `Both paths name the same kind of page, but the page did not look like a signed-in view, ` +
                    `so this was not accepted as an equivalent route.`
                  : `"${normaliseUrl(value)}" and "${normaliseUrl(actualUrl)}" are different pages, not two names ` +
                    `for the same one. If the application is correct here, update the expected route in the test case.\n\n` +
                    `Tip: If this is a single-page app (SPA), add "wait 2 seconds" before the URL assertion ` +
                    `to allow client-side routing to complete.`),
          };
        }

        // ------------------------------------------------------------------ //
        // NOT_URL VALIDATION — verifies URL does NOT contain the value        //
        // ------------------------------------------------------------------ //
        case 'not_url': {
          if (!value) {
            return { success: false, error: 'Expected URL value was not provided.' };
          }

          const normalise = (u: string) =>
            u.toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '').trim();

          const needle = normalise(value);
          let actualUrl = page.url();

          // Wait up to 5s to ensure the URL does not match
          const { ok } = await this.waitUntil(async () => {
            actualUrl = page.url();
            return !normalise(actualUrl).includes(needle);
          }, 5_000);

          if (!ok || normalise(actualUrl).includes(needle)) {
            return {
              success: false,
              error: `URL negative validation failed. Expected URL to NOT contain "${value}", but current URL is "${actualUrl}".`
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // VISIBILITY VALIDATION — waits up to 15s for element/text to appear //
        // ------------------------------------------------------------------ //
        case 'visible': {
          const targetStr = target || value || '';
          if (!targetStr) {
            return { success: false, error: 'Target for visibility validation was not provided.' };
          }

          const isCssSelector = targetStr.startsWith('#') || targetStr.startsWith('.') || targetStr.includes('[');

          const { ok } = await this.waitUntil(async () => {
            if (isCssSelector) {
              const locator = page.locator(targetStr).first();
              return await locator.isVisible().catch(() => false);
            } else {
              // Try Playwright getByText (case-insensitive substring match)
              const locator = page.getByText(targetStr).first();
              if (await locator.isVisible().catch(() => false)) return true;

              // Fallback: check if target text is contained anywhere in rendered body text
              const bodyText = await page.innerText('body').catch(() => '');
              return bodyText.toLowerCase().includes(targetStr.toLowerCase());
            }
          });

          if (!ok) {
            return {
              success: false,
              error: `Visibility validation failed after ${VALIDATION_TIMEOUT_MS / 1000}s. Element/text matching "${targetStr}" never became visible.`
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // NOT_VISIBLE VALIDATION — waits up to 10s for element/text to hide  //
        // ------------------------------------------------------------------ //
        case 'not_visible': {
          const targetStr = target || value || '';
          if (!targetStr) {
            return { success: false, error: 'Target for negative visibility validation was not provided.' };
          }

          const isCssSelector = targetStr.startsWith('#') || targetStr.startsWith('.') || targetStr.includes('[');

          const { ok } = await this.waitUntil(async () => {
            if (isCssSelector) {
              const locator = page.locator(targetStr).first();
              const visible = await locator.isVisible().catch(() => false);
              return !visible;
            } else {
              const locator = page.getByText(targetStr).first();
              const visible = await locator.isVisible().catch(() => false);
              if (visible) return false;

              const bodyText = await page.innerText('body').catch(() => '');
              return !bodyText.toLowerCase().includes(targetStr.toLowerCase());
            }
          }, 10_000);

          if (!ok) {
            return {
              success: false,
              error: `Negative visibility validation failed. Element/text "${targetStr}" is still visible on the page.`
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // ENABLED STATE VALIDATION — waits up to 15s for element to enable  //
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
        // DISABLED STATE VALIDATION — waits up to 10s for element to disable//
        // ------------------------------------------------------------------ //
        case 'disabled': {
          const selector =
            target.startsWith('#') || target.startsWith('.') || target.includes('[')
              ? target
              : `button:has-text("${target}"), input[name="${target}"], #${target}`;

          const locator = page.locator(selector).first();

          const { ok } = await this.waitUntil(async () => {
            const isDisabled = await locator.isDisabled().catch(() => false);
            const isEnabled = await locator.isEnabled().catch(() => true);
            return isDisabled || !isEnabled;
          }, 10_000);

          if (!ok) {
            return {
              success: false,
              error: `Disabled state validation failed. Element "${target}" is enabled.`
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // MESSAGE VALIDATION — success/error banners, alerts, toasts,        //
        // notifications or status messages on page.                          //
        // ------------------------------------------------------------------ //
        case 'success_msg':
        case 'error_msg': {
          const needle = (value || '').trim().toLowerCase();
          const isErrorMsg = type === 'error_msg';

          const regions = isErrorMsg
            ? [
                '[role="alert"]',
                '.error',
                '.error-message',
                '.error-msg',
                '.alert-danger',
                '.alert-error',
                '.invalid-feedback',
                '.toast',
                '.notification',
                '.message',
                '.snackbar',
                '.banner',
                '[data-testid*="error"]',
                '[id*="error"]',
                '[class*="error"]',
                '[class*="alert"]',
                '[class*="toast"]',
                '[class*="notification"]',
              ]
            : [
                '[role="status"]',
                '[role="alert"]',
                '.success',
                '.alert-success',
                '.flash.success',
                '.toast',
                '.notification',
                '.message',
                '.snackbar',
                '.banner',
                '[data-testid*="success"]',
                '[id*="success"]',
                '[class*="success"]',
              ];

          let lastRegionText = '';

          const { ok } = await this.waitUntil(async () => {
            // 1. Check known alert/error/success elements first
            for (const sel of regions) {
              const loc = page.locator(sel);
              const count = await loc.count().catch(() => 0);
              for (let i = 0; i < count; i++) {
                const el = loc.nth(i);
                if (!(await el.isVisible().catch(() => false))) continue;
                const txt = (await el.innerText().catch(() => '')).trim();
                if (txt) lastRegionText = txt;

                if (!needle) {
                  // No specific text payload requested (e.g. "verify error message")
                  // Any visible non-empty error/status region is a match!
                  return true;
                } else if (txt.toLowerCase().includes(needle)) {
                  return true;
                }
              }
            }

            // 2. Fallback if specific text needle was provided: check if it appears in body text
            if (needle) {
              const bodyText = await page.innerText('body').catch(() => '');
              if (bodyText.toLowerCase().includes(needle)) return true;
            } else if (isErrorMsg) {
              // 3. Fallback: check if body contains common error keywords
              const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
              const commonErrorKeywords = [
                'invalid',
                'incorrect',
                'failed',
                'unauthorized',
                'wrong',
                'denied',
                'error',
                'unable to',
              ];
              for (const kw of commonErrorKeywords) {
                if (bodyText.includes(kw)) return true;
              }
            }

            return false;
          });

          if (!ok) {
            const detail = lastRegionText
              ? `Closest visible ${isErrorMsg ? 'error' : 'status'} region said: "${lastRegionText.substring(0, 200)}".`
              : `No visible ${isErrorMsg ? 'error' : 'success'} message region was found on the page.`;
            const expectedDesc = value ? `containing "${value}"` : 'on the page';
            return {
              success: false,
              error: `${isErrorMsg ? 'Error' : 'Success'} message validation failed after ${VALIDATION_TIMEOUT_MS / 1000}s. Expected a visible ${isErrorMsg ? 'error' : 'success'} message ${expectedDesc}. ${detail}`,
            };
          }
          break;
        }

        // ------------------------------------------------------------------ //
        // GENERIC TEXT VALIDATION — visible page text contains the value.    //
        // Uses innerText (rendered/visible only), never hidden DOM.          //
        // ------------------------------------------------------------------ //
        case 'text': {
          if (!value) {
            return { success: false, error: 'Expected text value was not provided.' };
          }

          let lastBodyText = '';

          const { ok } = await this.waitUntil(async () => {
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

        // ------------------------------------------------------------------ //
        // NOT_TEXT VALIDATION — verifies visible page text does NOT contain  //
        // ------------------------------------------------------------------ //
        case 'not_text': {
          if (!value) {
            return { success: false, error: 'Expected text value for negative assertion was not provided.' };
          }

          let lastBodyText = '';

          const { ok } = await this.waitUntil(async () => {
            lastBodyText = await page.innerText('body').catch(() => '');
            return !lastBodyText.toLowerCase().includes(value.toLowerCase());
          }, 5_000);

          if (!ok) {
            return {
              success: false,
              error: `Negative text validation failed. Page still contains unwanted text "${value}".`
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
