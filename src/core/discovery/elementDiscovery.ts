/**
 * elementDiscovery.ts — Smart Element Locator (Main Entry Point)
 *
 * This module implements a multi-strategy element discovery engine that
 * intelligently finds DOM elements based on natural-language field names
 * from test steps.
 */

import { Page } from '@playwright/test';
import { DiscoveryMatch } from '@/types/execution';
import { scoreElement, ElementAttributes, ScoringContext } from './scoring';
import {
  semanticTypeStrategy,
  ariaRoleStrategy,
  labelStrategy,
  placeholderStrategy,
  nameStrategy,
  idStrategy,
  dataTestIdStrategy,
  textStrategy,
  autocompleteStrategy,
  aliasStrategy,
  avatarStrategy,
  extractInitials,
  isProfileTarget,
  similarityFallback,
  StrategyCandidate,
} from './strategies';

const DEBUG = process.env.AUTOQA_DISCOVERY_DEBUG === '1';

// Structural containers are never valid interaction targets — even when their
// id/name/data-testid happens to match the field text (e.g. a login <form
// id="login">). Clicking or filling one is always wrong, so they're rejected
// before scoring regardless of how well their attributes matched.
const NON_INTERACTIVE_TAGS = new Set(['form', 'fieldset', 'html', 'body']);

// Minimum confidence to accept a real DOM element. Below this we fail clearly
// rather than acting on a wrong element or a fabricated generic selector.
const MIN_CONFIDENCE = 35;

// A client-rendered app can paint its form a beat after the page reports 'load',
// so a single DOM pass may legitimately find nothing. One re-scan covers that;
// beyond it the element is genuinely absent and further passes only slow the
// failure down. The runner already settles on network/spinner activity before
// each step, so the render gap this guards against is short.
const DISCOVERY_ATTEMPTS = 2;
const DISCOVERY_RETRY_DELAY_MS = 900;

// Bare tag selectors resolve to "whatever happens to be first" — fine for the
// click that just happened, useless in a generated regression script. When one
// wins we re-derive a unique selector for the element it actually hit.
const GENERIC_SELECTORS = new Set(['button', 'input', 'a', 'div', 'span', 'textarea', 'select', 'img']);

/** The page-side helper `_ensurePageHelpers` installs, used inside `page.evaluate` bodies. */
type AutoQAWindow = Window & typeof globalThis & {
  __autoqaUniqueSelector?: (el: Element) => string;
};

/** Where on the screen a step says the element lives ("top right", "bottom left"). */
export interface PositionHint {
  vertical?: 'top' | 'bottom';
  horizontal?: 'left' | 'right';
}

/**
 * Splits positional wording out of a target so it can steer the search instead of
 * polluting the text match — "JR icon button right top" is a two-letter avatar in
 * the top-right corner, not an element whose label contains the word "top".
 *
 * A lone direction word is left in the text: "Left panel" and "Right arrow" are
 * real labels. Only two or more positional tokens (or a direction plus
 * corner/side) are read as a location.
 */
export function parsePositionHint(target: string): { cleaned: string; hint: PositionHint | null } {
  const hint: PositionHint = {};
  const kept: string[] = [];
  let positionalTokens = 0;

  for (const token of target.split(/[\s_\-]+/)) {
    switch (token.toLowerCase().replace(/[^a-z]/g, '')) {
      case 'top':
      case 'upper':
        hint.vertical = 'top'; positionalTokens++; continue;
      case 'bottom':
      case 'lower':
        hint.vertical = 'bottom'; positionalTokens++; continue;
      case 'right':
        hint.horizontal = 'right'; positionalTokens++; continue;
      case 'left':
        hint.horizontal = 'left'; positionalTokens++; continue;
      case 'corner':
      case 'side':
        positionalTokens++; continue;
      default:
        kept.push(token);
    }
  }

  if (positionalTokens < 2 || (!hint.vertical && !hint.horizontal)) {
    return { cleaned: target, hint: null };
  }
  return { cleaned: kept.join(' ').trim() || target, hint };
}

/** Thrown when no element can be confidently matched for a field name. */
export class ElementNotFoundError extends Error {
  constructor(public target: string, public bestScore: number) {
    super(
      `Element not found for "${target}" (best confidence ${Math.max(0, Math.round(bestScore))}%, ` +
        `need ${MIN_CONFIDENCE}%). Rephrase the step or add an id / label / data-testid to the element.`,
    );
    this.name = 'ElementNotFoundError';
  }
}

