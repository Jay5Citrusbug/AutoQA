# AutoQA — Production Readiness & AI Agent Plan

**Vision:** A platform where QA writes test cases in natural language (title, steps, expected results), an AI agent executes them adaptively in a real browser — the way a manual tester would — and every successful run records a verified, deterministic Playwright script that regression runs replay cheaply. When a replay breaks, the AI re-executes from intent and either files a bug or heals the script.

**Execution model (target):**

```
Test Case (natural language)
        │
        ▼
  ┌───────────────┐   fast path    ┌──────────────────────┐
  │ Script exists? ├──────yes─────▶│ Deterministic replay │──pass──▶ Report
  └──────┬────────┘                └─────────┬────────────┘
         no                                  fail
         │                                   │
         ▼                                   ▼
  ┌─────────────────────────────────────────────────┐
  │ AI Executor (LLM + Playwright tools)            │
  │ observe page → decide action → act → verify     │
  └──────┬──────────────────────────────────────────┘
         │ records actual locators + actions
         ▼
  ┌──────────────────────┐
  │ Script Generator      │──▶ re-run headless to VERIFY ──▶ save to library
  └──────────────────────┘         │
                                   ▼
                     verdict: real bug → Jira module
                     UI change → healed script + diff for review
```

---

## Phase 0 — Security & Hygiene (1–2 days) ✅ COMPLETED 2026-07-18
> Done: credentials moved to `.env` (`QA_VALID_*`), `{{var}}` step substitution added (`src/utils/testData.ts`),
> generated specs emit `process.env.*` instead of secrets, fake stages/log banners removed,
> unused deps removed, artifact files untracked from git, `Architecture` → `docs/architecture.md`.
> ⚠️ Outstanding (user action): rotate the leaked `Jayqa@1234` password; scrub git history before sharing the repo.

| # | Task | Where |
|---|------|-------|
| 0.1 | Remove hardcoded credentials (`jay.r@optevo.com` / password) from the runner. Replace with env-driven test data; rotate the leaked password; scrub git history if repo is ever shared (BFG / git-filter-repo). | `src/core/execution/playwrightRunner.ts:420` |
| 0.2 | Introduce variable substitution in steps: `Enter {{qa_user}} into email` resolved from a per-project environment config (secrets in `.env`, later encrypted DB). | parser + runner |
| 0.3 | Remove fabricated data: fake `stages` timings in the run-test response, fake `NODE_VERSION` log banner. Report only real measured values. | `src/app/api/run-test/route.ts:80-96`, `playwrightRunner.ts:164-169` |
| 0.4 | Dependency cleanup: drop unused `express`, `cors`, `nodemon`; resolve `report-bug-tracker` duplication (keep either `file:../` dep or `src/lib` copy, not both). | `package.json` |
| 0.5 | Repo hygiene: delete typo'd `Archituecture/` folder, move `Architecture` file into `docs/`, add generated artifacts (`generated-tests/`, `reports/`, `videos/`, `screenshots/`, `public/generated-tests` etc.) to `.gitignore`. | root |

**Acceptance:** no secrets in source; a run against a fresh app works using env-configured credentials; API responses contain only real data.

---

## Phase 1 — Engine Stabilization ✅ COMPLETED 2026-07-18
> Done: parser URL extraction fixed; unparsed steps no longer blind-click (runtime fails clearly + save-time
> warning); generated specs use `.first()`, valid `goto`, env-substituted secrets, escaping, no bare `button`
> guesses; validator scopes success/error checks to visible alert regions; real cancel force-closes browsers
> via a typed run registry; discovery probes candidates in parallel and throws `ElementNotFoundError` instead
> of a fabricated selector; opt-in script verifier (`verifyScript`) re-runs specs headless; 18 parser/generator
> unit tests + GitHub Actions CI (typecheck + lint + test). Verified end-to-end: happy-path login passes 5/5;
> unknown step → clear failure; missing element → "Element not found (confidence 0%, need 35%)".

Make the current deterministic engine honest and reliable — it remains the fast-path replay engine forever, so this work is not throwaway.

