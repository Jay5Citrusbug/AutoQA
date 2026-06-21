/**
 * strategies.ts — Element Matching Strategies
 *
 * Each strategy is a self-contained function that receives the page and the
 * target query and returns an ordered list of Playwright-compatible CSS/text
 * selectors to TRY.  The runner attempts each selector in order and stops at
 * the first one that resolves to a visible element.
 *
 * STRATEGY PRIORITY ORDER (enforced by elementFinder.ts):
 *  1. semanticTypeStrategy   — input[type=email/password/…] inference
 *  2. ariaRoleStrategy       — getByRole() with accessible name
 *  3. labelStrategy          — label[for=…] / input inside <label>
 *  4. placeholderStrategy    — input[placeholder*=…]
 *  5. nameStrategy           — [name*=…]
 *  6. idStrategy             — #id or [id*=…]
 *  7. dataTestIdStrategy     — [data-testid*=…]
 *  8. textStrategy           — button/link with matching text
 *  9. autocompleteStrategy   — [autocomplete=…]
 * 10. aliasStrategy          — semantic aliases (email → username etc.)
 * 11. similarityFallback     — broad attribute wildcard matches
 *
 * HOW TO ADD A NEW STRATEGY:
 *   1. Create a new function following the MatchStrategy signature.
 *   2. Add it to the STRATEGIES array in elementFinder.ts in the desired priority position.
 *   3. The system will automatically try it during element resolution.
 */

import { SEMANTIC_ALIASES, TYPE_INFERENCE } from './scoring';

