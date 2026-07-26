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

  public parse(rawSteps: string[]): ParsedStep[] {
    const parsedSteps: ParsedStep[] = [];

    rawSteps.forEach((rawLine, idx) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;

      // 0. Detect and skip Test Case Title / Metadata Headers
      if (/^TC\d+/i.test(trimmed) || trimmed.toLowerCase().startsWith('testcase') || trimmed.toLowerCase().startsWith('test case')) {
        return;
      }

      const cleanText = this.cleanStepText(trimmed);
      const stepIndex = idx + 1;

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

      // 3. ENTER GENERIC CREDENTIALS
      if (cleanText.toLowerCase().includes('invalid credentials') || cleanText.toLowerCase().includes('valid credentials')) {
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
      match = cleanText.match(/^(?:click|press|tap)(?:\s+on|\s+the)?\s+["']?([^"']+)["']?(?:\s+button|\s+link)?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'click',
          targetField: this.cleanTargetField(match[1]),
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
      match = cleanText.match(/^(?:verify|assert|check)\s+(?:that\s+)?url\s+(?:contains|matches|is)\s+["']?([^"']+)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'url',
          targetField: 'url',
          value: match[1],
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

    return parsedSteps;
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

    const flushSuite = () => {
      if (!currentSuiteId && currentLines.length === 0) return;
      const id = currentSuiteId || 'TC01';
      const title = currentTitle || id;
      const steps = this.parse(currentLines);
      if (steps.length > 0) {
        suites.push({ id, title, steps });
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
      } else {
        currentLines.push(line);
      }
    }

    // Flush the last (or only) suite
    flushSuite();

    // If nothing was parsed, return an empty array
    return suites;
  }
}