| # | Task | Detail |
|---|------|--------|
| 1.1 | **Fix parser URL extraction.** "open Login page - https://x.com/login" must parse the URL, not the whole phrase. Extract `https?://\S+` first; label is metadata. | `testCaseParser.ts` rule 1 |
| 1.2 | **Stop silent fallback-to-click.** Unrecognized step → mark step `unparsed`, warn in UI at save time ("step 3 not understood — rephrase or run in AI mode"), never blindly click. | parser + editor UI |
| 1.3 | **Fix generated scripts.** Always emit `.first()` (or better: role-based locators), escape quotes/backslashes properly, valid `goto` URLs, never emit bare `page.locator('button')`. | `playwrightGenerator.ts` |
| 1.4 | **Verify generated scripts before saving:** immediately re-run each generated spec headless (`npx playwright test <file>`); store pass/fail status with the script; surface unverified scripts in UI. | new `scriptVerifier.ts` |
| 1.5 | **Real validation semantics.** `error_msg`/`success_msg` must target visible alert/toast/role="alert" regions near the action, not full-body substring search. Element-scoped `toContainText` in generated code too. | `validator.ts` |
| 1.6 | **Real cancel.** On abort: `browser.close()` immediately (keep a handle registry per runId), don't just flag between steps. | `playwrightRunner.ts` |
| 1.7 | **Discovery performance.** Probe candidate selectors concurrently (or one `page.evaluate` batch) instead of serial 800 ms `isVisible` checks; fail with a clear "element not found: <target>" error instead of returning a score-5 generic selector that clicks the wrong thing. | `elementDiscovery.ts` |
| 1.8 | **Error handling & types.** Remove empty `catch {}` blocks (log at minimum); type `browser/context/page` properly instead of `any`. | runner, discovery |
| 1.9 | **Tests + CI.** Unit tests for parser (a corpus of real step phrasings → expected ParsedStep) and generator (steps → compilable spec); wire `npm test` + lint into GitHub Actions. | `tests/`, `.github/` |

**Acceptance:** every saved test case either parses cleanly or warns; every generated script has a verified-green badge; parser test corpus ≥ 50 phrasings passing.

---

## Phase 2 — AI Executor (2–3 weeks) ⭐ the core of the vision

Replace regex-as-brain with an LLM agent loop. This is what makes the platform "smart like the Claude extension."

### 2.1 Agent loop architecture

New module `src/core/ai/agentExecutor.ts`:

1. Build context: test case title, steps, expected results, current URL.
2. **Observe:** capture page state via Playwright's accessibility snapshot (`page.locator('body').ariaSnapshot()` / `page.accessibility.snapshot()`) — compact, element-ref-addressable, far cheaper than raw HTML.
3. **Decide:** call Claude (tool-use loop) with tools:
   - `click(ref)`, `fill(ref, text)`, `select(ref, value)`, `press(key)`, `navigate(url)`, `scroll(direction)`
   - `assert(description)` → returns pass/fail + evidence
   - `report_step_result(stepIndex, status, reasoning)`
4. **Act:** execute the chosen tool via Playwright, re-snapshot, loop until all steps are done or the agent declares failure.
5. Record every executed action + the concrete locator used (for Phase 3).

Options (decide at start of phase):
- **Build on Playwright MCP** (`@playwright/mcp`) + Claude Agent SDK — least code, battle-tested snapshot/act tools.
- **Direct Anthropic API tool-use loop** — more control over cost, prompts, and recording hooks. *(Recommended: recording hooks are central to the product.)*

### 2.2 Supporting work

| # | Task |
|---|------|
| 2.2.1 | Prompting: system prompt encoding QA semantics — each step gets a verdict, expected-vs-actual comparison drives pass/fail, screenshots on every step. |
| 2.2.2 | Cost & safety guards: max turns per test case, token budget per run, per-step timeout, allowed-domain list so the agent can't wander off-site. |
| 2.2.3 | Execution mode selector in UI: **Deterministic** (current engine) / **AI Agent** / **Auto** (deterministic first, AI fallback on failure). |
| 2.2.4 | Per-step result mapping: agent verdicts flow into the existing `StepExecutionResult` shape so reports/history/UI work unchanged. |
| 2.2.5 | Hybrid escalation: keep the discovery engine as a cheap first pass; invoke the LLM only when confidence < threshold or a step fails (controls cost). |

**Acceptance:** a test case written in loose natural language ("login with valid user, make sure dashboard shows the Optevo logo and left menu") executes correctly on stage.optevo.com **and** on an app it has never seen, with per-step verdicts + screenshots, no phrasing tweaks needed.

---

## Phase 3 — Recorder & Verified Script Library (1–2 weeks)

