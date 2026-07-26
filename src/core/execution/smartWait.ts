/**
 * smartWait.ts — Dynamic "settle" detection for async / CRUD-style UI operations.
 *
 * Fixed sleeps are unreliable: too short and the assertion after a click races
 * the API call it triggered; too long and every run pays the full penalty even
 * when nothing was pending. Instead this polls two real signals — in-flight
 * network requests and common loading/spinner indicators — and returns as soon
 * as both go quiet, up to a bounded cap. It never throws: a step that never
 * settles just proceeds, since the following assertion is the real judge of
 * whether the operation actually completed.
 */

import { Page } from '@playwright/test';

// Selectors covering the loading-indicator conventions of common UI frameworks
// (Bootstrap, MUI, Ant Design, generic ARIA busy state, custom .spinner/.loader).
const LOADING_INDICATOR_SELECTOR = [
  '[aria-busy="true"]',
  '.spinner',
  '.spinner-border',
  '.spinner-grow',
  '.loading',
  '.loader',
  '.skeleton',
  '.MuiCircularProgress-root',
  '.MuiSkeleton-root',
  '.ant-spin-spinning',
  '[data-testid*="spinner" i]',
  '[data-testid*="loading" i]',
  '[class*="loading-spinner" i]',
].join(', ');

export interface SmartWaitResult {
  /** Whether both network and loading-indicator signals went quiet before the cap. */
  settled: boolean;
  waitedMs: number;
  reason: string;
}

export interface SmartWaitOptions {
  /** Hard cap on total time spent waiting. Default 6s — enough for typical API calls without stalling the run. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Waits for pending network requests to drain and any visible loading
 * indicators to disappear. Call after any action that might kick off an
 * async operation (click, fill, select, check) — not just navigation.
 */
export async function waitForPageSettle(
  page: Page,
  opts: SmartWaitOptions = {},
): Promise<SmartWaitResult> {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const start = Date.now();

  let sawPendingActivity = false;

  while (Date.now() < deadline) {
    const pendingRequests = await countInFlightRequests(page).catch(() => 0);
    const spinnerVisible = await isLoadingIndicatorVisible(page).catch(() => false);

    if (pendingRequests > 0 || spinnerVisible) {
      sawPendingActivity = true;
      await page.waitForTimeout(pollIntervalMs);
      continue;
    }

    // Nothing pending right now — confirm it's a real quiet state, not a gap
    // between two chained requests, by re-checking after a short beat.
    await page.waitForTimeout(pollIntervalMs);
    const stillIdle =
      (await countInFlightRequests(page).catch(() => 0)) === 0 &&
      !(await isLoadingIndicatorVisible(page).catch(() => false));

    if (stillIdle) {
      return {
        settled: true,
        waitedMs: Date.now() - start,
        reason: sawPendingActivity
          ? 'Async activity detected and cleared (network + loading indicators quiet).'
          : 'No pending async activity detected.',
      };
    }
  }

  return {
    settled: false,
    waitedMs: Date.now() - start,
    reason: `Timed out after ${timeoutMs}ms waiting for network/loading indicators to settle — proceeding anyway.`,
  };
}

async function countInFlightRequests(page: Page): Promise<number> {
  // Playwright doesn't expose in-flight request count directly, so we track it
  // via the Resource Timing / PerformanceObserver-free approach: rely on the
  // page's own fetch/XHR bookkeeping is unnecessary — instead we piggyback on
  // page.evaluate to read `performance`-independent in-flight state we stash
  // on window via the injected counter (see installNetworkActivityTracker).
  return page.evaluate(() => {
    const w = window as unknown as { __autoqaPendingRequests?: number };
    return w.__autoqaPendingRequests ?? 0;
  });
}

async function isLoadingIndicatorVisible(page: Page): Promise<boolean> {
  const locator = page.locator(LOADING_INDICATOR_SELECTOR).first();
  return locator.isVisible({ timeout: 300 }).catch(() => false);
}

/**
 * Installs a lightweight fetch/XHR counter on every new document so
 * countInFlightRequests() has something real to read. Call once per page
 * right after creation (before navigation), via page.addInitScript.
 */
export async function installNetworkActivityTracker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __autoqaPendingRequests?: number };
    w.__autoqaPendingRequests = 0;

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args: Parameters<typeof fetch>) {
        w.__autoqaPendingRequests = (w.__autoqaPendingRequests ?? 0) + 1;
        return origFetch.apply(this, args).finally(() => {
          w.__autoqaPendingRequests = Math.max(0, (w.__autoqaPendingRequests ?? 1) - 1);
        });
      };
    }

    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;

      OrigXHR.prototype.open = function (...args: any[]) {
        return origOpen.apply(this, args as any);
      };

      OrigXHR.prototype.send = function (...args: any[]) {
        w.__autoqaPendingRequests = (w.__autoqaPendingRequests ?? 0) + 1;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          w.__autoqaPendingRequests = Math.max(0, (w.__autoqaPendingRequests ?? 1) - 1);
        };
        this.addEventListener('loadend', done);
        return origSend.apply(this, args as any);
      };
    }
  });
}

/**
 * Polls a target element/text until it reaches the desired visibility state,
 * or the timeout elapses. Unlike Validator, this NEVER throws or reports
 * failure — it's a readiness gate, not an assertion. Used by the 'waitUntil'
 * action so authors can write steps like `Wait until "Loading" disappears`
 * without risking a false-negative test failure if the UI is just slow.
 */
export async function waitUntilCondition(
  page: Page,
  target: string,
  mode: 'visible' | 'hidden',
  timeoutMs = 20_000,
): Promise<{ reached: boolean; waitedMs: number }> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  const isCssSelector = target.startsWith('#') || target.startsWith('.') || target.includes('[');

  const check = async (): Promise<boolean> => {
    let visible: boolean;
    if (isCssSelector) {
      visible = await page.locator(target).first().isVisible().catch(() => false);
    } else {
      const byText = await page.getByText(target).first().isVisible().catch(() => false);
      if (byText) {
        visible = true;
      } else {
        const bodyText = await page.innerText('body').catch(() => '');
        visible = bodyText.toLowerCase().includes(target.toLowerCase());
      }
    }
    return mode === 'visible' ? visible : !visible;
  };

  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return { reached: true, waitedMs: Date.now() - start };
    }
    await page.waitForTimeout(250);
  }

  return { reached: false, waitedMs: Date.now() - start };
}