const dlog = (...args: any[]) => {
  if (DEBUG) console.log('[ElementDiscovery]', ...args);
};

// STRATEGIES priority list — ordered from most specific → most general
const STRATEGIES = [
  { name: 'semanticType',    fn: semanticTypeStrategy },
  { name: 'id',              fn: idStrategy },
  { name: 'name',            fn: nameStrategy },
  { name: 'dataTestId',      fn: dataTestIdStrategy },
  { name: 'ariaRole',        fn: ariaRoleStrategy },
  { name: 'label',           fn: labelStrategy },
  { name: 'placeholder',     fn: placeholderStrategy },
  { name: 'text',            fn: textStrategy },
  { name: 'autocomplete',    fn: autocompleteStrategy },
  { name: 'alias',           fn: aliasStrategy },
  { name: 'avatar',          fn: avatarStrategy },
];

export interface IElementDiscoveryEngine {
  discover(page: Page, fieldName: string): Promise<DiscoveryMatch>;
  scanInteractiveElements(page: Page): Promise<Record<string, DiscoveryMatch>>;
}

export class ElementDiscoveryEngine implements IElementDiscoveryEngine {
  /**
   * discover — Find the best-matching DOM element for the given field name.
   *
   * Retries the scan a few times: an element that has not rendered yet is a timing
   * problem, not a missing element, and failing on the first pass makes runs flaky
   * on client-rendered apps.
   */
  public async discover(page: Page, fieldName: string): Promise<DiscoveryMatch> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
      try {
        return await this._discoverOnce(page, fieldName);
      } catch (err) {
        lastError = err;
        if (!(err instanceof ElementNotFoundError) || attempt === DISCOVERY_ATTEMPTS) break;
        dlog(`Attempt ${attempt} found nothing for "${fieldName}" — re-scanning shortly`);
        await page.waitForTimeout(DISCOVERY_RETRY_DELAY_MS).catch(() => {});
      }
    }

    throw lastError;
  }

  /** One full discovery pass over the current DOM. */
  private async _discoverOnce(page: Page, fieldName: string): Promise<DiscoveryMatch> {
    const rawTarget = fieldName.trim();
    // Positional wording steers the search rather than being matched as text.
    const { cleaned, hint } = parsePositionHint(rawTarget);
    const targetText = cleaned.toLowerCase().replace(/[\s_\-]+/g, ' ').trim();
    const ctx: ScoringContext = { targetText, rawTarget: cleaned };

    const initials = extractInitials(cleaned);
    const isProfile = isProfileTarget(cleaned);
    // Position, bare initials and profile vocabulary are all signals the attribute
    // strategies are blind to, so those targets get the visual pass regardless of
    // what the attribute scan turns up.
    const needsVisualScan = !!hint || !!initials || isProfile;

    dlog(
      `Discovering element for: "${rawTarget}"` +
        (hint ? ` [position ${hint.vertical ?? 'any'}-${hint.horizontal ?? 'any'}]` : '') +
        (initials ? ` [initials ${initials}]` : ''),
    );

    // Determine action context hints
    const isInputHint = this._isInputIntent(targetText);
    const isButtonHint = this._isButtonIntent(targetText);

    // Collect all strategy candidates
    const allCandidates: StrategyCandidate[] = [];

    for (const { name, fn } of STRATEGIES) {
      const results = fn(targetText);
      dlog(`  Strategy [${name}] generated ${results.length} candidates`);
      allCandidates.push(...results);
    }

    // Add similarity fallback with context hints
    allCandidates.push(...similarityFallback(targetText, { isInputHint, isButtonHint }));

    dlog(`  Total candidates: ${allCandidates.length}`);

    // Deduplicate selectors
    const seenSelectors = new Set<string>();
    const uniqueCandidates = allCandidates.filter(c => {
      if (seenSelectors.has(c.selector)) return false;
      seenSelectors.add(c.selector);
      return true;
    });

    // Probe every candidate concurrently, then pick the highest scorer.
    // Parallelizing replaces the old serial 800ms-per-candidate scan.
    const probes = await Promise.all(
      uniqueCandidates.map(async (candidate) => {
        try {
          const locator = page.locator(candidate.selector).first();
          const isVisible = await locator.isVisible({ timeout: 800 }).catch(() => false);
          if (!isVisible) return null;
          const attrs = await this._extractAttributes(page, candidate.selector);
          if (NON_INTERACTIVE_TAGS.has(attrs.tagName)) return null;
          const { score, winningSignal } = scoreElement(attrs, ctx);
          dlog(`  ${candidate.selector} → score ${score} (${winningSignal})`);
          return { candidate, attrs, score, winningSignal };
        } catch {
          return null;
        }
      }),
    );

    let bestMatch: DiscoveryMatch | null = null;
    let bestScore = -1;
    for (const p of probes) {
      if (!p || p.score <= bestScore) continue;
      bestScore = p.score;
      bestMatch = {
        selector: p.candidate.selector,
        score: p.score,
        strategy: p.winningSignal as DiscoveryMatch['strategy'],
        tagName: p.attrs.tagName,
        attributes: {
          id: p.attrs.id,
          name: p.attrs.name,
          type: p.attrs.type,
          placeholder: p.attrs.placeholder,
          'aria-label': p.attrs.ariaLabel,
          class: p.attrs.classNames,
        },
      };
    }

    if (bestMatch && bestMatch.score >= 50 && !needsVisualScan) {
      dlog(`Final winner: "${bestMatch.selector}" (score ${bestMatch.score}, signal ${bestMatch.strategy})`);
      return await this._finalizeMatch(page, bestMatch);
    }

    // Visual pass — matches on geometry (shape, screen quadrant, chrome position)
    // as well as text, which is the only way to pin down controls that carry their
    // meaning visually: initials avatars, icon buttons, unlabelled menu triggers.
    if (needsVisualScan) {
      const visual = await this._visualScan(page, { targetText, initials, isProfile, hint });
      if (visual && visual.score > (bestMatch?.score ?? -1)) {
        dlog(`Visual scan wins: "${visual.selector}" (score ${visual.score}, ${visual.strategy})`);
        bestMatch = visual;
        bestScore = visual.score;
      }
      if (bestMatch && bestMatch.score >= MIN_CONFIDENCE) {
        return await this._finalizeMatch(page, bestMatch);
      }
    }

    // Full DOM scan fallback — scores every interactive element in one evaluate().
    dlog('No strategy hit confidence >= 50 — falling back to full DOM scan');
    const domFallback = await this._fullDomScan(page, ctx);
    if (domFallback && domFallback.score > (bestMatch?.score || 0)) {
      bestMatch = domFallback;
      bestScore = domFallback.score;
    }

    // Accept the best real element only if it clears the confidence floor;
    // otherwise fail clearly instead of acting on the wrong element.
    if (bestMatch && bestMatch.score >= MIN_CONFIDENCE) {
      dlog(`Accepting best match: "${bestMatch.selector}" (score ${bestMatch.score})`);
      return await this._finalizeMatch(page, bestMatch);
    }

    throw new ElementNotFoundError(rawTarget, bestScore);
  }

  /** Turns a raw winner into something safe to act on and to write into a script. */
  private async _finalizeMatch(page: Page, match: DiscoveryMatch): Promise<DiscoveryMatch> {
    return await this._promoteToClickable(page, await this._stabilize(page, match));
  }

  /**
   * Replaces a bare tag selector with a unique one for the element it resolved to.
   *
   * `button` clicks the right thing often enough at runtime, but it is worthless in
   * a generated regression script — the generator rejects it, and any DOM change
   * silently re-points it. Everything else is returned untouched.
   */
  private async _stabilize(page: Page, match: DiscoveryMatch): Promise<DiscoveryMatch> {
    if (!GENERIC_SELECTORS.has(match.selector.trim())) return match;
    try {
      await this._ensurePageHelpers(page);
      const unique = await page
        .locator(match.selector)
        .first()
        .evaluate((el) => (window as AutoQAWindow).__autoqaUniqueSelector?.(el) ?? null);
      if (typeof unique === 'string' && unique) {
        dlog(`Stabilised "${match.selector}" → "${unique}"`);
        return { ...match, selector: unique };
      }
    } catch {
      /* keep the original selector */
    }
    return match;
  }

  /**
   * Walks a decorative match up to the control that actually handles the click.
   *
   * Text matching lands on the innermost node holding the text, which is often not
   * the clickable one. Ligature icon fonts make this routine rather than rare:
   * Material Symbols renders `<span class="material-symbols-outlined">logout</span>`,
   * so the glyph's text content is literally the word "logout" and an exact text
   * match prefers the 18px icon over the menu item wrapping it.
   *
   * Only non-interactive matches are promoted, and only to a control small enough to
   * be a control — so inputs, buttons and links are never touched, and a stray text
   * node cannot escalate into clicking half the page.
   */
  private async _promoteToClickable(page: Page, match: DiscoveryMatch): Promise<DiscoveryMatch> {
    try {
      await this._ensurePageHelpers(page);
      const promoted = await page
        .locator(match.selector)
        .first()
        .evaluate((el) => {
          const INTERACTIVE =
            'a, button, input, select, textarea, [role="button"], [role="menuitem"], [role="link"], [role="tab"], [role="option"], [onclick]';
          if (el.matches(INTERACTIVE)) return null;
          // A wrapper around a form field needs descending into, not ascending from.
          if (el.querySelector('input, textarea, select')) return null;

          let cur: Element | null = el.parentElement;
          for (let depth = 0; depth < 4 && cur; depth++, cur = cur.parentElement) {
            if (!cur.matches(INTERACTIVE)) continue;
            const r = cur.getBoundingClientRect();
            if (r.width > 600 || r.width * r.height > 120_000) return null;
            return (window as AutoQAWindow).__autoqaUniqueSelector?.(cur) ?? null;
          }
          return null;
        });

      if (typeof promoted === 'string' && promoted && promoted !== match.selector) {
        dlog(`Promoted "${match.selector}" → clickable ancestor "${promoted}"`);
        return { ...match, selector: promoted, strategy: `${match.strategy} + clickable-ancestor` };
      }
    } catch {
      /* keep the original selector */
    }
    return match;
  }

  /**
   * Visual scan — scores on-screen candidates by shape, screen position and text.
   *
   * The attribute strategies can only see what the markup declares. A profile menu
   * is typically an unlabelled round div holding two letters, which declares nothing
   * useful; what identifies it is that it is small, circular, in the top-right of the
   * header, and shows the user's initials. This pass reads exactly those properties.
   */
  private async _visualScan(
    page: Page,
    opts: { targetText: string; initials: string | null; isProfile: boolean; hint: PositionHint | null },
  ): Promise<DiscoveryMatch | null> {
    let candidates: VisualCandidate[];
    try {
      await this._ensurePageHelpers(page);
      candidates = await page.evaluate(collectVisualCandidates);
    } catch (e) {
      dlog('Visual scan failed to collect candidates:', e);
      return null;
    }

    dlog(`  Visual scan collected ${candidates.length} on-screen candidates`);

    let best: DiscoveryMatch | null = null;
    let bestScore = -1;

    for (const c of candidates) {
      const { score, signal } = scoreVisualCandidate(c, opts);
      if (score <= bestScore) continue;
      bestScore = score;
      best = {
        selector: c.selector,
        score,
        strategy: signal,
        tagName: c.tagName,
        attributes: c.attrs,
      };
    }

    if (best) dlog(`  Visual best: "${best.selector}" (${best.score}, ${best.strategy})`);
    return best;
  }

  /**
   * Prepares the page for the functions we hand to `page.evaluate` (idempotent).
   *
   * Bundlers that preserve function names (esbuild/tsx and friends) rewrite every
   * named function into `__name(fn, "fn")`. That helper is defined in the bundle,
   * not in the page, so any evaluated function containing one dies with
   * "__name is not defined" — Playwright serialises the source, never the module
   * scope around it. Shimming it as identity makes the evaluated code run as
   * written. Passed as a string so it cannot itself be rewritten.
   */
  private async _ensurePageHelpers(page: Page): Promise<void> {
    await page
      .evaluate('window.__name = window.__name || function (fn) { return fn; }')
      .catch(() => {});
    await page.evaluate(installUniqueSelectorHelper).catch(() => {});
  }

  /**
   * Full DOM scan fallback — evaluates interactive elements and scores them using the advanced logic in Node.js
   */
  private async _fullDomScan(page: Page, ctx: ScoringContext): Promise<DiscoveryMatch | null> {
    try {
      await this._ensurePageHelpers(page);
      const elementList = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll(
          'input, button, select, textarea, a, [role="button"], [role="checkbox"], [role="textbox"], [role="link"], [contenteditable="true"]'
        )) as HTMLElement[];

        const getSelector = (el: Element): string => {
          if (el.id) return `#${el.id}`;
          const name = el.getAttribute('name');
          if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) return `${el.tagName.toLowerCase()}[placeholder="${placeholder}"]`;
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
          
          let current: Element | null = el;
          const parts: string[] = [];
          while (current && current !== document.body) {
            let selector = current.tagName.toLowerCase();
            if (current.id) { parts.unshift(`#${current.id}`); break; }
            const siblings = Array.from(current.parentElement?.children || []).filter(s => s.tagName === current!.tagName);
            if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            parts.unshift(selector);
            current = current.parentElement;
          }
          return parts.join(' > ');
        };

        return elements.map((el) => {
          const style = window.getComputedStyle(el);
          const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && !el.hasAttribute('hidden');
          const rect = el.getBoundingClientRect();
          const hasSize = rect.width > 0 && rect.height > 0;

          const tag = el.tagName.toLowerCase();

          // Label text
          let labelText = '';
          if (el.id) {
            const labels = Array.from(document.querySelectorAll(`label[for="${el.id}"]`));
            labelText = labels.map(l => l.textContent || '').join(' ').trim();
          }
          if (!labelText) {
            let p: Element | null = el.parentElement;
            while (p) {
              if (p.tagName.toLowerCase() === 'label') {
                labelText = (p.textContent || '').trim();
                break;
              }
              p = p.parentElement;
            }
          }

          // Help text
          let helpText = '';
          const parent = el.closest('div, fieldset, section') || el.parentElement;
          if (parent) {
            const helpElements = parent.querySelectorAll('small, .help-text, .hint, [role="tooltip"]');
            helpText = Array.from(helpElements)
              .map(el => (el.textContent || '').trim())
              .filter(t => t.length > 0)
              .join(' ');
          }

          // Error text
          let errorText = '';
          if (parent) {
            const errorElements = parent.querySelectorAll('.error, .error-message, [role="alert"], .invalid-feedback');
            errorText = Array.from(errorElements)
              .map(el => (el.textContent || '').trim())
              .filter(t => t.length > 0)
              .join(' ');
          }

          // Sibling text
          const nearbyText: string[] = [];
          if (el.parentElement) {
            let prev = el.previousElementSibling;
            let next = el.nextElementSibling;
            for (let i = 0; i < 2; i++) {
              if (prev) {
                const text = (prev.textContent || '').trim().substring(0, 50);
                if (text) nearbyText.push(text);
                prev = prev.previousElementSibling;
              }
              if (next) {
                const text = (next.textContent || '').trim().substring(0, 50);
                if (text) nearbyText.push(text);
                next = next.nextElementSibling;
              }
            }
          }

          // Position in form
          let position = 0;
          let totalFieldsInForm = 0;
          const form = el.closest('form');
          if (form) {
            const allFields = Array.from(form.querySelectorAll('input, select, textarea, button, [role="button"]'));
            position = allFields.indexOf(el);
            totalFieldsInForm = allFields.length;
          }

          const rawAttrs: Record<string, string> = {};
          Array.from(el.attributes).forEach(a => { rawAttrs[a.name] = a.value; });

          return {
            selector: getSelector(el),
            tagName: tag,
            attrs: {
              id: el.id || '',
              name: el.getAttribute('name') || '',
              type: el.getAttribute('type') || '',
              placeholder: el.getAttribute('placeholder') || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              ariaDescribedby: el.getAttribute('aria-describedby') || '',
              labelText,
              elementText: ((el as HTMLElement).innerText || el.textContent || el.getAttribute('value') || '').trim().substring(0, 120),
              classNames: Array.from(el.classList).join(' '),
              tagName: tag,
              role: el.getAttribute('role') || tag,
              title: el.getAttribute('title') || '',
              dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-test') || '',
              value: el.getAttribute('value') || '',
              autocomplete: el.getAttribute('autocomplete') || '',
              helpText,
              errorText,
              nearbyText,
              position,
              totalFieldsInForm,
              isVisible: isVisible && hasSize
            },
            rawAttrs
          };
        });
      });

      let bestMatch: DiscoveryMatch | null = null;
      let bestScore = -1;

      for (const item of elementList) {
        if (!item.attrs.isVisible) continue;
        const { score, winningSignal } = scoreElement(item.attrs, ctx);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = {
            selector: item.selector,
            score,
            strategy: winningSignal as any,
            tagName: item.tagName,
            attributes: item.rawAttrs,
          };
        }
      }

      return bestMatch;
    } catch (e) {
      dlog('Error during full DOM scan:', e);
      return null;
    }
  }

  /**
   * Extract element attributes for scoring
   */
  private async _extractAttributes(page: Page, selector: string): Promise<ElementAttributes> {
    try {
      return await page.locator(selector).first().evaluate((el: Element) => {
        const tag = el.tagName.toLowerCase();

        // Collect label text via for= and wrapping label
        let labelText = '';
        if ((el as HTMLElement).id) {
          const labels = Array.from(document.querySelectorAll(`label[for="${(el as HTMLElement).id}"]`));
          labelText = labels.map(l => l.textContent || '').join(' ').trim();
        }
        if (!labelText) {
          let p: Element | null = el.parentElement;
          while (p) {
            if (p.tagName.toLowerCase() === 'label') {
              labelText = (p.textContent || '').trim();
              break;
            }
            p = p.parentElement;
          }
        }

        // Help text
        let helpText = '';
        const parent = el.closest('div, fieldset, section') || el.parentElement;
        if (parent) {
          const helpElements = parent.querySelectorAll('small, .help-text, .hint, [role="tooltip"]');
          helpText = Array.from(helpElements)
            .map(el => (el.textContent || '').trim())
            .filter(t => t.length > 0)
            .join(' ');
        }

        // Error text
        let errorText = '';
        if (parent) {
          const errorElements = parent.querySelectorAll('.error, .error-message, [role="alert"], .invalid-feedback');
          errorText = Array.from(errorElements)
            .map(el => (el.textContent || '').trim())
            .filter(t => t.length > 0)
            .join(' ');
        }

        // Sibling text
        const nearbyText: string[] = [];
        if (el.parentElement) {
          let prev = el.previousElementSibling;
          let next = el.nextElementSibling;
          for (let i = 0; i < 2; i++) {
            if (prev) {
              const text = (prev.textContent || '').trim().substring(0, 50);
              if (text) nearbyText.push(text);
              prev = prev.previousElementSibling;
            }
            if (next) {
              const text = (next.textContent || '').trim().substring(0, 50);
              if (text) nearbyText.push(text);
              next = next.nextElementSibling;
            }
          }
        }

        // Position in form
        let position = 0;
        let totalFieldsInForm = 0;
        const form = el.closest('form');
        if (form) {
          const allFields = Array.from(form.querySelectorAll('input, select, textarea, button, [role="button"]'));
          position = allFields.indexOf(el);
          totalFieldsInForm = allFields.length;
        }

        const style = window.getComputedStyle(el);
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && !el.hasAttribute('hidden');
        const rect = el.getBoundingClientRect();
        const hasSize = rect.width > 0 && rect.height > 0;

        return {
          id: (el as HTMLElement).id || '',
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || '',
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          ariaDescribedby: el.getAttribute('aria-describedby') || '',
          labelText,
          elementText: (el.textContent || el.getAttribute('value') || '').trim().substring(0, 80),
          classNames: Array.from(el.classList).join(' '),
          tagName: tag,
          role: el.getAttribute('role') || tag,
          title: el.getAttribute('title') || '',
          dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-test') || '',
          value: el.getAttribute('value') || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          helpText,
          errorText,
          nearbyText,
          position,
          totalFieldsInForm,
          isVisible: isVisible && hasSize,
        };
      });
    } catch {
      return {
        id: '', name: '', type: '', placeholder: '', ariaLabel: '', ariaDescribedby: '',
        labelText: '', elementText: '', classNames: '', tagName: 'unknown', role: '',
        title: '', dataTestId: '', value: '', autocomplete: '',
        helpText: '', errorText: '', nearbyText: [], position: 0, totalFieldsInForm: 0, isVisible: false
      };
    }
  }

  private _isInputIntent(target: string): boolean {
    const inputWords = ['email', 'password', 'username', 'user', 'name', 'phone', 'address', 'search', 'message', 'comment', 'text', 'input', 'field', 'zip', 'code', 'number'];
    return inputWords.some(w => target.includes(w));
  }

  private _isButtonIntent(target: string): boolean {
    const buttonWords = ['login', 'signin', 'submit', 'continue', 'next', 'save', 'cancel', 'close', 'ok', 'confirm', 'register', 'signup', 'logout', 'send', 'apply', 'button', 'click'];
    return buttonWords.some(w => target.includes(w));
  }

  /**
   * scanInteractiveElements — Returns a map of all visible interactive elements
   */
  public async scanInteractiveElements(page: Page): Promise<Record<string, DiscoveryMatch>> {
    return await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll(
        'input, button, select, textarea, a, [role="button"], [role="checkbox"], [role="textbox"]'
      ));

      const map: Record<string, any> = {};

      const getSelector = (el: Element): string => {
        if (el.id) return `#${el.id}`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return `input[placeholder="${placeholder}"]`;
        return el.tagName.toLowerCase();
      };

      elements.forEach((el, index) => {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const tag = el.tagName.toLowerCase();
        const id = el.id || '';
        const name = el.getAttribute('name') || '';
        const placeholder = el.getAttribute('placeholder') || '';
        const ariaLabel = el.getAttribute('aria-label') || '';
        const text = (el.textContent || '').trim().substring(0, 30);

        const key = ariaLabel || name || placeholder || id || text || `${tag}-${index}`;

        const attributes: Record<string, string> = {};
        Array.from(el.attributes).forEach((attr) => { attributes[attr.name] = attr.value; });

        map[key] = {
          selector: getSelector(el),
          score: 80,
          strategy: 'scan',
          tagName: tag,
          attributes,
        };
      });

      return map;
    });
  }
}

