/**
 * mcpAdapter.ts — The only place in AutoQA that knows Playwright MCP exists.
 *
 * MCP drives THE RUNNER'S OWN BrowserContext, in-process. `createConnection`
 * accepts a context getter, so the agent acts on the very page the deterministic
 * engine just used: same session, same cookies, same `recordVideo`, same
 * `page.on('console')` / `page.on('response')` listeners. Nothing about the
 * existing evidence pipeline changes because nothing about the browser changes.
 * (Proved in docs/PHASE-0-VERDICT.md — no CDP, no second browser, no subprocess.)
 *
 * MCP is pre-1.0 and its tool schemas have already changed shape once, so every
 * MCP type stays behind this file. A breaking bump is a change here, not a
 * refactor of the agent loop.
 */
import type { BrowserContext } from '@playwright/test';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { logger } from '@/utils/logger';

/** The BrowserContext type as MCP's own bundled playwright-core declares it. */
type McpBrowserContext =
  NonNullable<Parameters<typeof createConnection>[1]> extends () => Promise<infer C> ? C : never;

/**
 * Tools the agent must never be given.
 *
 * `browser_run_code_unsafe` executes arbitrary code in the Node process.
 * `browser_close` would tear down the context the runner is still using — and
 * with it the video recording and every remaining test case in the suite.
 * `browser_evaluate` can reach into the page and fabricate the very state the
 * test is supposed to be checking; a step that "passes" because the agent set
 * the success text itself is worse than no test at all.
 * `browser_install` shells out to a browser installer at run time.
 *
 * Tabs are withheld until multi-tab execution is designed — the runner assumes
 * one page per suite, and an agent that opens a tab would silently strand the
 * evidence listeners on the old one.
 */
const DENIED_TOOLS = new Set([
  'browser_run_code_unsafe',
  'browser_close',
  'browser_evaluate',
  'browser_install',
  'browser_tabs',
]);

/**
 * Tools whose job AutoQA already does better, and which would cost tokens to
 * duplicate. Our own `page.on('response')` / `page.on('console')` capture
 * predates the agent, feeds the report and the failure classifier, and — unlike
 * MCP's — covers the whole run rather than the window MCP was attached for.
 */
const REDUNDANT_TOOLS = new Set([
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_take_screenshot', // ScreenshotManager owns evidence capture
]);

export interface McpToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, passed straight to the model. */
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  /** Flattened text of the tool response — what the model sees. */
  text: string;
  /**
   * The Playwright code MCP actually ran for this call, e.g.
   * `await page.getByRole('button', { name: 'Sign in' }).click();`
   *
   * This is the recording that becomes a generated spec. Present for acting
   * tools; absent for read-only ones like snapshot.
   */
  code?: string;
  isError: boolean;
}

export interface McpSessionOptions {
  /**
   * Where MCP writes its own artifacts (snapshot .yml, console .log). Defaults
   * to cwd, which scatters files into the repo root — always pass the run's
   * evidence directory.
   */
  outputDir: string;
  /** Per-action timeout. Should match the runner's step timeout. */
  actionTimeoutMs?: number;
  /** How long MCP waits after each action for navigations/requests to settle. */
  settleTimeoutMs?: number;
  /** Origins the agent is allowed to reach. Omit for no restriction. */
  allowedOrigins?: string[];
}

/**
 * A live MCP session bound to one BrowserContext.
 *
 * Lifetime is one test case: `attach` after the context exists, `close` before
 * the context does.
 */
export class McpBrowserSession {
  private constructor(
    private readonly client: Client,
    private readonly tools: McpToolDefinition[],
  ) {}

  /** Opens an in-process MCP session over an existing context. */
  public static async attach(
    context: BrowserContext,
    options: McpSessionOptions,
  ): Promise<McpBrowserSession> {
    const server = await createConnection(
      {
        // Makes every acting tool return the Playwright code it ran — the
        // recording that Track B turns into a regression spec.
        codegen: 'typescript',
        outputDir: options.outputDir,
        timeouts: {
          action: options.actionTimeoutMs ?? 15_000,
          settle: options.settleTimeoutMs ?? 500,
        },
        ...(options.allowedOrigins ? { network: { allowedOrigins: options.allowedOrigins } } : {}),
      },
      // Version skew, contained to this line. The project pins
      // @playwright/test 1.60.0; @playwright/mcp 0.0.79 bundles
      // playwright-core 1.63.0-alpha, whose BrowserContext declares a
      // `credentials` property 1.60.0 does not have — so the two types are
      // structurally incompatible even though the objects are interchangeable.
      // MCP never reads `credentials` (verified: no call site in its bundle),
      // and the Phase 0 spike drove a 1.60.0 context through MCP end to end.
      // Both packages are pinned exactly; re-run the spike before bumping
      // either, and delete this cast once the versions line up.
      async () => context as unknown as McpBrowserContext,
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'autoqa', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const all = (await client.listTools()).tools;
    const tools = all
      .filter((t) => !DENIED_TOOLS.has(t.name) && !REDUNDANT_TOOLS.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));

    const withheld = all.length - tools.length;
    logger.info(`MCP session attached: ${tools.length} tools exposed, ${withheld} withheld`);

    return new McpBrowserSession(client, tools);
  }

  /** Tool definitions to hand the model. Denied/redundant tools are already gone. */
  public getTools(): McpToolDefinition[] {
    return this.tools;
  }

  /**
   * Invokes a tool.
   *
   * A tool the model was never offered is refused here rather than forwarded:
   * models do occasionally invent a plausible name, and `browser_close` arriving
   * from a hallucination would end the run.
   */
  public async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (DENIED_TOOLS.has(name) || REDUNDANT_TOOLS.has(name)) {
      return { text: `Tool "${name}" is not available.`, isError: true };
    }
    if (!this.tools.some((t) => t.name === name)) {
      return {
        text: `Unknown tool "${name}". Available: ${this.tools.map((t) => t.name).join(', ')}`,
        isError: true,
      };
    }

    try {
      const res = await this.client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text?: string }> | undefined ?? [])
        .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
        .join('\n');
      // MCP reports tool-level failures in-band (`### Error`), not by throwing.
      const isError = res.isError === true || /^###\s+Error/m.test(text);
      return { text, code: extractPlaywrightCode(text), isError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`MCP tool "${name}" threw`, err);
      return { text: `Tool "${name}" failed: ${message}`, isError: true };
    }
  }

  /** Ends the session. Safe to call twice; never closes the browser context. */
  public async close(): Promise<void> {
    try {
      await this.client.close();
    } catch (err) {
      // A failed teardown must not fail the test case that already produced its verdict.
      logger.warn('MCP session close failed (ignored)', err);
    }
  }
}

/**
 * Pulls the executed Playwright statement out of an MCP tool response, which
 * wraps it as:
 *
 *     ### Ran Playwright code
 *     ```js
 *     await page.getByRole('button', { name: 'Sign in' }).click();
 *     ```
 *
 * Exported for the action recorder's tests.
 */
export function extractPlaywrightCode(text: string): string | undefined {
  const block = text.match(/```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/);
  const code = block?.[1]?.trim();
  return code ? code : undefined;
}
