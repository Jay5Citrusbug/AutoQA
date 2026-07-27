import { ParsedStep, ActionType, ValidationType } from '@/types/testCase';
import { TestSuite } from '@/types/execution';

export interface ITestCaseParser {
  parse(rawSteps: string[]): ParsedStep[];
  parseTestSuites(rawText: string): TestSuite[];
}

export class TestCaseParser implements ITestCaseParser {
  /**
   * Cleans a step string by removing prefix numbering (e.g. "Step 1: ", "1. ", "1 - ")
   */
  private cleanStepText(text: string): string {
    return text.replace(/^(step\s*\d+\s*[:\-]?\s*|\d+\s*[\.\:\-]\s*)/i, '').trim();
  }

  /**
   * Normalizes the target field name by stripping common descriptive nouns, trailing arrows, and punctuation
   */
  private cleanTargetField(field: string): string {
    return field
      .trim()
      .replace(/\s*(?:->|-->|=>|>|→|➔)\s*$/g, '')
      .replace(/[.,;!?:="']/g, '')
      .replace(/\s+(?:field|input|box|textbox|button|btn|link|area|dropdown|selector|icon)$/i, '')
      .trim();
  }

  /**
   * A single pasted line often carries a whole numbered sequence:
   *   "1.Navigate to https://x/home 2. Click JR icon 3. Click Logout4. Verify Login page"
   * Splits it into one line per numbered item.
   *
   * Only fires when the markers form an ascending-by-one run of at least two, so
   * decimals ("wait 2.5 seconds"), version strings and list-like prose survive intact.
   * Markers inside a URL are ignored — "http://1.2.3.4/x" is not a step list.
   */
  private splitNumberedRun(line: string): string[] {
    const urlSpans: Array<[number, number]> = [];
    for (const m of line.matchAll(/https?:\/\/\S+/gi)) {
      urlSpans.push([m.index!, m.index! + m[0].length]);
    }
    const insideUrl = (i: number) => urlSpans.some(([s, e]) => i >= s && i < e);

    type Marker = { start: number; end: number; num: number };
    const markers: Marker[] = [];
    // A marker is "<digits><dot|paren>" immediately followed by a letter, e.g.
    // "2. Click" or the un-spaced "Logout4. Verify".
    for (const m of line.matchAll(/(\d{1,2})\s*[.)]\s*(?=[A-Za-z])/g)) {
      const start = m.index!;
      if (insideUrl(start)) continue;
      // Digits glued to the left mean this is part of a larger number ("v1.2", "10.5").
      if (start > 0 && /\d/.test(line[start - 1])) continue;
      markers.push({ start, end: start + m[0].length, num: parseInt(m[1], 10) });
    }

    // Keep only the ascending-by-one chain, so a stray "3." mid-sentence cannot split text.
    const chain: Marker[] = [];
    for (const mk of markers) {
      if (chain.length === 0) chain.push(mk);
      else if (mk.num === chain[chain.length - 1].num + 1) chain.push(mk);
    }
    if (chain.length < 2) return [line];

    const parts: string[] = [];
    const head = line.slice(0, chain[0].start).trim();
    if (head) parts.push(head);
    chain.forEach((mk, i) => {
      const stop = i + 1 < chain.length ? chain[i + 1].start : line.length;
      const body = line.slice(mk.end, stop).trim();
      if (body) parts.push(body);
    });
    return parts;
  }

  /**
   * Real UI actions the runner has no implementation for. Recognising them lets
   * the step fail with an accurate message — and lets the failure classifier mark
   * it an automation gap rather than raising it as a defect in the application.
   */
  private static readonly UNSUPPORTED_ACTION =
    /^(hover|scroll|refresh|reload|drag|drop|upload|download|resize|maximi[sz]e|minimi[sz]e|zoom|swipe|double[-\s]?click|right[-\s]?click|go\s+back|go\s+forward|switch\s+to|press\s+(?:the\s+)?(?:enter|tab|escape|esc|space|backspace|delete|arrow\w*)\b)/i;

  /** Derives a URL fragment from a page name: "Login" → "/login", "Sign Up" → "/sign-up". */
  private pageNameToUrlFragment(pageName: string): string | null {
    const slug = pageName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    // Multi-word page names rarely map cleanly onto a path segment — asserting on
    // a guessed slug would invent failures, so only single-word names are used.
    if (!slug || slug.includes('-')) return null;
    return `/${slug}`;
  }

  public parse(rawSteps: string[]): ParsedStep[] {
    const parsedSteps: ParsedStep[] = [];

    // Expand any line that packs several numbered steps into one before parsing.
    const lines = rawSteps.flatMap((line) => this.splitNumberedRun(line));

    lines.forEach((rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;

      // 0. Detect and skip Test Case Title / Metadata Headers
      if (/^TC\d+/i.test(trimmed) || trimmed.toLowerCase().startsWith('testcase') || trimmed.toLowerCase().startsWith('test case')) {
        return;
      }

      const cleanText = this.cleanStepText(trimmed);
      // Numbering is sequential over emitted steps: a compound line expands into
      // several steps and one sentence can yield more than one assertion, so the
      // source line index is no longer a usable step number.
      const stepIndex = parsedSteps.length + 1;

      // 0b. Recognised but unimplemented actions are caught before anything else.
      // "Press Enter" is a keystroke, not a click on an element labelled "Enter" —
      // letting the click rule claim it produces a confusing element-not-found
      // failure instead of an accurate "not supported" one.
      const unsupportedAction = cleanText.match(TestCaseParser.UNSUPPORTED_ACTION);
      if (unsupportedAction) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'unparsed',
          targetField: '',
          parseWarning:
            `Unsupported action: "${unsupportedAction[1].toLowerCase()}" is not implemented by the runner ` +
            `(step: "${trimmed}"). Supported actions are navigate, click, fill, select, check, uncheck and wait.`,
        });
        return;
      }

      // 1. GOTO / NAVIGATE TO
      let match = cleanText.match(/^(?:navigate\s+to|go\s+to|goto|open|visit|load|browse\s+to)\b/i);
      if (match) {
        // Prefer an explicit URL anywhere in the line (handles "open Login page - https://x.com/login").
        const urlInLine = cleanText.match(/https?:\/\/[^\s"'<>)]+/i);
        let target: string | undefined = urlInLine?.[0];

        if (!target) {
          // No full URL — take the phrase after the verb, stripping quotes and a
          // leading label like "Login page - ". Bare-domain values (example.com/login) survive.
          const after = cleanText
            .replace(/^(?:navigate\s+to|go\s+to|goto|open|visit|load|browse\s+to)\s+/i, '')
            .replace(/^(?:the\s+)?/i, '')
            .replace(/["']/g, '')
            .trim();
          const domainLike = after.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?/i);
          target = domainLike?.[0] || after || undefined;
        }

        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'navigate',
          targetField: 'url',
          value: target,
        });
        return;
      }

      // 2. WAIT / SLEEP
      match = cleanText.match(/^(?:wait|sleep)\s+(\d+)\s*(ms|milliseconds|seconds|sec|s)?/i);
      if (match) {
        const val = parseInt(match[1], 10);
        const unit = match[2]?.toLowerCase() || 'seconds';
        const ms = (unit === 'ms' || unit === 'milliseconds') ? val : val * 1000;
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'wait',
          targetField: 'timer',
          waitMs: ms,
        });
        return;
      }

