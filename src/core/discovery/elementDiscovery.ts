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
  similarityFallback,
  StrategyCandidate,
} from './strategies';

const DEBUG = process.env.AUTOQA_DISCOVERY_DEBUG === '1';

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
];

export interface IElementDiscoveryEngine {
  discover(page: Page, fieldName: string): Promise<DiscoveryMatch>;
  scanInteractiveElements(page: Page): Promise<Record<string, DiscoveryMatch>>;
}

export class ElementDiscoveryEngine implements IElementDiscoveryEngine {
  /**
   * discover — Find the best-matching DOM element for the given field name.
   */
  public async discover(page: Page, fieldName: string): Promise<DiscoveryMatch> {
    const rawTarget = fieldName.trim();
    const targetText = rawTarget.toLowerCase().replace(/[\s_\-]+/g, ' ').trim();
    const ctx: ScoringContext = { targetText, rawTarget };

    dlog(`Discovering element for: "${rawTarget}"`);

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

    // Probe each candidate on the live page and score the winners
    let bestMatch: DiscoveryMatch | null = null;
    let bestScore = -1;

    for (const candidate of uniqueCandidates) {
      dlog(`  Trying: ${candidate.selector} (${candidate.reason})`);
      try {
        const locator = page.locator(candidate.selector).first();
        const isVisible = await locator.isVisible({ timeout: 800 }).catch(() => false);

        if (!isVisible) {
          dlog(`    → Not visible, skip`);
          continue;
        }

        // Extract element attributes for scoring
        const attrs = await this._extractAttributes(page, candidate.selector);
        const { score, winningSignal } = scoreElement(attrs, ctx);

        dlog(`    → Visible! Score: ${score} (signal: ${winningSignal})`);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = {
            selector: candidate.selector,
            score,
            strategy: winningSignal as any,
            tagName: attrs.tagName,
            attributes: {
              id: attrs.id,
              name: attrs.name,
              type: attrs.type,
              placeholder: attrs.placeholder,
              'aria-label': attrs.ariaLabel,
              class: attrs.classNames,
            },
          };
          dlog(`    → New best: score=${score}, signal=${winningSignal}`);
        }
      } catch {
        // Selector invalid or timed out — skip
        dlog(`    → Error resolving selector, skip`);
      }
    }

    if (bestMatch && bestMatch.score >= 50) {
      dlog(`Final winner: "${bestMatch.selector}" (score ${bestMatch.score}, signal ${bestMatch.strategy})`);
      return bestMatch;
    }

    // Last-resort fallback — query all inputs and score via DOM evaluation
    dlog('No strategy hit with confidence >= 50 — falling back to full DOM scan');
    const domFallback = await this._fullDomScan(page, ctx);
    if (domFallback && domFallback.score > (bestMatch?.score || 0)) {
      dlog(`DOM scan winner: "${domFallback.selector}" (score ${domFallback.score})`);
      return domFallback;
    }

    if (bestMatch) {
      dlog(`Returning best available strategy candidate: "${bestMatch.selector}" (score ${bestMatch.score})`);
      return bestMatch;
    }

    // Hard fallback — return a generic selector with low confidence
    const genericSelector = isButtonHint
      ? `button:has-text("${rawTarget}"), input[type="submit"]`
      : isInputHint
        ? `input:not([type="hidden"])` 
        : `[name="${rawTarget}"], #${rawTarget}, [placeholder*="${rawTarget}" i]`;

    console.warn(`[ElementDiscovery] No match found for "${rawTarget}". Returning generic fallback: ${genericSelector}`);

    return {
      selector: genericSelector,
      score: 5,
      strategy: 'fallback',
      tagName: isButtonHint ? 'button' : 'input',
      attributes: {},
    };
  }

  /**
   * Full DOM scan fallback — evaluates interactive elements and scores them using the advanced logic in Node.js
   */
  private async _fullDomScan(page: Page, ctx: ScoringContext): Promise<DiscoveryMatch | null> {
    try {
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