| # | Task |
|---|------|
| 3.1 | Action recorder: every AI-executed action logs `{step, action, locator, value, url}` — prefer semantic locators (`getByRole`, `getByLabel`, `getByPlaceholder`, `getByTestId`) captured from the accessibility snapshot. |
| 3.2 | Generate spec from the *recorded* trail (not parsed guesses); include element-scoped assertions the agent actually verified. |
| 3.3 | Auto-verify: run the generated spec headless immediately; only verified-green scripts enter the library. |
| 3.4 | Script library: scripts become first-class entities linked to their test case (versioned: v1, v2…), with status (verified / stale / broken), diff view between versions. |
| 3.5 | Regression runner: select N test cases → replays their verified scripts in parallel via `npx playwright test` with JSON reporter → results ingest into existing reports. |

**Acceptance:** AI run → script appears in library with green "verified" badge → regression replay of that script passes headless with zero AI tokens spent.

---

## Phase 4 — Self-Healing Regression (≈2 weeks)

| # | Task |
|---|------|
| 4.1 | On replay failure, capture failure context (error, screenshot, DOM snapshot at failure point). |
| 4.2 | AI triage: re-execute the test case from natural-language intent. Both fail → **likely real bug**; AI passes where script failed → **UI changed, heal the script**. |
| 4.3 | Healing flow: regenerate script from the new recorded trail, auto-verify, save as new version with a human-readable diff ("login button locator changed from #btn-login to getByRole('button', {name:'Sign in'})"), flag for review. |
| 4.4 | Bug flow: feed failure evidence into the existing `report-bug-tracker` module → auto-draft Jira ticket with screenshots, video, network log, console errors. |

**Acceptance:** rename a button on a test app → regression fails → platform heals the script automatically and shows the diff; break the login flow → platform files a Jira draft instead.

---

## Phase 5 — Production Infrastructure (2–3 weeks, can run in parallel from Phase 1)

| # | Task | Replaces |
|---|------|----------|
| 5.1 | **Database** (SQLite via Prisma to start; Postgres-ready): projects, test cases, suites, runs, step results, scripts, artifacts, settings. | `reports/*.json`, `globalThis` state |
| 5.2 | **Async job model:** `POST /api/runs` returns runId instantly; a worker (BullMQ + Redis, or a simple DB-backed queue to start) executes; global concurrency cap on browser instances. | 10-minute blocking HTTP request |
| 5.3 | **Live progress via SSE** (`/api/runs/:id/events`) replacing setInterval polling; reconnect-safe. | `activeLogs` on `globalThis` |
| 5.4 | **Artifact storage:** screenshots/videos/reports served through an API route from a data dir (or S3), with retention policy (e.g., 30 days / last N runs). Fixes the `public/`-at-runtime problem that breaks in `next build`. | writing into `public/` |
| 5.5 | **Auth & multi-user:** NextAuth (or SSO) + per-project membership; audit trail of who ran what. | open endpoints |
| 5.6 | **SSRF guard:** URL allowlist per project; block internal/private address ranges. | arbitrary `goto` |
| 5.7 | **Scheduling & CI hook:** cron-scheduled regression suites + a CLI/webhook (`POST /api/runs` with API key) so CI pipelines can trigger runs and receive pass/fail. | manual-only runs |
| 5.8 | **Docker hardening:** multi-stage build with Playwright browsers baked in, healthcheck, resource limits. | current Dockerfile |

**Acceptance:** two users run suites concurrently on a deployed instance; server restart mid-run marks the run as interrupted (not lost); artifacts auto-expire; CI can trigger a regression suite and gate a deploy on the result.

---

## Suggested sequence & rough timeline

| Week | Track A (product) | Track B (infra, parallel) |
|------|-------------------|---------------------------|
| 1 | Phase 0 + start Phase 1 | DB schema design (5.1) |
| 2 | Finish Phase 1 | DB migration + job model (5.2) |
| 3–4 | Phase 2 AI executor | SSE progress (5.3) |
| 5 | Phase 3 recorder + library | Artifact storage (5.4) |
| 6 | Phase 4 self-healing | Auth (5.5), SSRF (5.6) |
| 7 | Hardening, E2E dogfooding | Scheduling/CI (5.7), Docker (5.8) |

**Total: ~7 weeks to a production-credible v1** (single developer + AI assistance; compresses significantly with help).

## Decisions to make early

1. **AI integration route:** direct Anthropic tool-use loop (recommended — full control over recording hooks) vs. Playwright MCP + Agent SDK (fastest start).
2. **Cost posture:** AI on first run + failures only (recommended hybrid) vs. AI on every run.
3. **Storage:** SQLite-first (zero-ops, single box) vs. Postgres-from-day-1 (if multi-instance hosting is near-term).
4. **Where regression runs execute:** same server vs. dedicated worker container (matters for browser resource isolation).