// ---------------------------------------------------------------------------
// Visual scan — page-side collection + Node-side scoring
//
// Everything below runs against geometry rather than markup, so it can identify
// controls whose meaning is purely visual (initials avatars, icon-only buttons,
// unlabelled menu triggers) that the attribute strategies cannot see.
// ---------------------------------------------------------------------------

interface VisualCandidate {
  selector: string;
  tagName: string;
  text: string;
  ariaLabel: string;
  title: string;
  alt: string;
  testId: string;
  className: string;
  role: string;
  hasPopup: boolean;
  inHeader: boolean;
  /** Small, square and heavily rounded — the shape of an avatar / icon button. */
  circular: boolean;
  area: number;
  /** Centre of the element as a 0–1 fraction of the viewport. */
  cx: number;
  cy: number;
  attrs: Record<string, string>;
}

/**
 * Defines `window.__autoqaUniqueSelector(el)` — the shortest selector that
 * resolves back to exactly that element, falling back to a structural path.
 * Runs in the browser; safe to call repeatedly.
 */
function installUniqueSelectorHelper(): void {
  const w = window as AutoQAWindow;
  if (w.__autoqaUniqueSelector) return;

  const quote = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const isSimpleToken = (v: string) => /^[A-Za-z][\w-]*$/.test(v);

  const structuralPath = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      if (cur.id && isSimpleToken(cur.id)) {
        parts.unshift('#' + cur.id);
        break;
      }
      let seg = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const twins = Array.from(parent.children).filter((s) => s.tagName === cur!.tagName);
        if (twins.length > 1) seg += `:nth-of-type(${twins.indexOf(cur) + 1})`;
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  };

  w.__autoqaUniqueSelector = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const tries: string[] = [];

    if (el.id && isSimpleToken(el.id)) tries.push(`#${el.id}`);
    for (const attr of ['data-testid', 'data-test', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) tries.push(`[${attr}="${quote(v)}"]`);
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) tries.push(`${tag}[aria-label="${quote(ariaLabel)}"]`);
    const name = el.getAttribute('name');
    if (name) tries.push(`${tag}[name="${quote(name)}"]`);

    // Utility-framework class soup produces brittle selectors, so only
    // hand-written-looking class names are considered.
    const classes = Array.from(el.classList).filter((c) => isSimpleToken(c) && c.length > 2 && c.length < 40);
    if (classes.length > 0) tries.push(tag + '.' + classes.slice(0, 3).join('.'));

    for (const sel of tries) {
      try {
        if (document.querySelector(sel) === el) return sel;
      } catch {
        /* invalid selector — try the next form */
      }
    }
    return structuralPath(el);
  };
}

