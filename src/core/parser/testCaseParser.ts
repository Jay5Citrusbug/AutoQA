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
   * Normalizes the target field name by stripping common descriptive nouns and trailing punctuation
   */
  private cleanTargetField(field: string): string {
    return field
      .trim()
      .replace(/[.,;!?:"']/g, '')
      .replace(/\s+(?:field|input|box|textbox|button|link|area|dropdown|selector)$/i, '')
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
      let match = cleanText.match(/^(?:navigate\s+to|goto|open|visit)\s+(?:the\s+)?["']?([^"'\s]+(?:\s+[^"'\s]+)*)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'navigate',
          targetField: 'url',
          value: match[1],
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
      match = cleanText.match(/^(?:verify|assert|check)\s+success\s+(?:message|banner|notification|text)\s+["']?([^"']+)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'success_msg',
          targetField: 'success_message',
          value: match[1],
        });
        return;
      }

      // 11. VERIFY ERROR MESSAGE
      match = cleanText.match(/^(?:verify|assert|check)\s+error\s+(?:message|banner|notification|text)\s+["']?([^"']+)["']?/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'error_msg',
          targetField: 'error_message',
          value: match[1],
        });
        return;
      }

      // 12. VERIFY ELEMENT ENABLED
      match = cleanText.match(/^(?:verify|assert|check)\s+["']?([^"']+)["']?\s+is\s+enabled/i);
      if (match) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'validation',
          validation: 'enabled',
          targetField: match[1].trim(),
        });
        return;
      }

      // 13. VERIFY TEXT VISIBLE / VISIBILITY
      match = cleanText.match(/^(?:verify|assert|check)\s+(?:text|element)?\s*["']?([^"']+)["']?\s+is\s+visible/i);
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
        // Fallback action click
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'click',
          targetField: cleanText,
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
