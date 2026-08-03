/**
 * smartWait.ts — Dynamic "settle" detection for async / CRUD-style UI operations.
 *
 * Fixed sleeps are unreliable: too short and the assertion after a click races
 * the API call it triggered; too long and every run pays the full penalty even
 * when nothing was pending. Instead this polls real signals — in-flight network
 * requests, DOM mutations and common loading/spinner indicators — and returns as
 * soon as the page goes quiet, up to a bounded cap. It never throws: a step that
 * never settles just proceeds, since the following assertion is the real judge of
 * whether the operation actually completed.
 *
 * "Quiet" means zero in-flight requests and no visible loading indicator — full
 * stop, however long the request has been open. An earlier version of this file
 * tried to be cleverer than that: it discarded any request older than a couple of
 * seconds as "background traffic" (an attempt to handle apps whose network never
 * truly idles — long-polls, chat sockets, heartbeats), and separately let a
 * quiet-but-still-loading DOM declare victory on its own. Both of those escape
 * hatches turned out to fire just as eagerly for an entirely ordinary slow
 * response — a login call that takes several seconds, say — as they did for
 * actual background chatter, because neither age nor DOM stillness can tell the
 * two apart: a page that shows no visible spinner while waiting looks IDENTICAL
 * to one that never had anything left to wait for. That silently capped every
 * call to this function at about a second, no matter what timeoutMs the caller
 * asked for, and no caller ever got to find out.
 *
 * So there is no escape hatch now. A pending request is waited on for exactly as
 * long as the caller's own timeoutMs allows, which is the one thing that was
 * actually adjustable per situation in the first place — see
 * LOGIN_CONFIRM_SETTLE_MS in playwrightRunner.ts for the one call site sized for
 * a genuinely slow response. The DOM signal still does useful, narrower work:
 * once the network goes quiet, a page still visibly re-rendering (a still-moving
 * chart, a fade-in) gets a slightly longer confirmation before it's believed,
 * rather than being required to stop moving, which some pages never do.
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

/** How long the DOM must stop changing before the render counts as finished. */
const DOM_QUIET_MS = 350;

/** Confirmation beat — guards against the gap between two chained requests. */
const CONFIRM_MS = 120;

/**
 * Confirmation beat when the network has gone quiet but the DOM has not.
 *
 * Plenty of pages never stop mutating: a live clock, a marquee, a chart that
 * animates, a carousel. Requiring DOM stillness on those would burn the entire
 * budget on every step — the same trap as requiring network stillness. So an
 * animating page is allowed to settle on the network signal alone, just held a
 * little longer before it is believed.
 */
const ANIMATED_CONFIRM_MS = 350;

export interface SmartWaitResult {
  /** Whether the page reached a quiet state before the cap. */
  settled: boolean;
  waitedMs: number;
  reason: string;
}

