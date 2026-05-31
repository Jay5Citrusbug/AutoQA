import { Page } from '@playwright/test';
import { DiscoveryMatch } from '@/types/execution';

export interface IElementDiscoveryEngine {
  discover(page: Page, fieldName: string): Promise<DiscoveryMatch>;
  scanInteractiveElements(page: Page): Promise<Record<string, DiscoveryMatch>>;
}

export class ElementDiscoveryEngine implements IElementDiscoveryEngine {
  /**
   * Scrapes the active page DOM and scores candidate interactive elements against the target field name
   */
  public async discover(page: Page, fieldName: string): Promise<DiscoveryMatch> {
    const target = fieldName.toLowerCase().replace(/[\s_\-]/g, '');

    // Execute in page context to grab all candidate interactive elements and evaluate their scores
    const match = await page.evaluate((targetText) => {
      // Find all potentially interactive elements
      const elements = Array.from(document.querySelectorAll(
        'input, button, select, textarea, a, [role="button"], [role="checkbox"], [role="textbox"], [role="link"], [contenteditable="true"]'
      ));

      let bestMatch: {
        selector: string;
        score: number;
        strategy: 'role' | 'label' | 'placeholder' | 'name' | 'id' | 'css' | 'fallback';
        tagName: string;
        attributes: Record<string, string>;
      } | null = null;

      // Helper to generate a unique CSS selector for an element
      const getSelector = (el: Element): string => {
        if (el.id) {
          return `#${el.id}`;
        }
        
        // Check for specific unique attributes
        const nameAttr = el.getAttribute('name');
        if (nameAttr) {
          return `${el.tagName.toLowerCase()}[name="${nameAttr}"]`;
        }

        const placeholderAttr = el.getAttribute('placeholder');
        if (placeholderAttr) {
          return `${el.tagName.toLowerCase()}[placeholder="${placeholderAttr}"]`;
        }

        const roleAttr = el.getAttribute('role');
        const typeAttr = el.getAttribute('type');
        
        // Generate path-based fallback selector
        const path: string[] = [];
        let current: Element | null = el;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          let selector = current.tagName.toLowerCase();
          if (current.id) {
            selector += `#${current.id}`;
            path.unshift(selector);
            break;
          } else {
            let sibCount = 0;
            let sibIndex = 0;
            let sibling = current.previousElementSibling;
            while (sibling) {
              if (sibling.tagName === current.tagName) sibIndex++;
              sibling = sibling.previousElementSibling;
            }
            sibling = current.nextElementSibling;
            while (sibling) {
              if (sibling.tagName === current.tagName) sibCount++;
              sibling = sibling.nextElementSibling;
            }
            if (sibIndex > 0 || sibCount > 0) {
              selector += `:nth-of-type(${sibIndex + 1})`;
            }
          }
          path.unshift(selector);
          current = current.parentElement;
        }
        return path.join(' > ');
      };

      for (const el of elements) {
        // Skip hidden or disabled elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.hasAttribute('disabled')) {
          continue;
        }

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          continue; // not visible
        }

        let score = 0;
        let strategy: 'role' | 'label' | 'placeholder' | 'name' | 'id' | 'css' | 'fallback' = 'fallback';

        // 1. Check ID
        const id = (el.id || '').toLowerCase();
        const cleanId = id.replace(/[\s_\-]/g, '');
        if (cleanId === targetText) {
          score = 90;
          strategy = 'id';
        } else if (cleanId.includes(targetText)) {
          score = 75;
          strategy = 'id';
        }

        // 2. Check Name Attribute
        const name = (el.getAttribute('name') || '').toLowerCase();
        const cleanName = name.replace(/[\s_\-]/g, '');
        if (score < 85 && cleanName === targetText) {
          score = 85;
          strategy = 'name';
        } else if (score < 70 && cleanName.includes(targetText)) {
          score = 70;
          strategy = 'name';
        }

        // 3. Check Placeholder
        const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
        const cleanPlaceholder = placeholder.replace(/[\s_\-]/g, '');
        if (score < 80 && cleanPlaceholder === targetText) {
          score = 80;
          strategy = 'placeholder';
        } else if (score < 65 && cleanPlaceholder.includes(targetText)) {
          score = 65;
          strategy = 'placeholder';
        }

        // 4. Check Aria Role, Label, Description
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const cleanAriaLabel = ariaLabel.replace(/[\s_\-]/g, '');
        if (score < 95 && cleanAriaLabel === targetText) {
          score = 95;
          strategy = 'role';
        } else if (score < 75 && cleanAriaLabel.includes(targetText)) {
          score = 75;
          strategy = 'role';
        }

        // 5. Associated Label Text
        let labelText = '';
        if (el.id) {
          const labels = document.querySelectorAll(`label[for="${el.id}"]`);
          if (labels.length > 0) {
            labelText = Array.from(labels).map(l => l.textContent || '').join(' ').toLowerCase();
          }
        }
        // Fallback: check if element is wrapped in a label
        let parent = el.parentElement;
        while (parent) {
          if (parent.tagName.toLowerCase() === 'label') {
            labelText += ' ' + (parent.textContent || '').toLowerCase();
          }
          parent = parent.parentElement;
        }

        const cleanLabelText = labelText.replace(/[\s_\-]/g, '');
        if (cleanLabelText) {
          if (score < 95 && cleanLabelText === targetText) {
            score = 95;
            strategy = 'label';
          } else if (score < 80 && cleanLabelText.includes(targetText)) {
            score = 80;
            strategy = 'label';
          }
        }

        // 6. Element Text / Value (especially for buttons and links)
        const elementText = (el.textContent || el.getAttribute('value') || '').toLowerCase().trim();
        const cleanElementText = elementText.replace(/[\s_\-]/g, '');
        if (cleanElementText) {
          if (score < 90 && cleanElementText === targetText) {
            score = 90;
            strategy = 'label';
          } else if (score < 70 && cleanElementText.includes(targetText)) {
            score = 70;
            strategy = 'label';
          }
        }

        // 7. Check class names / CSS class scoring
        const classNames = Array.from(el.classList).join(' ').toLowerCase();
        const cleanClasses = classNames.replace(/[\s_\-]/g, '');
        if (score < 50 && cleanClasses.includes(targetText)) {
          score = 50;
          strategy = 'css';
        }

        // Apply visual context heuristic (e.g. prioritize inputs for "email/password" and buttons for "login/submit")
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const isInputLike = tag === 'input' || tag === 'textarea' || el.getAttribute('role') === 'textbox';
        const isButtonLike = tag === 'button' || tag === 'a' || type === 'submit' || type === 'button' || el.getAttribute('role') === 'button';

        if (score > 0) {
          // Boost score if match context aligns with target semantics
          if (isInputLike && (targetText.includes('email') || targetText.includes('user') || targetText.includes('pass') || targetText.includes('text') || targetText.includes('phone'))) {
            score += 5;
          }
          if (isButtonLike && (targetText.includes('click') || targetText.includes('submit') || targetText.includes('login') || targetText.includes('sign') || targetText.includes('ok') || targetText.includes('send'))) {
            score += 5;
          }
          
          // Cap score at 100
          score = Math.min(score, 100);

          if (!bestMatch || score > bestMatch.score) {
            // Read basic attributes for metadata logging
            const attributes: Record<string, string> = {};
            Array.from(el.attributes).forEach((attr) => {
              attributes[attr.name] = attr.value;
            });

            bestMatch = {
              selector: getSelector(el),
              score,
              strategy,
              tagName: tag,
              attributes,
            };
          }
        }
      }