      // 2b. WAIT UNTIL / WAIT FOR — dynamic readiness gate for async/CRUD operations.
      //   'Wait until "Loading" disappears'
      //   'Wait for "Loading spinner" to disappear'
      //   'Wait until the spinner is hidden'
      //   'Wait for the record to be saved' (falls through to visible check on the phrase)
      // Unlike a validation assertion, this NEVER fails the suite on timeout — it's a
      // readiness gate for slow API calls, not a pass/fail check. The step after it
      // (typically a real assertion) is what actually judges success.
      match = cleanText.match(
        /^wait\s+(?:until|for)\s+(?:the\s+)?["']?([^"']+?)["']?\s+(?:to\s+)?(disappears?|is\s+(?:hidden|gone|removed))/i,
      );
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'waitUntil',
          targetField: match[1].trim(),
          waitMode: 'hidden',
        });
        return;
      }

      match = cleanText.match(
        /^wait\s+(?:until|for)\s+(?:the\s+)?["']?([^"']+?)["']?\s+(?:to\s+)?(?:appears?|is\s+(?:visible|shown|displayed))/i,
      );
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'waitUntil',
          targetField: match[1].trim(),
          waitMode: 'visible',
        });
        return;
      }

      // 'Wait for page to load' / 'Wait for loading to complete' / 'Wait for API to complete' —
      // generic readiness gate with no specific target text; relies purely on the
      // network/spinner settle detection the runner already performs after every action.
      match = cleanText.match(/^wait\s+for\s+(?:the\s+)?(?:page|api|loading|request|data)(?:\s+to\s+(?:load|complete|finish))?$/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'wait',
          targetField: 'timer',
          waitMs: 1500,
        });
        return;
      }

      // 3. ENTER GENERIC CREDENTIALS
      // Gated on an actual input verb. Without the gate, an assertion that merely
      // mentions the phrase — 'System displays "Invalid credentials" message' —
      // was turned into a login attempt, so the test typed credentials where it
      // was supposed to be checking an error.
      const isCredentialAction = /^(?:enter|type|fill|input|use|provide|supply|submit|login\s+with|log\s+in\s+with|sign\s+in\s+with)\b/i.test(cleanText);
      if (isCredentialAction && /\b(?:in)?valid\s+credentials\b/i.test(cleanText)) {
        const isValid = cleanText.toLowerCase().includes('valid credentials') && !cleanText.toLowerCase().includes('invalid');
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'fill',
          targetField: 'credentials',
          value: isValid ? 'valid' : 'invalid',
        });
        return;
      }

      // 4a. FILL: (enter|type|fill) [value] (into|in|to|on) [field]
      let fillMatch = cleanText.match(/^(?:enter|type|fill)\s+["']?([^"']+)["']?\s+(?:into|in|to|on)\s+(?:the\s+)?(?:input\s+)?["']?([^"']+)["']?/i);
      if (fillMatch) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'fill',
          targetField: this.cleanTargetField(fillMatch[2]),
          value: fillMatch[1],
        });
        return;
      }

      // 4b. FILL: (enter|type|fill) [field] [separator - or : or =] [value]
      fillMatch = cleanText.match(/^(?:enter|type|fill)(?:\s+in|\s+into)?\s+["']?([^"'\x2d\x3a\x3d]+?)["']?\s*[\x2d\x3a\x3d]\s*["']?([^"']+)["']?/i);
      if (fillMatch) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'fill',
          targetField: this.cleanTargetField(fillMatch[1]),
          value: fillMatch[2],
        });
        return;
      }

      // 4c. FILL: fill (in) [field] with [value]
      fillMatch = cleanText.match(/^fill(?:\s+in)?\s+["']?([^"']+)["']?\s+with\s+["']?([^"']+)["']?/i);
      if (fillMatch) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'fill',
          targetField: this.cleanTargetField(fillMatch[1]),
          value: fillMatch[2],
        });
        return;
      }

      // 4d. FILL: (enter|type|fill) [field] as [value]
      fillMatch = cleanText.match(/^(?:enter|type|fill)\s+["']?([^"']+)["']?\s+as\s+["']?([^"']+)["']?/i);
      if (fillMatch) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'fill',
          targetField: this.cleanTargetField(fillMatch[1]),
          value: fillMatch[2],
        });
        return;
      }

      // 5. CLICK ELEMENT
      // The whole phrase after the verb is the target. Filler words are stripped
      // separately rather than inside the capture — matching "on"/"the" as part of
      // the pattern made 'Click on the "Save" button' resolve to the word "the".
      match = cleanText.match(/^(?:click|press|tap|choose)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
      if (match) {
        // A quoted fragment anywhere in the phrase is the author naming the
        // element exactly; it beats the surrounding words.
        const quoted = match[1].match(/["']([^"']+)["']/);
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'click',
          targetField: this.cleanTargetField(quoted ? quoted[1] : match[1]),
        });
        return;
      }

      // 6. SELECT VALUE IN DROPDOWN
      match = cleanText.match(/^(?:select|choose)\s+["']?([^"']+)["']?\s+(?:from|in)\s+(?:dropdown\s+)?["']?([^"']+)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'select',
          targetField: this.cleanTargetField(match[2]),
          value: match[1],
        });
        return;
      }

      // 7. CHECK CHECKBOX
      match = cleanText.match(/^(?:check|tick)\s+(?:the\s+)?["']?([^"']+)["']?(?:\s+checkbox)?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'check',
          targetField: this.cleanTargetField(match[1]),
        });
        return;
      }

      // 8. UNCHECK CHECKBOX
      match = cleanText.match(/^(?:uncheck|untick)\s+(?:the\s+)?["']?([^"']+)["']?(?:\s+checkbox)?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'uncheck',
          targetField: this.cleanTargetField(match[1]),
        });
        return;
      }

      // --- VALIDATIONS ---
      // 9. VERIFY URL
      // "exactly" opts out of equivalent-route matching for steps where the
      // literal path is the thing under test.
      match = cleanText.match(
        /^(?:verify|assert|check)\s+(?:that\s+)?url\s+(?:contains|matches|is)\s+(exactly\s+)?["']?([^"']+)["']?/i,
      );
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'url',
          targetField: 'url',
          value: match[2].trim(),
          strict: match[1] ? true : undefined,
        });
        return;
      }

      // 10. VERIFY SUCCESS MESSAGE
      match = cleanText.match(/^(?:verify|assert|check)\s+(?:that\s+)?(?:a\s+|an\s+)?success(?:\s+(?:message|banner|notification|text|alert))?(?:\s+(?:is\s+visible|exists|appears|displayed))?(?:\s+["']?([^"']+)["']?)?/i);
      if (match && (cleanText.toLowerCase().includes('success') || match[1])) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'success_msg',
          targetField: 'success_message',
          value: match[1] ? match[1].trim() : undefined,
        });
        return;
      }

      // 11. VERIFY ERROR MESSAGE / ERROR ALERT
      match = cleanText.match(/^(?:verify|assert|check)\s+(?:that\s+)?(?:an?\s+)?error(?:\s+(?:message|banner|notification|text|alert))?(?:\s+(?:is\s+visible|exists|appears|displayed))?(?:\s+["']?([^"']+)["']?)?/i);
      if (match && (cleanText.toLowerCase().includes('error') || match[1])) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'error_msg',
          targetField: 'error_message',
          value: match[1] ? match[1].trim() : undefined,
        });
        return;
      }

      // 12. VERIFY ELEMENT ENABLED / DISABLED
      match = cleanText.match(/^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(?:button|field|input|link|element)?\s*["']?([^"']+)["']?\s+is\s+(enabled|disabled)/i);
      if (match) {
        const isDis = match[2].toLowerCase() === 'disabled';
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: isDis ? 'disabled' : 'enabled',
          targetField: match[1].trim(),
          value: match[1].trim(),
        });
        return;
      }

      // 13. VERIFY TEXT / ELEMENT / WORD / BUTTON / FIELD / LABEL / LINK VISIBLE / VISIBILITY
      match = cleanText.match(/^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(?:text|word|content|element|button|field|input|label|link|heading|header|icon)?\s*["']?([^"']+)["']?\s+is\s+visible/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'visible',
          targetField: match[1].trim(),
          value: match[1].trim(),
        });
        return;
      }

      // ── NEW ASSERTION RULES ────────────────────────────────────────────── //

      // 14-A. URL SHOULD CONTAIN / URL SHOULD MATCH
      //   "url should contain /dashboard"
      //   "page url should contain /home"
      //   "url should match https://..."
      match = cleanText.match(/^(?:(?:page\s+)?url|the\s+url)\s+should(?:\s+(?:now|also))?\s+(?:contain|include|match|be)\s+["']?([^"']+)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'url',
          targetField: 'url',
          value: match[1].trim(),
        });
        return;
      }

      // 14-B. URL SHOULD NOT CONTAIN
      //   "url should not contain /login"
      //   "verify url does not contain /error"
      //   "url should not include /logout"
      match = cleanText.match(
        /^(?:(?:(?:page\s+)?url|the\s+url)\s+should\s+not\s+(?:contain|include|match|be)|(?:verify|assert|check)\s+(?:that\s+)?url\s+(?:does\s+not|doesn[''']?t|not)\s+(?:contain|include|match))\s+["']?([^"']+)["']?/i
      );
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'not_url',
          targetField: 'url',
          value: match[1].trim(),
        });
        return;
      }

      // 14-C. ELEMENT/TEXT SHOULD BE VISIBLE / SHOULD APPEAR / SHOULD DISPLAY
      //   '"Welcome" should be visible'
      //   'the error banner should appear'
      //   '"Dashboard" should be displayed'
      match = cleanText.match(/^["']?([^"']+)["']?\s+should(?:\s+(?:now|also))?\s+(?:be\s+(?:visible|displayed|shown)|appear|show(?:\s+up)?)/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'visible',
          targetField: match[1].trim(),
          value: match[1].trim(),
        });
        return;
      }

      // 14-D. ELEMENT/TEXT SHOULD NOT BE VISIBLE / SHOULD BE HIDDEN
      //   '"Login form" should not be visible'
      //   '"Error panel" should be hidden'
      //   '"Spinner" should not appear'
      match = cleanText.match(/^["']?([^"']+)["']?\s+should(?:\s+(?:now|also))?\s+(?:not\s+be\s+(?:visible|displayed|shown)|be\s+(?:hidden|invisible)|not\s+appear|disappear)/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'not_visible',
          targetField: match[1].trim(),
          value: match[1].trim(),
        });
        return;
      }

      // 14-E. VERIFY ELEMENT IS HIDDEN / NOT VISIBLE
      //   'verify "spinner" is hidden'
      //   'assert element "modal" is not visible'
      //   'check that "overlay" is not displayed'
      match = cleanText.match(/^(?:verify|assert|check)\s+(?:that\s+)?(?:element\s+)?["']?([^"']+)["']?\s+is\s+(?:not\s+visible|not\s+displayed?|hidden|invisible)/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'not_visible',
          targetField: match[1].trim(),
          value: match[1].trim(),
        });
        return;
      }

      // 14-F. VERIFY ELEMENT IS DISABLED / SHOULD BE DISABLED
      //   'verify "submit" is disabled'
      //   '"submit button" should be disabled'
      //   'assert element "email field" is not enabled'
      match = cleanText.match(
        /^(?:(?:verify|assert|check)\s+(?:that\s+)?(?:element\s+)?["']?([^"']+)["']?\s+is\s+(?:disabled|not\s+enabled)|["']?([^"']+)["']?\s+should(?:\s+be)?\s+(?:disabled|not\s+enabled))/i
      );
      if (match) {
        const target = (match[1] || match[2]).trim();
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'disabled',
          targetField: target,
          value: target,
        });
        return;
      }

      // 14-G. ELEMENT SHOULD BE ENABLED
      //   '"submit" should be enabled'
      //   '"Login button" should be enabled'
      match = cleanText.match(/^["']?([^"']+)["']?\s+should(?:\s+be)?\s+enabled/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'enabled',
          targetField: match[1].trim(),
          value: match[1].trim(),
        });
        return;
      }

      // 14-H. PAGE SHOULD CONTAIN / SHOULD DISPLAY / SHOULD SHOW text
      //   'page should contain "Welcome"'
      //   'should display "Success"'
      //   'page should show "error"'
      //   'should see "Dashboard"'
      match = cleanText.match(
        /^(?:(?:the\s+)?page\s+should\s+(?:contain|display|show|have|include)|should\s+(?:display|show|contain|include|have|see))\s+["']?([^"']+)["']?/i
      );
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'text',
          targetField: 'body',
          value: match[1].trim(),
        });
        return;
      }

      // 14-I. PAGE SHOULD NOT CONTAIN / NOT DISPLAY / NOT SHOW text
      //   'page should not contain "error"'
      //   'should not display "Login"'
      //   'page should not show "spinner"'
      match = cleanText.match(
        /^(?:(?:the\s+)?page\s+should\s+not\s+(?:contain|display|show|have|include)|should\s+not\s+(?:display|show|contain|include|have|see))\s+["']?([^"']+)["']?/i
      );
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'not_text',
          targetField: 'body',
          value: match[1].trim(),
        });
        return;
      }

      // 14-J. SHOULD SEE / I SHOULD SEE text (BDD Gherkin style)
      //   'I should see "Welcome back"'
      //   'should see the dashboard'
      match = cleanText.match(/^(?:i\s+)?should\s+see\s+["']?([^"']+)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'text',
          targetField: 'body',
          value: match[1].trim(),
        });
        return;
      }

      // 14-K. SHOULD NOT SEE / I SHOULD NOT SEE text (BDD style)
      //   'I should not see "error"'
      //   'should not see the login form'
      match = cleanText.match(/^(?:i\s+)?should\s+not\s+see\s+["']?([^"']+)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'not_text',
          targetField: 'body',
          value: match[1].trim(),
        });
        return;
      }


      // 14-L. VERIFY <NAME> PAGE
      //   'Verify Login page'
      //   'verify that the Dashboard page is displayed'
      //   'check user is on the Login page'
      // A page name is a routing claim, so it becomes a URL assertion rather than a
      // body-text search — "Login" appears on plenty of pages that are not /login.
      match = cleanText.match(
        /^(?:verify|assert|check)\s+(?:that\s+)?(?:the\s+)?(?:user\s+(?:is|lands?)\s+(?:on|at|redirected\s+to)\s+)?(?:the\s+)?([A-Za-z][A-Za-z0-9 ]*?)\s+(?:page|screen)(?:\s+is\s+(?:displayed|visible|shown|loaded|open))?\s*$/i,
      );
      if (match) {
        const fragment = this.pageNameToUrlFragment(match[1]);
        if (fragment) {
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: 'url',
            targetField: 'url',
            value: fragment,
          });
          return;
        }
      }

      // 14-M. REDIRECTION SENTENCES (typical "Expected Result" prose)
      //   'User is redirected to Login page where "Welcome Back!" heading ... are visible'
      //   'The user should be taken to the Dashboard page'
      // Emits the routing assertion, plus one visibility assertion per quoted phrase
      // in the same sentence — a single sentence legitimately makes several claims.
      match = cleanText.match(
        /^(?:the\s+)?(?:user|users|you|we|they|i)\s+(?:is|are|should\s+be|shall\s+be|will\s+be|gets?|get|was|were)\s+(?:redirected|navigated|taken|sent|returned|routed|brought|landed)\s+(?:back\s+)?(?:to|on|onto|into)\s+(?:the\s+)?(.+)$/i,
      );
      if (match) {
        const rest = match[1];
        // Everything before a connector is the destination; the remainder describes
        // what should be on that destination.
        const destination = rest.split(/\s+(?:where|which|with|showing|displaying|containing|and\s+(?:see|sees))\b/i)[0];
        const pageName = destination
          .replace(/\b(?:page|screen|view|url|the|a|an)\b/gi, ' ')
          .replace(/["'.,;!?]/g, ' ')
          .trim();

        let emitted = false;
        const fragment = this.pageNameToUrlFragment(pageName);
        if (fragment) {
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: 'url',
            targetField: 'url',
            value: fragment,
          });
          emitted = true;
        }

        for (const q of cleanText.matchAll(/["']([^"']+)["']/g)) {
          const phrase = q[1].trim();
          if (!phrase) continue;
          parsedSteps.push({
            stepIndex: parsedSteps.length + 1,
            rawText: trimmed,
            type: 'validation',
            validation: 'visible',
            targetField: phrase,
            value: phrase,
          });
          emitted = true;
        }

        if (emitted) return;
      }

      // 14-N0. NEGATIVE DECLARATIVE VISIBILITY — must precede the positive form,
      // which would otherwise read "No error message is displayed" as a request to
      // find something called "No error message".
      match = cleanText.match(/^no\s+(.+?)\s+(?:is|are|should\s+be)\s+(?:visible|displayed|shown|present)/i)
        || cleanText.match(/^(?:the\s+)?(.+?)\s+(?:is|are)\s+not\s+(?:visible|displayed|shown|present)/i);
      if (match) {
        const phrase = match[1].replace(/["'.,;!?]/g, '').trim();
        if (phrase) {
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: 'not_visible',
            targetField: phrase,
            value: phrase,
          });
          return;
        }
      }

      // 14-N1. SOMEONE/SOMETHING SEES OR SHOWS SOMETHING
      //   'The user can see the WorkHub menu'
      //   'User sees "Task created successfully"'
      //   'System displays "Invalid credentials" message'
      //   'The page shows the Dashboard'
      match = cleanText.match(
        /^(?:the\s+)?(?:user|users|system|page|app|application|screen|it)\s+(?:can\s+|should\s+|will\s+|must\s+)?(?:see|sees|view|views|display|displays|show|shows|present|presents)\s+(?:the\s+|a\s+|an\s+)?(.+)$/i,
      );
      if (match) {
        const quoted = [...match[1].matchAll(/["']([^"']+)["']/g)].map((q) => q[1].trim()).filter(Boolean);
        const phrases = quoted.length > 0
          ? quoted
          : [match[1].replace(/\s+(?:message|text|label|heading|banner|notification|option|menu|page|screen)\s*$/i, '').replace(/["'.,;!?]/g, '').trim()];
        let emitted = false;
        for (const phrase of phrases) {
          if (!phrase) continue;
          parsedSteps.push({
            stepIndex: parsedSteps.length + 1,
            rawText: trimmed,
            type: 'validation',
            validation: 'visible',
            targetField: phrase,
            value: phrase,
          });
          emitted = true;
        }
        if (emitted) return;
      }

      // 14-N2. SOMETHING APPEARS / OPENS
      //   'Error message "Incorrect Email or Password" appears'
      //   'A confirmation dialog appears'
      //   'The profile menu opens'
      match = cleanText.match(/^(?:the\s+|a\s+|an\s+)?(.+?)\s+(?:appears?|opens?|pops?\s+up|is\s+opened)\s*$/i);
      if (match) {
        const quoted = match[1].match(/["']([^"']+)["']/);
        const phrase = (quoted ? quoted[1] : match[1]).replace(/["'.,;!?]/g, '').trim();
        if (phrase) {
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: 'visible',
            targetField: phrase,
            value: phrase,
          });
          return;
        }
      }

      // 14-N3. DECLARATIVE ENABLED / DISABLED
      //   'The Create Task button is enabled'
      //   'The Submit button is disabled'
      match = cleanText.match(/^(?:the\s+)?(.+?)\s+(?:is|are|should\s+be)\s+(enabled|disabled)\s*$/i);
      if (match) {
        const phrase = match[1].replace(/["'.,;!?]/g, '').trim();
        if (phrase) {
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: match[2].toLowerCase() === 'disabled' ? 'disabled' : 'enabled',
            targetField: phrase,
            value: phrase,
          });
          return;
        }
      }

      // 14-N. DECLARATIVE VISIBILITY (no leading verb — common in "Expected Result" cells)
      //   '"Welcome Back!" heading and login details text are visible'
      //   'The success banner is displayed'
      // Quoted phrases are the precise claim; each becomes its own assertion.
      if (/\b(?:is|are)\s+(?:visible|displayed|shown|present|available)\b/i.test(cleanText)) {
        const quoted = [...cleanText.matchAll(/["']([^"']+)["']/g)].map((q) => q[1].trim()).filter(Boolean);
        if (quoted.length > 0) {
          quoted.forEach((phrase) => {
            parsedSteps.push({
              stepIndex: parsedSteps.length + 1,
              rawText: trimmed,
              type: 'validation',
              validation: 'visible',
              targetField: phrase,
              value: phrase,
            });
          });
          return;
        }

        // No quotes — treat the subject of the sentence as the thing to look for.
        const subject = cleanText.match(/^(?:the\s+)?(.+?)\s+(?:is|are)\s+(?:visible|displayed|shown|present|available)\b/i);
        if (subject) {
          const phrase = subject[1].replace(/["'.,;!?]/g, '').trim();
          if (phrase) {
            parsedSteps.push({
              stepIndex,
              rawText: trimmed,
              type: 'validation',
              validation: 'visible',
              targetField: phrase,
              value: phrase,
            });
            return;
          }
        }
      }

      // 14. ROBUST "EXPECTED RESULT" & "SHOULD" ASSERTIONS
      if (cleanText.toLowerCase().includes('verify') ||
          cleanText.toLowerCase().includes('assert') || 
          cleanText.toLowerCase().includes('expected') ||
          cleanText.toLowerCase().includes('should')) {
        
        // Check for URL verification
        const urlMatch = cleanText.match(/(https?:\/\/[^\s"']+)/i);
        if (urlMatch || cleanText.toLowerCase().includes('url')) {
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: 'url',
            targetField: 'url',
            value: urlMatch ? urlMatch[1] : cleanText,
          });
          return;
        }

        // Quoted text search
        const quoteMatches = [...cleanText.matchAll(/["']([^"']+)["']/g)];
        if (quoteMatches.length > 0) {
          const valText = quoteMatches.map(m => m[1]).join(' ');
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: 'text',
            targetField: 'body',
            value: valText,
          });
          return;
        }

        // Proper Noun / Capitalized Phrase heuristics (excluding common sentence starters)
        const words = cleanText.split(/\s+/);
        const capitalizedPhrases: string[] = [];
        let currentPhrase: string[] = [];

        words.forEach((word, wordIdx) => {
          const cleanWord = word.replace(/[^a-zA-Z]/g, '');
          const isCapitalized = cleanWord.length > 0 && cleanWord[0] === cleanWord[0].toUpperCase() && cleanWord !== cleanWord.toLowerCase();
          const isFirstWord = wordIdx === 0;
          const isStop = ['it', 'the', 'step', 'expected', 'result', 'tc'].includes(cleanWord.toLowerCase());

          if (isCapitalized && !isFirstWord && !isStop) {
            currentPhrase.push(word.replace(/[,;.:!?"']/g, ''));
          } else {
            if (currentPhrase.length > 0) {
              capitalizedPhrases.push(currentPhrase.join(' '));
              currentPhrase = [];
            }
          }
        });
        if (currentPhrase.length > 0) {
          capitalizedPhrases.push(currentPhrase.join(' '));
        }

        if (capitalizedPhrases.length > 0) {
          // Verify first extracted Proper Noun (e.g. "Optevo")
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'validation',
            validation: 'text',
            targetField: 'body',
            value: capitalizedPhrases[0],
          });
          return;
        }

        // Cleanup fallback value
        const fallbackVal = cleanText
          .replace(/^(verify|assert|check|expected result|expected)\s*[:\-]?/i, '')
          .replace(/^(it should display|should display|should be|should)\s+/i, '')
          .trim();

        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'text',
          targetField: 'body',
          value: fallbackVal,
        });
      } else {
        // No known pattern matched. Never blindly click — mark the step unparsed
        // so the runner reports a clear failure and the UI can prompt a rephrase.
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'unparsed',
          targetField: '',
          parseWarning:
            `Step could not be understood: "${trimmed}". ` +
            `Start with an action verb (click, enter, select, check, navigate) or an assertion (verify/assert/expect).`,
        });
      }
    });

    // A step list and its "Expected Result" prose often restate the same claim
    // ("Verify Login page" + "User is redirected to Login page"). Running the
    // identical assertion twice in a row adds time and noise, never coverage.
    const deduped = parsedSteps.filter((step, i) => {
      if (i === 0 || step.type !== 'validation') return true;
      const prev = parsedSteps[i - 1];
      return !(
        prev.type === 'validation' &&
        prev.validation === step.validation &&
        prev.targetField === step.targetField &&
        prev.value === step.value
      );
    });
    deduped.forEach((step, i) => { step.stepIndex = i + 1; });

    return deduped;
  }

  /**
   * Session-reuse directives. Written on the TC header or on their own line:
   *   @fresh-login / @no-reuse   -> always log in for real in this test case
   *   @reuse-session             -> reuse a cached login even if this TC looks like a login test
   */
  private static readonly FRESH_LOGIN_DIRECTIVE = /@(?:fresh[-_ ]?login|no[-_ ]?(?:session[-_ ]?)?reuse)\b/i;
  private static readonly REUSE_SESSION_DIRECTIVE = /@reuse[-_ ]?session\b/i;
  private static readonly HAS_DIRECTIVE = /@(?:fresh[-_ ]?login|no[-_ ]?(?:session[-_ ]?)?reuse|reuse[-_ ]?session)\b/i;

  /** Strips directive tokens from a line. A fresh regex per call — /g regexes carry lastIndex state. */
  private stripDirectives(line: string): string {
    return line.replace(/@(?:fresh[-_ ]?login|no[-_ ]?(?:session[-_ ]?)?reuse|reuse[-_ ]?session)\b/gi, '');
  }

  /** True when a line carries nothing but session directives (so it is not a step). */
  private isDirectiveOnlyLine(line: string): boolean {
    if (!TestCaseParser.HAS_DIRECTIVE.test(line)) return false;
    return this.stripDirectives(line).trim().length === 0;
  }

  /**
   * Splits raw editor text into independent test case suites.
   * Lines that start with "TC01:", "TC02:", "Test Case 1:", etc. act as suite separators.
   * Each suite gets its own independent ParsedStep[] so it can run in isolation.
   * If no TC headers are detected the entire input becomes a single suite ("TC01").
   */
  public parseTestSuites(rawText: string): TestSuite[] {
    const lines = rawText.split('\n');
    const TC_HEADER = /^(TC\d+|Test\s*Case\s*\d+)\s*[:\-]?\s*(.*)/i;

    const suites: TestSuite[] = [];
    let currentSuiteId = '';
    let currentTitle = '';
    let currentLines: string[] = [];
    let currentDirectiveText = '';

    const flushSuite = () => {
      if (!currentSuiteId && currentLines.length === 0) return;
      const id = currentSuiteId || 'TC01';
      const title = currentTitle || id;
      const steps = this.parse(currentLines);
      if (steps.length > 0) {
        suites.push({
          id,
          title,
          steps,
          freshLogin: TestCaseParser.FRESH_LOGIN_DIRECTIVE.test(currentDirectiveText) || undefined,
          forceReuse: TestCaseParser.REUSE_SESSION_DIRECTIVE.test(currentDirectiveText) || undefined,
        });
      }
    };

    for (const line of lines) {
      const trimmed = line.trim();
      const headerMatch = trimmed.match(TC_HEADER);

      if (headerMatch) {
        // Flush the previous suite before starting a new one
        flushSuite();
        currentSuiteId = headerMatch[1].toUpperCase().replace(/\s+/g, '');
        currentTitle = trimmed;
        currentLines = [];
        currentDirectiveText = trimmed;
      } else if (this.isDirectiveOnlyLine(trimmed)) {
        // A directive on its own line configures the suite, it is not a step.
        currentDirectiveText += ` ${trimmed}`;
      } else {
        currentDirectiveText += ` ${trimmed}`;
        currentLines.push(this.stripDirectives(line));
      }
    }

    // Flush the last (or only) suite
    flushSuite();

    // If nothing was parsed, return an empty array
    return suites;
  }
}
