# Phase 0 — Playwright MCP Spike: Verdict

**Date:** 2026-08-30
**Question:** Can Playwright MCP drive the runner's own browser, so hybrid mode keeps one authenticated session and the existing evidence pipeline keeps working?

## Verdict: **YES on all three criteria — proceed with MCP.**

| # | Exit criterion | Result |
|---|---|---|
| 1 | Same browser, same session | ✅ **YES** |
| 2 | Video + screenshots + console/network intact | ✅ **YES** |
| 3 | Concrete locators recoverable per action | ✅ **YES — better than hoped** |

**The fallback (`browserTools.ts` in-process tool layer) is not needed.** MCP `0.0.79`, MCP SDK, and the spike code are the basis for Phase A1.

---

## The route is better than the plan assumed — no CDP needed

The plan proposed launching Chromium with `--remote-debugging-port` and attaching MCP via `--cdp-endpoint`, flagged as the main project risk. **That is unnecessary.** `@playwright/mcp` exports a programmatic API:

```ts
// node_modules/@playwright/mcp/index.d.ts
export declare function createConnection(
  config?: Config,
  contextGetter?: () => Promise<BrowserContext>,   // ← we hand it OUR context
): Promise<Server>;
```

So MCP runs **in-process, inside the Next.js server, on the exact `BrowserContext` the runner created** — the one with `recordVideo`, the primed login session, and the `LogManager` listeners already attached. No second browser, no CDP, no spawned subprocess, no port management.

```ts
const server = await createConnection({ codegen: 'typescript' }, async () => context);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
```

This removes the single largest risk in the plan and deletes tasks 0.1/0.2 (`--remote-debugging-port`, CDP wiring) entirely.

## Criterion 1 — same browser, same session

The runner created the page, rendered content into it via `setContent`, and set `window.__SESSION_TOKEN__`. MCP's `browser_snapshot` returned **our** page:

```yaml
- heading "Spike App" [level=1] [ref=e2]
- textbox "Email address" [ref=e4]
- button "Sign in" [ref=e6]
```

The session token was still intact afterwards. **Interleaving was verified in both directions** across a real HTTP navigation:

| Step | Executed by | Result |
|---|---|---|
| 1 | deterministic (`page.fill`) | — |
| 2 | AI via MCP | ✅ snapshot **saw step 1's typed value** |
| 3 | deterministic (`page.inputValue`, `page.click`) | ✅ **saw step 2's AI-typed value**; navigated |
| 4 | AI via MCP | ✅ **followed the navigation**, asserted on page 2 |

This is exactly the handoff hybrid mode (A1.4) needs, and it works in both directions.

## Criterion 2 — evidence intact

All capture ran against the runner's own `Page`/`BrowserContext`, unchanged from today's code:

| Evidence | Mechanism | Result |
|---|---|---|
| Screenshot | `page.screenshot()` (`ScreenshotManager`) | ✅ 10,202 bytes |
| DOM snapshot | `page.content()` (`DomSnapshotManager`) | ✅ reflects MCP's action |
| Console | `page.on('console')` (`LogManager`) | ✅ caught a log fired by an **MCP-driven click** |
| Video | `context.recordVideo` → `page.video().path()` | ✅ `.webm` written on context close |
| Network | `page.on('response')` | ✅ captured an **MCP-triggered `POST /api/thing` → 500** |

That last one matters beyond evidence: it is the signal `classifyFailure()` reads as `hasServerError` to decide `product-defect` vs `automation-gap`. **The classifier keeps working on AI-executed steps.**

> One negative result, not a blocker: MCP's *own* `browser_network_requests` tool did **not** list our pre-attach navigation. Irrelevant — we use our own `page.on('response')` capture (`playwrightRunner.ts:1516`), which A2.2 extends with request/response bodies. Do not use MCP's network/console tools; ours are authoritative and already wired into the report.

## Criterion 3 — locators recoverable

Better than the plan hoped. With `codegen: 'typescript'`, **every tool call returns the exact Playwright code it ran**:

```js
await page.getByRole('textbox', { name: 'Email address' }).fill('qa@example.com');
await page.getByRole('button', { name: 'Sign in' }).click();
```