export interface StrategyCandidate {
  selector: string;
  /** Human-readable explanation of why this selector was generated */
  reason: string;
  /** Estimated confidence before live DOM testing (0–100) */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Helper: generate multiple attribute variations for fuzzy matching
// ---------------------------------------------------------------------------
function variations(target: string): string[] {
  const t = target.toLowerCase().trim();
  const results = new Set<string>([t]);
  results.add(t.replace(/[\s_\-]/g, ''));     // strip spaces
  results.add(t.replace(/[\s\-]/g, '_'));     // use underscores
  results.add(t.replace(/[\s_]/g, '-'));      // use hyphens
  return Array.from(results);
}

// ---------------------------------------------------------------------------
// STRATEGY 1: Semantic Type Inference
// Maps user words → input[type=…] selectors
// ---------------------------------------------------------------------------
export function semanticTypeStrategy(target: string): StrategyCandidate[] {
  const t = target.toLowerCase().trim();
  const candidates: StrategyCandidate[] = [];

  for (const [keyword, inputType] of Object.entries(TYPE_INFERENCE)) {
    if (t.includes(keyword) || keyword.includes(t)) {
      candidates.push({
        selector: `input[type="${inputType}"]`,
        reason: `Type inference: "${t}" → input[type="${inputType}"]`,
        confidence: 70,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 2: Aria Role Strategy
// Generates Playwright aria role selectors
// ---------------------------------------------------------------------------
export function ariaRoleStrategy(target: string): StrategyCandidate[] {
  const t = target.toLowerCase().trim();
  const candidates: StrategyCandidate[] = [];

  // Buttons and links — match by text
  const buttonKeywords = ['login', 'signin', 'sign in', 'sign-in', 'submit', 'continue', 'next', 'save', 'cancel', 'close', 'ok', 'confirm', 'register', 'signup', 'logout', 'send'];
  if (buttonKeywords.some(k => t.includes(k) || k.includes(t))) {
    candidates.push({
      selector: `button:has-text("${target}")`,
      reason: `Button text match for "${target}"`,
      confidence: 85,
    });
    candidates.push({
      selector: `[role="button"]:has-text("${target}")`,
      reason: `Role=button text match for "${target}"`,
      confidence: 80,
    });
    candidates.push({
      selector: `input[type="submit"]`,
      reason: `Submit input fallback for "${target}"`,
      confidence: 65,
    });
  }

  // Input fields by aria role
  const inputKeywords = ['email', 'password', 'username', 'phone', 'name', 'address', 'search', 'message', 'comment', 'field', 'input', 'text'];
  if (inputKeywords.some(k => t.includes(k) || k.includes(t))) {
    candidates.push({
      selector: `[role="textbox"]`,
      reason: `Role=textbox for "${target}"`,
      confidence: 55,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 3: Label Association Strategy
// Finds inputs associated with <label> elements matching the target
// ---------------------------------------------------------------------------
export function labelStrategy(target: string): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  for (const v of variations(target)) {
    // Playwright :has-text can find label elements
    candidates.push({
      selector: `label:has-text("${target}") input`,
      reason: `Label contains "${target}" → child input`,
      confidence: 82,
    });
    candidates.push({
      selector: `label:has-text("${target}") textarea`,
      reason: `Label contains "${target}" → child textarea`,
      confidence: 80,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 4: Placeholder Strategy
// Targets input[placeholder*=…] (case-insensitive via Playwright)
// ---------------------------------------------------------------------------
export function placeholderStrategy(target: string): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  for (const v of variations(target)) {
    candidates.push({
      selector: `[placeholder*="${v}" i]`,
      reason: `Placeholder contains "${v}"`,
      confidence: 78,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 5: Name Attribute Strategy
// ---------------------------------------------------------------------------
export function nameStrategy(target: string): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  for (const v of variations(target)) {
    candidates.push({
      selector: `[name="${v}"]`,
      reason: `name="${v}" exact match`,
      confidence: 85,
    });
    candidates.push({
      selector: `[name*="${v}" i]`,
      reason: `name contains "${v}"`,
      confidence: 68,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 6: ID Strategy
// ---------------------------------------------------------------------------
export function idStrategy(target: string): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  for (const v of variations(target)) {
    candidates.push({
      selector: `#${v}`,
      reason: `id="${v}" exact`,
      confidence: 90,
    });
    candidates.push({
      selector: `[id*="${v}" i]`,
      reason: `id contains "${v}"`,
      confidence: 70,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 7: Data Test ID Strategy
// ---------------------------------------------------------------------------
export function dataTestIdStrategy(target: string): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  for (const v of variations(target)) {
    candidates.push({
      selector: `[data-testid="${v}"]`,
      reason: `data-testid="${v}"`,
      confidence: 86,
    });
    candidates.push({
      selector: `[data-testid*="${v}" i]`,
      reason: `data-testid contains "${v}"`,
      confidence: 70,
    });
    candidates.push({
      selector: `[data-cy="${v}"]`,
      reason: `data-cy="${v}" (Cypress convention)`,
      confidence: 80,
    });
    candidates.push({
      selector: `[data-test="${v}"]`,
      reason: `data-test="${v}"`,
      confidence: 80,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 8: Text Content Strategy (for buttons, links, any element)
// ---------------------------------------------------------------------------
export function textStrategy(target: string): StrategyCandidate[] {
  const candidates: StrategyCandidate[] = [];
  candidates.push({
    selector: `text="${target}"`,
    reason: `Exact text content "${target}"`,
    confidence: 88,
  });
  candidates.push({
    selector: `text=${target}`,
    reason: `Playwright text locator for "${target}"`,
    confidence: 85,
  });
  candidates.push({
    selector: `button:has-text("${target}")`,
    reason: `Button has text "${target}"`,
    confidence: 85,
  });
  candidates.push({
    selector: `a:has-text("${target}")`,
    reason: `Link has text "${target}"`,
    confidence: 80,
  });
  candidates.push({
    selector: `:has-text("${target}")`,
    reason: `Any element has text "${target}"`,
    confidence: 60,
  });
  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 9: Autocomplete Attribute Strategy
// HTML autocomplete values: email, username, current-password, new-password, name, tel etc.
// ---------------------------------------------------------------------------
export function autocompleteStrategy(target: string): StrategyCandidate[] {
  const t = target.toLowerCase().trim();
  const candidates: StrategyCandidate[] = [];

  const autocompleteMap: Record<string, string[]> = {
    email:    ['email'],
    username: ['username', 'email'],
    password: ['current-password', 'new-password'],
    name:     ['name', 'given-name', 'family-name'],
    phone:    ['tel'],
    address:  ['street-address'],
    city:     ['address-level2'],
    zip:      ['postal-code'],
    country:  ['country', 'country-name'],
  };

  for (const [keyword, acValues] of Object.entries(autocompleteMap)) {
    if (t.includes(keyword) || keyword.includes(t)) {
      for (const ac of acValues) {
        candidates.push({
          selector: `[autocomplete="${ac}"]`,
          reason: `autocomplete="${ac}" for "${target}"`,
          confidence: 72,
        });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 10: Semantic Alias Strategy
// Tries known alias variations for common field names
// ---------------------------------------------------------------------------
export function aliasStrategy(target: string): StrategyCandidate[] {
  const t = target.toLowerCase().replace(/[\s_\-]/g, '');
  const candidates: StrategyCandidate[] = [];

  for (const [keyword, aliases] of Object.entries(SEMANTIC_ALIASES)) {
    const kwN = keyword.replace(/[\s_\-]/g, '');
    if (t === kwN || t.includes(kwN) || kwN.includes(t)) {
      for (const alias of aliases) {
        const aliasN = alias.replace(/[\s_\-]/g, '');
        // Try all attribute matches for each alias
        candidates.push({ selector: `[name="${alias}"]`, reason: `Alias: ${keyword}→${alias} by name`, confidence: 70 });
        candidates.push({ selector: `[name*="${aliasN}" i]`, reason: `Alias: ${keyword}→${alias} by name contains`, confidence: 62 });
        candidates.push({ selector: `#${aliasN}`, reason: `Alias: ${keyword}→${alias} by id`, confidence: 68 });
        candidates.push({ selector: `[id*="${aliasN}" i]`, reason: `Alias: ${keyword}→${alias} by id contains`, confidence: 58 });
        candidates.push({ selector: `[placeholder*="${alias}" i]`, reason: `Alias: ${keyword}→${alias} by placeholder`, confidence: 60 });
        candidates.push({ selector: `[aria-label*="${alias}" i]`, reason: `Alias: ${keyword}→${alias} by aria-label`, confidence: 65 });
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// STRATEGY 11: Similarity Fallback / Broad wildcard
// Last resort — broad attribute selectors + structural position guesses
// ---------------------------------------------------------------------------
export function similarityFallback(target: string, context?: { isInputHint?: boolean; isButtonHint?: boolean }): StrategyCandidate[] {
  const t = target.toLowerCase().trim();
  const candidates: StrategyCandidate[] = [];

  if (context?.isInputHint) {
    // All visible text inputs in order
    candidates.push({ selector: `input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])`, reason: `Generic visible text input (fill fallback)`, confidence: 20 });
    candidates.push({ selector: `textarea`, reason: `Textarea fallback`, confidence: 15 });
  }

  if (context?.isButtonHint) {
    candidates.push({ selector: `button[type="submit"]`, reason: `Submit button fallback`, confidence: 25 });
    candidates.push({ selector: `input[type="submit"]`, reason: `Submit input fallback`, confidence: 22 });
    candidates.push({ selector: `button`, reason: `Generic button fallback`, confidence: 15 });
  }

  // Broad contains on common attributes
  candidates.push({ selector: `[class*="${t}" i]`, reason: `Class contains "${t}"`, confidence: 30 });

  return candidates;
}
