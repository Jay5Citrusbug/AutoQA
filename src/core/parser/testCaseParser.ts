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
      // Filler that survives a verb ("fill UP the name", "click ON the button")
      // and articles. Left in place the target becomes "up the workpod name",
      // which no element on earth is labelled.
      .replace(/^(?:up|out|in|on|at|to)\s+/i, '')
      .replace(/^(?:the|a|an|this|that|its|their)\s+/i, '')
      .replace(/\s+(?:field|input|box|textbox|button|btn|link|area|dropdown|selector|icon|menu|option)$/i, '')
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

  // ---------------------------------------------------------------------
  // FILL GRAMMAR
  //
  // Two lists, every combination derived from them. Adding a synonym means
  // adding one word here, and it works in every phrasing at once.
  // ---------------------------------------------------------------------

  /** Verbs that mean "put this text into that field". */
  private static readonly FILL_VERBS = [
    'enter', 'type', 'fill', 'input', 'set', 'provide', 'supply', 'populate', 'write',
  ];

  /** `<verb> VALUE <connector> FIELD` — the value comes first. */
  private static readonly VALUE_FIRST_CONNECTORS = ['into', 'in', 'to', 'on', 'inside'];

  /** `<verb> FIELD <connector> VALUE` — the field comes first. */
  private static readonly FIELD_FIRST_CONNECTORS = ['with', 'as', 'to', '=', ':', '-'];

  /**
   * `to` reads both ways: "set language to English" names the field first,
   * "enter John into the name box" names the value first. The verb settles it —
   * `set`/`populate` take a target and then a value, everything else follows the
   * older "enter VALUE into FIELD" reading so existing test cases keep working.
   */
  private static readonly FIELD_FIRST_TO_VERBS = new Set(['set', 'populate']);

  private static escapeForRegex(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Matches any supported way of saying "put a value in a field", including the
   * value-less form ("Enter workpod name") which defers the value to execution.
   */
  private matchFill(
    cleanText: string,
  ): { targetField: string; value?: string; autoValue?: boolean } | null {
    const verbs = TestCaseParser.FILL_VERBS.join('|');
    const esc = TestCaseParser.escapeForRegex;

    const verbMatch = cleanText.match(new RegExp(`^(${verbs})\\b\\s*`, 'i'));
    if (!verbMatch) return null;
    const verb = verbMatch[1].toLowerCase();
    // "enter in the name" / "fill into the box" — a connector glued to the verb
    // is part of the verb phrase, not a separator.
    const rest = cleanText.slice(verbMatch[0].length).replace(/^(?:in|into)\s+/i, '').trim();
    if (!rest) return null;

    const fieldFirstConnectors = TestCaseParser.FIELD_FIRST_CONNECTORS.filter(
      (c) => c !== 'to' || TestCaseParser.FIELD_FIRST_TO_VERBS.has(verb),
    );
    const valueFirstConnectors = TestCaseParser.VALUE_FIRST_CONNECTORS.filter(
      (c) => c !== 'to' || !TestCaseParser.FIELD_FIRST_TO_VERBS.has(verb),
    );

    // Value-first is tried before field-first so that "enter X into Y" keeps its
    // long-standing reading rather than being re-parsed by a newly added connector.
    const wordConnectors = valueFirstConnectors.map(esc).join('|');
    const valueFirst = rest.match(
      new RegExp(`^["']?(.+?)["']?\\s+(?:${wordConnectors})\\s+(?:the\\s+)?(?:input\\s+)?["']?([^"']+)["']?$`, 'i'),
    );
    if (valueFirst) {
      return {
        targetField: this.cleanTargetField(valueFirst[2]),
        value: valueFirst[1].trim(),
      };
    }

    // Field-first. Word connectors need surrounding spaces; symbol connectors
    // (= : -) do not, and must not swallow a hyphen inside a field name.
    const fieldFirstWords = fieldFirstConnectors.filter((c) => /^[a-z]+$/i.test(c));
    if (fieldFirstWords.length > 0) {
      const fieldFirst = rest.match(
        new RegExp(`^["']?(.+?)["']?\\s+(?:${fieldFirstWords.map(esc).join('|')})\\s+["']?(.+?)["']?$`, 'i'),
      );
      if (fieldFirst) {
        return {
          targetField: this.cleanTargetField(fieldFirst[1]),
          value: fieldFirst[2].trim(),
        };
      }
    }

    const symbolSplit = rest.match(/^["']?([^"'=:]+?)["']?\s*[=:]\s*["']?(.+?)["']?$/);
    if (symbolSplit) {
      return {
        targetField: this.cleanTargetField(symbolSplit[1]),
        value: symbolSplit[2].trim(),
      };
    }
    // A hyphen only separates when it is spaced, so "e-mail" stays one field name.
    const dashSplit = rest.match(/^["']?(.+?)["']?\s+-\s+["']?(.+?)["']?$/);
    if (dashSplit) {
      return {
        targetField: this.cleanTargetField(dashSplit[1]),
        value: dashSplit[2].trim(),
      };
    }

    // No connector at all: the step named a field and stopped ("Enter workpod
    // name"). The field is known, the value is not — so it runs with a value
    // generated at execution time rather than being rejected as gibberish.
    const target = this.cleanTargetField(rest);
    if (!target) return null;
    return { targetField: target, autoValue: true };
  }

  /**
   * Explains why a step did not parse, and shows one that would.
   *
   * The old message told every failing step to "start with an action verb
   * (click, enter, select…)" regardless of what was wrong with it. For a step
   * reading "Enter workpod name" that advice is not merely unhelpful, it is
   * false — the step already starts with one of the listed verbs — and it sent
   * the reader looking at element discovery for a failure that happened before
   * the browser was ever involved. A wrong explanation costs more than none.
   */
  private diagnoseUnparsed(trimmed: string, cleanText: string): { warning: string; suggestion?: string } {
    const firstWord = (cleanText.match(/^([a-z]+)/i)?.[1] ?? '').toLowerCase();
    const known = new Set([
      ...TestCaseParser.FILL_VERBS,
      'click', 'press', 'tap', 'choose', 'select', 'check', 'tick', 'uncheck', 'untick',
      'navigate', 'go', 'goto', 'open', 'visit', 'load', 'browse', 'wait',
      'verify', 'assert', 'expect', 'confirm', 'ensure',
    ]);

    if (firstWord && known.has(firstWord)) {
      // The verb was understood; the rest of the sentence was not.
      return {
        warning:
          `Step could not be understood: "${trimmed}". The verb "${firstWord}" is supported, ` +
          `but what follows it does not name a target this runner can act on.`,
        suggestion:
          `Name the element, and a value if one is needed — for example ` +
          `\`${firstWord} "Field name" as "the text to type"\` or \`click "Button label"\`.`,
      };
    }

    return {
      warning:
        `Step could not be understood: "${trimmed}". "${firstWord || trimmed}" is not a recognised action.`,
      suggestion:
        `Start with an action (click, enter, select, check, navigate, wait) or an assertion ` +
        `(verify/assert/expect) — for example \`click "Save"\` or \`verify "Saved" is visible\`.`,
    };
  }

  /**
   * Wording that delegates the choice to the runner rather than naming an
   * option: "select any value", "pick a random option". Treated as "choose one
   * of whatever this control offers", because there is no option literally
   * called "any value" and searching for one would fail every time.
   */
  private static readonly ANY_OPTION =
    /^(?:any|some|random|whatever|first|the\s+first|a|an)(?:\s+(?:random|valid|available))?(?:\s+(?:value|option|item|entry|choice|one))?$/i;

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
      //
      // "open" is the ambiguous one: "open https://x.com/login" is navigation,
      // but "open the Intent dropdown" is a click on a control that happens to
      // share the verb. Treating the latter as navigation sent the browser off
      // to a made-up URL built out of the widget's name — a spectacular failure
      // with no relationship to anything the test was checking. So `open` only
      // navigates when what follows actually looks like somewhere to navigate to.
      let match = cleanText.match(/^(?:navigate\s+to|go\s+to|goto|visit|load|browse\s+to)\b/i);
      if (!match && /^open\b/i.test(cleanText)) {
        const afterOpen = cleanText.replace(/^open\s+/i, '').trim();
        const looksNavigable =
          /https?:\/\//i.test(afterOpen) ||
          /[a-z0-9-]+\.[a-z]{2,}(?:\/|$)/i.test(afterOpen) ||
          /^\//.test(afterOpen) ||
          /\bpage\b/i.test(afterOpen);
        if (looksNavigable) match = cleanText.match(/^open\b/i);
      }
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

      // 4. FILL — one grammar, generated from a verb set and a connector set.
      //
      // This used to be four hand-written regexes, each with its own verb list
      // and its own connector list. The gaps between them were invisible until a
      // test failed: `fill X with Y` worked but `enter X with Y` did not, `input`
      // counted as a verb for credentials but not for fields, `set X to Y` was
      // not a fill at all. None of that was a decision anyone made — it was four
      // patterns drifting apart. Deriving every combination from two lists means
      // a phrasing is supported because it is in the grammar, not because
      // somebody remembered to write a fifth regex.
      const fill = this.matchFill(cleanText);
      if (fill) {
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'fill',
          targetField: fill.targetField,
          ...(fill.autoValue ? { autoValue: true } : { value: fill.value }),
        });
        return;
      }

      // 5. SELECT FROM A DROPDOWN — before the click rule, because "choose" is
      // both a click verb and a select verb and the select reading is more
      // specific. Ordered the other way round, "choose Private from Visibility"
      // became a click on an element called "Private from Visibility".
      //
      // Note none of these decide whether the control is a real <select>: the
      // runner inspects the resolved element and drives it accordingly, so a
      // div-based Angular/MUI dropdown works from the same wording.

      // 5a. An explicitly named option: "select Private from Visibility".
      match = cleanText.match(/^(?:select|choose|pick|set)\s+["']?([^"']+?)["']?\s+(?:from|in|for|on)\s+(?:the\s+)?(?:dropdown\s+)?["']?([^"']+)["']?$/i);
      if (match) {
        const optionText = match[1].trim();
        const target = this.cleanTargetField(match[2]);
        // "any value" / "a random option" is the author explicitly delegating
        // the choice, not naming an option literally called "any value".
        const delegated = TestCaseParser.ANY_OPTION.test(optionText);
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'select',
          targetField: target,
          ...(delegated ? { autoValue: true } : { value: optionText }),
        });
        return;
      }

      // 5b. "Open the Intent dropdown and select any value" — one sentence that
      // opens a control and picks from it. Both halves name the same dropdown,
      // so it is a single select, not two steps.
      match = cleanText.match(
        /^(?:open|expand|click(?:\s+on)?)\s+(?:the\s+)?["']?(.+?)["']?\s*(?:dropdown|list|menu|select)?\s*(?:,|and|then|&)\s*(?:select|choose|pick)\s+(.+)$/i,
      );
      if (match) {
        const optionText = match[2].trim();
        const delegated = TestCaseParser.ANY_OPTION.test(optionText);
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'select',
          targetField: this.cleanTargetField(match[1]),
          ...(delegated ? { autoValue: true } : { value: optionText.replace(/^["']|["']$/g, '') }),
        });
        return;
      }

      // 5c. "Select visibility" / "Choose a domain type" — the control is named,
      // the option is not, so the runner picks one of its own options.
      match = cleanText.match(/^(?:select|choose|pick)\s+(?:an?\s+|the\s+)?["']?([^"']+?)["']?(?:\s+(?:dropdown|list|menu|option|value))?$/i);
      if (match) {
        const target = this.cleanTargetField(match[1]);
        if (target) {
          parsedSteps.push({
            stepIndex,
            rawText: trimmed,
            type: 'action',
            action: 'select',
            targetField: target,
            autoValue: true,
          });
          return;
        }
      }

      // 6. CLICK ELEMENT
      // The whole phrase after the verb is the target. Filler words are stripped
      // separately rather than inside the capture — matching "on"/"the" as part of
      // the pattern made 'Click on the "Save" button' resolve to the word "the".
      //
      // The verb list is deliberately wide. Which of these words a tester reaches
      // for carries no information about the application, so rejecting a step for
      // saying "hit" instead of "click" fails a test over vocabulary.
      match = cleanText.match(
        /^(?:click|press|tap|hit|push|toggle|activate|expand|collapse|open|add|invite|upload|submit)\s+(?:on\s+)?(?:the\s+)?(.+)$/i,
      );
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

      // 6b. A bare verb that is unmistakably a click on a control of that name
      // ("Add members", "Submit", "Cancel"). The element still has to be found
      // with real confidence at run time, so a wrong guess cannot silently click
      // something unrelated — it fails with "element not found" instead.
      match = cleanText.match(/^(add|submit|cancel|save|continue|next|back|close|logout|log\s*out|sign\s*out)(.*)$/i);
      if (match) {
        const rest = match[2].trim();
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'action',
          action: 'click',
          targetField: this.cleanTargetField(rest ? `${match[1]} ${rest}` : match[1]),
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
        const diagnosis = this.diagnoseUnparsed(trimmed, cleanText);
        parsedSteps.push({
          stepIndex,
          rawText: trimmed,
          type: 'unparsed',
          targetField: '',
          parseWarning: diagnosis.warning,
          parseSuggestion: diagnosis.suggestion,
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