These are **semantic role-based locators** — precisely what B2.4 specified ("prefer `getByRole`/`getByLabel`/`getByPlaceholder`/`getByTestId` over CSS"). MCP does the recording work for us.

**Consequence:** `actionRecorder.ts` (A1) shrinks to parsing the ` ```js ` block out of each tool result and tagging it with the step index. A mixed trail generates cleanly:

```
1. [deterministic] await page.fill('#email', 'qa@example.com');
2. [ai]            await page.getByRole('textbox', { name: 'Password' }).fill('Secret123');
3. [deterministic] await page.click('#go');
```

Note the AI-produced line is the *better* locator. Worth considering later: let the AI re-record deterministic steps to upgrade CSS selectors to semantic ones.

## Tool surface (MCP 0.0.79 — 24 tools)

`browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_find`, `browser_select_option`, `browser_press_key`, `browser_hover`, `browser_drag`, `browser_drop`, `browser_navigate`, `browser_navigate_back`, `browser_evaluate`, `browser_wait_for`, `browser_take_screenshot`, `browser_file_upload`, `browser_handle_dialog`, `browser_tabs`, `browser_resize`, `browser_close`, `browser_console_messages`, `browser_network_requests`, `browser_network_request`, `browser_run_code_unsafe`

**Schema note — the plan's assumed shapes were wrong.** Actual: `{ element?: string, target: string, ... }` where `target` is a snapshot ref (`e4`) *or* a unique selector. There is no `ref` parameter. Also `browser_find` is a cheap targeted search that returns refs without a full snapshot — **use it to cut tokens** instead of always calling `browser_snapshot`.

Tools to **not** expose to the agent: `browser_run_code_unsafe` (arbitrary code execution), `browser_close` (would kill the runner's context mid-run), `browser_tabs` (until multi-tab is designed). `browser_evaluate` needs a decision — powerful, but lets the agent bypass the UI and "pass" a test without exercising the app.

## Risks found, to carry into A1

1. **Playwright version skew.** The project uses `@playwright/test@1.60.0`; `@playwright/mcp@0.0.79` bundles `playwright@1.63.0-alpha-2026-08-05`. A context created by 1.60.0 was accepted by MCP's 1.63.0-alpha **and worked** — but this is unsupported territory. **Pin both exactly**, and re-run this spike on any bump of either.
2. **MCP writes to `.playwright-mcp/`** in cwd (snapshots, console logs). Set `outputDir` to the run's evidence directory and gitignore the default, or artifacts scatter into the repo root.
3. **`about:blank` pages** report `Page URL: about:blank` in snapshots — harmless for `setContent`-based tests, but the agent's prompt should rely on the snapshot tree, not the URL line, for orientation.
4. **MCP is pre-1.0** (`0.0.79`) with a schema that has already changed shape. Wrap it behind our own thin adapter interface so a breaking bump is a one-file change, not a refactor. This preserves the plan's original intent of keeping the transport swappable.

## Plan changes

- **Delete** tasks 0.1 and 0.2 (CDP wiring) — obsolete.
- **Delete** the `browserTools.ts` fallback — not needed.
- **A1.3** — use MCP's real tool names/schemas above rather than the invented `click`/`fill`/`select` set.
- **A1 (`actionRecorder.ts`)** — reduced to extracting the emitted ` ```js ` code block per tool call.
- **B2.4** — semantic locators come free from MCP codegen; the generator's job is assembly and env-substitution, not locator synthesis.
- **New A1.0** — thin adapter wrapping `createConnection` + `InMemoryTransport`, exposing snapshot/act/find to `agentExecutor`, with the unsafe tools filtered out.

**Net effect: Phase 0's risk is closed, and roughly a week of A1/B2.4 work is removed.**

## Dependencies added

```
@playwright/mcp@0.0.79          (devDependency — promote to dependency in A1)
@modelcontextprotocol/sdk       (devDependency — promote to dependency in A1)
```

Spike scripts were temporary and have been deleted; every claim above is reproducible from the code shown here.
