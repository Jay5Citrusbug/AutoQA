import { test, expect, chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { McpBrowserSession } from '@/core/ai/mcpAdapter';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * The Phase 0 spike, kept as a test.
 *
 * These assertions are the load-bearing claims behind the whole AI executor:
 * MCP drives the runner's own context, the evidence pipeline keeps working, and
 * every action reports the Playwright code it ran. They also guard the known
 * version skew — the project pins @playwright/test 1.60.0 while @playwright/mcp
 * bundles playwright-core 1.63.0-alpha. If a version bump breaks that pairing,
 * it breaks here rather than silently in production.
 *
 * See docs/PHASE-0-VERDICT.md.
 */

const LOGIN_PAGE = `<!doctype html><html><body>
  <h1>Login</h1>
  <label for="email">Email address</label><input id="email" name="email"/>
  <label for="pw">Password</label><input id="pw" name="pw" type="password"/>
  <button id="go">Sign in</button>
  <script>
    document.getElementById('go').onclick = () => {
      console.log('AUTOQA_TEST_MARKER: sign-in clicked');
      fetch('/api/session', { method: 'POST' });
      location.href = '/dashboard?u=' + encodeURIComponent(document.getElementById('email').value);
    };
  </script>
</body></html>`;

const dashboardPage = (user: string) => `<!doctype html><html><body>
  <h1>Dashboard</h1>
  <nav aria-label="Main menu"><a href="#">Workpods</a></nav>
  <p id="who">Signed in as ${user}</p>
</body></html>`;

let server: http.Server;
let baseUrl: string;
let outputDir: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/session') {
      res.statusCode = 500; // a server error the runner's own capture must see
      res.end('{"error":"boom"}');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      url.pathname === '/dashboard' ? dashboardPage(url.searchParams.get('u') ?? '?') : LOGIN_PAGE,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqa-mcp-'));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(outputDir, { recursive: true, force: true });
});

/** Builds the browser/context/page the runner would, with its evidence listeners. */
async function makeRunnerContext(videoDir?: string) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext(
    videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } } : {},
  );
  const page = await context.newPage();

  // Mirrors LogManager.startListeners + the runner's response listener.
  const consoleLogs: string[] = [];
  const networkResponses: Array<{ url: string; status: number }> = [];
  page.on('console', (m) => consoleLogs.push(m.text()));
  page.on('response', (r) => networkResponses.push({ url: r.url(), status: r.status() }));

  return { browser, context, page, consoleLogs, networkResponses };
}

/** Finds an element ref in an MCP snapshot, the way the agent executor will. */
function refFor(snapshot: string, label: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(label) && l.includes('[ref='));
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  expect(ref, `no ref found for "${label}" in snapshot:\n${snapshot}`).toBeTruthy();
  return ref as string;
}