/** Page-side: gathers every visible, plausibly-clickable element with its geometry. */
function collectVisualCandidates(): VisualCandidate[] {
  const uniqueSelector = (window as AutoQAWindow).__autoqaUniqueSelector as (el: Element) => string;
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;

  const INTERACTIVE = [
    'button', 'a[href]', '[role="button"]', '[role="menuitem"]', '[role="link"]', '[role="img"]',
    'input[type="button"]', 'input[type="submit"]', 'img', '[onclick]', '[tabindex]',
    '[aria-haspopup]', '[data-testid]', '[data-test]', '[data-cy]',
  ].join(', ');

  const pool = new Set<Element>(Array.from(document.querySelectorAll(INTERACTIVE)));

  // Icon triggers are frequently plain divs or spans; `cursor: pointer` is the
  // only thing marking them clickable. Bounded so a huge DOM cannot stall the scan.
  for (const el of Array.from(document.querySelectorAll('div, span')).slice(0, 3000)) {
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.width > 260 || r.height > 260) continue;
    if (window.getComputedStyle(el).cursor !== 'pointer') continue;
    pool.add(el);
  }

  const HEADER_SEL =
    'header, nav, [role="banner"], [role="navigation"], [class*="header" i], [class*="navbar" i], [class*="topbar" i], [class*="appbar" i]';

  const out: VisualCandidate[] = [];
  for (const el of pool) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue; // scrolled out of view

    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;

    const radius = st.borderRadius || '0px';
    const radiusPct = radius.includes('%')
      ? parseFloat(radius)
      : (parseFloat(radius) || 0) / Math.max(r.width, 1) * 100;

    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;

    out.push({
      selector: uniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      text: ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      ariaLabel: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      alt: el.getAttribute('alt') || '',
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '',
      className: typeof el.className === 'string' ? el.className : '',
      role: el.getAttribute('role') || '',
      hasPopup: el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded'),
      inHeader: !!el.closest(HEADER_SEL),
      circular: Math.abs(r.width - r.height) <= 6 && r.width >= 18 && r.width <= 96 && radiusPct >= 25,
      area: Math.round(r.width * r.height),
      cx: (r.left + r.width / 2) / vw,
      cy: (r.top + r.height / 2) / vh,
      attrs,
    });
  }

  return out;
}