      return bestMatch;
    }, target);

    if (match) {
      return match;
    }

    // Default Fallback selector if nothing found
    const hasSpacesOrSpecial = /[^a-zA-Z0-9_\-]/.test(fieldName);
    const safeSelector = hasSpacesOrSpecial 
      ? `[name="${fieldName}"], [placeholder="${fieldName}"], input[type="text"]`
      : `[name="${fieldName}"], #${fieldName}, .${fieldName}, input[type="text"]`;

    return {
      selector: safeSelector,
      score: 10,
      strategy: 'fallback',
      tagName: 'input',
      attributes: {},
    };
  }

  /**
   * Scans the active page and extracts metadata map of all interactive components
   */
  public async scanInteractiveElements(page: Page): Promise<Record<string, DiscoveryMatch>> {
    // Collect layout element mapping
    return await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll(
        'input, button, select, textarea, a, [role="button"], [role="checkbox"], [role="textbox"]'
      ));

      const map: Record<string, DiscoveryMatch> = {};

      const getSelector = (el: Element): string => {
        if (el.id) return `#${el.id}`;
        const name = el.getAttribute('name');
        if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
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
        Array.from(el.attributes).forEach((attr) => {
          attributes[attr.name] = attr.value;
        });

        map[key] = {
          selector: getSelector(el),
          score: 80,
          strategy: 'fallback',
          tagName: tag,
          attributes
        };
      });

      return map;
    });
  }
}