export interface SmartWaitOptions {
  /**
   * Hard cap on total time spent waiting. Default 6s — the ceiling for a genuinely
   * slow operation. Typical steps return in a few hundred milliseconds because the
   * quiet signals arrive long before this.
   */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** One page-side reading of every settle signal, taken in a single round trip. */
interface SettleProbe {
  /** Requests currently in flight. */
  activeRequests: number;
  /** Milliseconds since the last DOM mutation. */
  domQuietMs: number;
  spinnerVisible: boolean;
}

/**
 * Waits for the page to go quiet after an action. Call after anything that might
 * kick off async work (navigate, click, fill, select, check) — not just navigation.
 */
export async function waitForPageSettle(
  page: Page,
  opts: SmartWaitOptions = {},
): Promise<SmartWaitResult> {
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const start = Date.now();
  const deadline = start + timeoutMs;

  let sawPendingActivity = false;
  let quietSince: number | null = null;

  while (Date.now() < deadline) {
    const probe = await readSettleProbe(page, deadline - Date.now());

    if (!probe) {
      // The page is mid-navigation (execution context torn down). That is itself
      // activity — wait a beat and read again.
      sawPendingActivity = true;
      quietSince = null;
      await sleep(pollIntervalMs);
      continue;
    }

    const networkQuiet = probe.activeRequests === 0;
    const domQuiet = probe.domQuietMs >= DOM_QUIET_MS;

    // A pending request is always waited on, however long it has been open —
    // "no requests left in flight" is the one signal that actually means the
    // action's own response has arrived. Age is not evidence otherwise: a login
    // or a slow API call is still exactly what the next step is waiting for
    // after two seconds, or ten. (An escape hatch keyed on request age or on
    // "the DOM stopped moving" was tried here and had to be removed — both
    // fire just as readily while a real, still-pending response is what the
    // rest of the run depends on as they do for genuine background chatter,
    // which turns "wait up to N seconds" into "wait about a second, always".
    // A page whose network truly never idles is bounded correctly by the
    // caller's own timeoutMs instead — see LOGIN_CONFIRM_SETTLE_MS for the one
    // call site generous enough for that to matter.)
    //
    // The DOM signal's only remaining job is deciding how long to hold a
    // network-quiet reading before believing it: a still-animating page (a
    // clock, a chart, a carousel) gets a slightly longer confirmation instead
    // of being required to stop moving, which it may never do.
    let quiet: boolean;
    let confirmMs = CONFIRM_MS;
    if (probe.spinnerVisible) {
      quiet = false;
    } else if (networkQuiet) {
      quiet = true;
      if (!domQuiet) confirmMs = ANIMATED_CONFIRM_MS;
    } else {
      quiet = false;
    }

    if (!quiet) {
      sawPendingActivity = true;
      quietSince = null;
      await sleep(pollIntervalMs);
      continue;
    }

    // Quiet — hold it briefly so the gap between two chained requests is not
    // mistaken for the end of the operation.
    if (quietSince === null) {
      quietSince = Date.now();
      await sleep(confirmMs);
      continue;
    }

    return {
      settled: true,
      waitedMs: Date.now() - start,
      reason: sawPendingActivity
        ? 'Async activity detected and cleared (network, DOM and loading indicators quiet).'
        : 'Page already quiet — no pending async activity.',
    };
  }

  // Report the time that actually elapsed, not the budget. They are normally the
  // same, but when the host is badly starved a single poll can overrun by far
  // more than the budget — and a line reading "timed out after 6000ms (211407ms)"
  // makes the reader doubt the log rather than suspect the machine.
  const waitedMs = Date.now() - start;
  const overran = waitedMs > timeoutMs * 1.5;
  return {
    settled: false,
    waitedMs,
    reason: overran
      ? `Gave up waiting for the page to settle after ${waitedMs}ms (budget was ${timeoutMs}ms — the ` +
        `overrun means this machine or the browser was starved, not that the page was busy that long) ` +
        `— proceeding anyway.`
      : `Timed out after ${timeoutMs}ms waiting for the page to settle — proceeding anyway.`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves to `fallback` if `promise` has not settled within `ms`.
 *
 * `page.evaluate` takes no timeout and is not covered by Playwright's action
 * timeout, so a page that stops being evaluable — mid-navigation, a blocked main
 * thread, a renderer that has wedged — hangs it indefinitely. A single such call
 * inside a polling loop suspends the loop, and the caller's timeout never gets a
 * chance to fire: an assertion budgeted at two seconds can sit there for minutes.
 * Racing every page-side read keeps the advertised budget an actual budget.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    promise
      .then((value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

/** Longest a single page-side probe may take before it is abandoned as unresponsive. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * Reads every settle signal in ONE page.evaluate. The previous implementation
 * made two round trips per poll (a counter read plus a locator visibility check);
 * over a run that is thousands of needless IPC hops.
 *
 * Returns null when the page cannot be evaluated right now — almost always
 * because a navigation is swapping the execution context out from under us.
 */
async function readSettleProbe(page: Page, budgetMs: number): Promise<SettleProbe | null> {
  const probeBudget = Math.max(100, Math.min(PROBE_TIMEOUT_MS, budgetMs));
  return withTimeout(readSettleProbeUnbounded(page), probeBudget, null);
}

async function readSettleProbeUnbounded(page: Page): Promise<SettleProbe | null> {
  try {
    return await page.evaluate((spinnerSelector) => {
      const w = window as unknown as {
        __autoqaPendingCount?: number;
        __autoqaLastMutationAt?: number;
      };
      const now = Date.now();
      const activeRequests = w.__autoqaPendingCount ?? 0;

      let spinnerVisible = false;
      const nodes = document.querySelectorAll(spinnerSelector);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i] as HTMLElement;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (Number(style.opacity) === 0) continue;
        spinnerVisible = true;
        break;
      }

      // No observer installed (a page that loaded before the tracker, say) —
      // report the DOM as quiet rather than blocking on a signal we never get.
      const lastMutationAt = w.__autoqaLastMutationAt;
      const domQuietMs = typeof lastMutationAt === 'number' ? now - lastMutationAt : 10_000;

      return { activeRequests, domQuietMs, spinnerVisible };
    }, LOADING_INDICATOR_SELECTOR);
  } catch {
    return null;
  }
}

/**
 * Installs the page-side signals waitForPageSettle() reads: a fetch/XHR tracker
 * that records when each request *started*, and a MutationObserver timestamp.
 * Call once per page right after creation (before navigation), via addInitScript
 * so it survives every navigation.
 */
export async function installNetworkActivityTracker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Bundlers that preserve function names rewrite functions into __name(fn, "fn").
    // That helper lives in the bundle, not in the page, so shim it as identity.
    const g = window as unknown as { __name?: (fn: unknown) => unknown };
    if (!g.__name) g.__name = (fn: unknown) => fn;

    const w = window as unknown as {
      __autoqaPendingCount?: number;
      __autoqaLastMutationAt?: number;
      __autoqaTrackerInstalled?: boolean;
    };
    if (w.__autoqaTrackerInstalled) return;
    w.__autoqaTrackerInstalled = true;

    w.__autoqaPendingCount = 0;
    w.__autoqaLastMutationAt = Date.now();

    const begin = () => {
      w.__autoqaPendingCount = (w.__autoqaPendingCount ?? 0) + 1;
    };
    const end = () => {
      w.__autoqaPendingCount = Math.max(0, (w.__autoqaPendingCount ?? 1) - 1);
    };

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args: Parameters<typeof fetch>) {
        begin();
        return origFetch.apply(this, args).finally(end);
      };
    }

    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.send = function (...args: any[]) {
        begin();
        let settled = false;
        this.addEventListener('loadend', () => {
          if (settled) return;
          settled = true;
          end();
        });
        return origSend.apply(this, args as any);
      };
    }

    // The DOM is the signal that survives apps whose network never goes idle:
    // once rendering stops changing, the operation is visibly complete.
    const markMutation = () => {
      w.__autoqaLastMutationAt = Date.now();
    };
    const startObserver = () => {
      const target = document.documentElement || document.body;
      if (!target) return;
      try {
        new MutationObserver(markMutation).observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        /* observation unsupported — network + spinner signals still apply */
      }
    };

    if (document.documentElement) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
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
    await sleep(200);
  }

  return { reached: false, waitedMs: Date.now() - start };
}