const PROFILE_MARKERS = ['avatar', 'profile', 'account', 'user-menu', 'usermenu', 'user menu', 'userpic', 'my account'];

/** Node-side: combines identity evidence (text/labels) with visual evidence (shape/position). */
function scoreVisualCandidate(
  c: VisualCandidate,
  opts: { targetText: string; initials: string | null; isProfile: boolean; hint: PositionHint | null },
): { score: number; signal: string } {
  const { targetText, initials, isProfile, hint } = opts;
  const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  const text = norm(c.text);
  const labelBag = norm([c.ariaLabel, c.title, c.alt, c.testId, c.className, c.role].join(' '));

  let score = 0;
  let signal = 'visual:geometry';
  // Geometry alone never justifies a click — something must also identify the
  // element as the one the step named.
  let identified = false;

  if (initials) {
    const want = initials.toLowerCase();
    if (text === want) {
      score += 55; signal = 'visual:initials-text'; identified = true;
    } else if (norm(c.ariaLabel) === want || norm(c.title) === want || norm(c.alt) === want) {
      score += 45; signal = 'visual:initials-label'; identified = true;
    } else if (want.length >= 2 && labelBag.includes(want)) {
      score += 15; identified = true;
    } else if (text && text.length <= 4) {
      // An avatar showing somebody else's initials is positive evidence of the
      // wrong element, not merely a missing match: on a page full of member
      // avatars, "click AU" must never settle for the JR one because it happens
      // to sit where the step said to look.
      return { score: 0, signal: 'visual:initials-mismatch' };
    }
  }

  if (targetText && targetText !== (initials || '').toLowerCase()) {
    if (text === targetText) {
      score += 50; signal = 'visual:text'; identified = true;
    } else if (text && text.includes(targetText)) {
      score += 22; identified = true;
    }
    if (labelBag.includes(targetText)) {
      score += 30; identified = true;
      if (signal === 'visual:geometry') signal = 'visual:label';
    }
  }

  const profileish = PROFILE_MARKERS.some((m) => labelBag.includes(m));
  if (profileish) {
    score += isProfile ? 45 : 22;
    identified = true;
    if (isProfile && signal === 'visual:geometry') signal = 'visual:profile';
  } else if (isProfile && c.circular && c.inHeader) {
    // "Click the profile icon" on an app that labels nothing: a small round
    // control in the site chrome is the conventional place for it.
    score += 25;
    identified = true;
    signal = 'visual:profile-shape';
  }

  if (c.circular) score += 20;
  if (c.inHeader) score += 10;
  if (c.hasPopup) score += 8;
  if (c.area < 6000) score += 5;

  if (hint) {
    const band = (v: number, near: number, mid: number, far: number, invert: boolean) => {
      const x = invert ? 1 - v : v;
      if (x >= near) return 30;
      if (x >= mid) return 12;
      if (x <= far) return -45;
      return 0;
    };
    if (hint.vertical === 'top') score += band(c.cy, 0.75, 0.55, 0.4, true);
    if (hint.vertical === 'bottom') score += band(c.cy, 0.75, 0.55, 0.4, false);
    if (hint.horizontal === 'right') score += band(c.cx, 0.8, 0.6, 0.4, false);
    if (hint.horizontal === 'left') score += band(c.cx, 0.8, 0.6, 0.4, true);
    if (signal === 'visual:geometry') signal = 'visual:position';
  }

  if (!identified) score = Math.min(score, 30);
  return { score: Math.max(0, Math.min(100, score)), signal };
}