test.describe('McpBrowserSession — MCP driving the runner\'s own context', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let session: McpBrowserSession;

  test.afterEach(async () => {
    await session?.close();
    await context?.close();
    await browser?.close();
  });

  test('withholds the tools that could end the run or fake a result', async () => {
    ({ browser, context, page } = await makeRunnerContext());
    session = await McpBrowserSession.attach(context, { outputDir });

    const names = session.getTools().map((t) => t.name);

    expect(names).toContain('browser_snapshot');
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_type');

    // Arbitrary code execution, killing the runner's context, and letting the
    // agent fabricate the state it is meant to be verifying.
    expect(names).not.toContain('browser_run_code_unsafe');
    expect(names).not.toContain('browser_close');
    expect(names).not.toContain('browser_evaluate');
    expect(names).not.toContain('browser_tabs');
  });

  test('refuses a withheld tool even when it is called directly', async () => {
    ({ browser, context, page } = await makeRunnerContext());
    session = await McpBrowserSession.attach(context, { outputDir });

    // A model can invent a tool name it was never offered; browser_close
    // arriving that way would tear down the context mid-run.
    const denied = await session.call('browser_close', {});
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('not available');
    expect(context.pages().length).toBeGreaterThan(0);

    const unknown = await session.call('browser_teleport', {});
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Unknown tool');
  });

  test('acts on the page the runner already navigated and authenticated', async () => {
    ({ browser, context, page } = await makeRunnerContext());
    await page.goto(baseUrl);
    await page.evaluate(() => ((window as unknown as Record<string, string>).__TOKEN__ = 'abc123'));
    session = await McpBrowserSession.attach(context, { outputDir });

    const snapshot = await session.call('browser_snapshot', {});
    expect(snapshot.isError).toBe(false);
    expect(snapshot.text).toContain('Email address');

    // The session the runner established is untouched by MCP attaching.
    const token = await page.evaluate(
      () => (window as unknown as Record<string, string>).__TOKEN__,
    );
    expect(token).toBe('abc123');
  });

  test('hands back the Playwright code it ran, using semantic locators', async () => {
    ({ browser, context, page } = await makeRunnerContext());
    await page.goto(baseUrl);
    session = await McpBrowserSession.attach(context, { outputDir });

    const snapshot = await session.call('browser_snapshot', {});
    const typed = await session.call('browser_type', {
      element: 'Email address textbox',
      target: refFor(snapshot.text, 'Email address'),
      text: 'qa@example.com',
    });

    expect(typed.isError).toBe(false);
    // This string is what becomes a line of the generated regression spec.
    expect(typed.code).toBe(
      "await page.getByRole('textbox', { name: 'Email address' }).fill('qa@example.com');",
    );
    // Read-only tools ran no code, so they must not contribute to the trail.
    expect(snapshot.code).toBeUndefined();
  });

  test('interleaves with the deterministic engine in both directions', async () => {
    ({ browser, context, page } = await makeRunnerContext());
    await page.goto(baseUrl);
    session = await McpBrowserSession.attach(context, { outputDir });

    // step 1 — deterministic
    await page.fill('#email', 'qa@example.com');

    // step 2 — AI, and it must see step 1's work
    const snap1 = await session.call('browser_snapshot', {});
    expect(snap1.text).toContain('qa@example.com');
    await session.call('browser_type', {
      element: 'Password textbox',
      target: refFor(snap1.text, 'Password'),
      text: 'Secret123',
    });

    // step 3 — deterministic again, and it must see step 2's work
    expect(await page.inputValue('#pw')).toBe('Secret123');
    await page.click('#go');
    await page.waitForURL(/dashboard/);

    // step 4 — AI follows the real navigation
    const snap2 = await session.call('browser_snapshot', {});
    expect(snap2.text).toContain('Dashboard');
    expect(snap2.text).toContain('qa@example.com');
  });

  test('leaves the evidence pipeline fully intact', async () => {
    const videoDir = path.join(outputDir, 'videos');
    const runner = await makeRunnerContext(videoDir);
    ({ browser, context, page } = runner);
    await page.goto(baseUrl);
    session = await McpBrowserSession.attach(context, { outputDir });

    const snapshot = await session.call('browser_snapshot', {});
    await session.call('browser_type', {
      element: 'Email address textbox',
      target: refFor(snapshot.text, 'Email address'),
      text: 'qa@example.com',
    });
    await session.call('browser_click', {
      element: 'Sign in button',
      target: refFor(snapshot.text, 'Sign in'),
    });
    await page.waitForURL(/dashboard/);

    // ScreenshotManager
    const shot = path.join(outputDir, 'shot.png');
    await page.screenshot({ path: shot });
    expect(fs.statSync(shot).size).toBeGreaterThan(0);

    // DomSnapshotManager — reflects what MCP did
    expect(await page.content()).toContain('Signed in as qa@example.com');

    // LogManager — a console message emitted by an MCP-driven click
    expect(runner.consoleLogs.some((l) => l.includes('AUTOQA_TEST_MARKER'))).toBe(true);

    // The runner's own network capture. This is not merely evidence: a 5xx here
    // is what classifyFailure() reads as hasServerError to call a failure a
    // product defect rather than an automation gap.
    expect(
      runner.networkResponses.some((r) => r.url.includes('/api/session') && r.status === 500),
    ).toBe(true);

    // Video is finalized on context close.
    const video = page.video();
    expect(video).not.toBeNull();
    await session.close();
    await context.close();
    const videoPath = await video!.path();
    expect(fs.existsSync(videoPath)).toBe(true);

    await browser.close();
    // Already torn down; stop afterEach from double-closing.
    context = undefined as unknown as BrowserContext;
    browser = undefined as unknown as Browser;
  });
});
