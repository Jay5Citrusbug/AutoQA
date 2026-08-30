import { test, expect } from '@playwright/test';
import { extractPlaywrightCode } from '@/core/ai/mcpAdapter';

/**
 * The extracted code IS the regression script. If this parsing silently returns
 * undefined, runs still pass and the generated spec quietly loses steps — so the
 * shapes MCP actually emits are pinned here.
 */
test.describe('extractPlaywrightCode — recovering the executed statement', () => {
  test('pulls the statement out of a real MCP acting response', () => {
    const response = [
      '### Ran Playwright code',
      '```js',
      "await page.getByRole('button', { name: 'Sign in' }).click();",
      '```',
      '### Page',
      '- Page URL: https://app.example.com/login',
      '### Snapshot',
      '```yaml',
      '- heading "Dashboard" [level=1] [ref=e1]',
      '```',
    ].join('\n');

    // The response carries two fenced blocks; only the executed code is the trail.
    expect(extractPlaywrightCode(response)).toBe(
      "await page.getByRole('button', { name: 'Sign in' }).click();",
    );
  });

  test('keeps a multi-line statement intact', () => {
    const response = [
      '### Ran Playwright code',
      '```js',
      "await page.getByRole('textbox', { name: 'Email' }).fill('qa@example.com');",
      "await page.getByRole('button', { name: 'Next' }).click();",
      '```',
    ].join('\n');

    expect(extractPlaywrightCode(response)).toBe(
      "await page.getByRole('textbox', { name: 'Email' }).fill('qa@example.com');\n" +
        "await page.getByRole('button', { name: 'Next' }).click();",
    );
  });

  test('accepts the other fence languages MCP can emit', () => {
    for (const lang of ['js', 'javascript', 'ts', 'typescript', '']) {
      const text = `### Ran Playwright code\n\`\`\`${lang}\nawait page.goto('https://x.com');\n\`\`\``;
      expect(extractPlaywrightCode(text), `fence: "${lang}"`).toBe(
        "await page.goto('https://x.com');",
      );
    }
  });

  test('returns undefined for a read-only response that ran no code', () => {
    const snapshot = [
      '### Page',
      '- Page URL: https://app.example.com/login',
      '### Snapshot',
      '```yaml',
      '- textbox "Email address" [ref=e4]',
      '```',
    ].join('\n');

    // A yaml snapshot is not executable code and must never enter the trail.
    expect(extractPlaywrightCode(snapshot)).toBeUndefined();
  });

  test('returns undefined rather than an empty string for an empty block', () => {
    // An empty string is falsy but still a string; callers branch on undefined.
    expect(extractPlaywrightCode('### Ran Playwright code\n```js\n\n```')).toBeUndefined();
  });

  test('returns undefined when there is no code block at all', () => {
    expect(extractPlaywrightCode('### Error\nElement not found.')).toBeUndefined();
  });
});
