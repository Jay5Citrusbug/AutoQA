# AutoQA — Vision Alignment Review

**Date:** 2026-08-30
**Reviewed:** `d:\Automation\AutoQA` (`qa-login-agent` app + `smart-matcher`, `report-bug-tracker` siblings)
**Purpose:** Check whether the code as it stands today matches the stated product vision, and name the gaps worth closing next.

---

## 1. The vision, as I understand it

> Manual QA is slow. AutoQA should let a QA person hand over test cases — either as a **CSV/Excel import** or as **typed natural-language instructions** ("test the login page") — and have an **AI agent execute them in a real browser**, produce a **report**, and **generate reusable Playwright code automatically**. Those generated scripts then become **smoke and regression suites** that can be replayed cheaply, any time, without AI.

So the product is really **three products stacked**:

| Layer | What it does | Who it serves |
|---|---|---|
| **A. Intake** | Test cases in, from CSV/XLSX or free text | QA author |
| **B. Adaptive execution** | Understand intent → drive a browser → verdict + evidence | QA runner |
| **C. Codification** | Turn a successful run into verified Playwright code → suites → repeatable regression | Automation/CI |

That is a coherent and genuinely valuable product. **The vision is sound.** The question is only whether today's architecture gets there.

---

## 2. Where we actually stand

### What is built and real (this is a lot — don't discount it)

| Capability | Status | Evidence |
|---|---|---|
| CSV / XLSX / free-text intake | ✅ Working | `src/utils/fileImportParser.ts` (zero-dep CSV+XLSX, column aliasing, `exec_type`), `src/components/ImportFileModal.tsx` |
| Multi-test-case runs from one paste | ✅ Working | `parseTestSuites()`, `runTestSuites()` with parallel workers |
| Real browser execution | ✅ Working | `playwrightRunner.ts` (2,162 lines) — multi-browser, device modes, worker batching |
| Element discovery from natural wording | ✅ Working (heuristic) | `elementDiscovery.ts` + `scoring.ts` + `strategies.ts` — labels, aria, placeholder, sibling text, fuzzy, confidence threshold |
| Session reuse / login priming | ✅ Working | `sessionManager.ts`, `_planSessionReuse()`, `docs/session-reuse.md` |
| Pre-flight lint (fail before spending a browser) | ✅ Working | `stepLinter.ts` + 422 gate in `api/run-test/route.ts` |
| Evidence: screenshots, video, DOM snapshot, console logs | ✅ Working | `src/core/evidence/*` |
| Reports, history, execution compare | ✅ Working | `reportGenerator.ts`, `/executions`, `/reports`, `/history` |
| Failure classification + Jira bug drafting | ✅ Working | `failureClassifier.ts`, `lib/report-bug-tracker/*` |
| Playwright spec generation | ✅ Working | `playwrightGenerator.ts` — env-substituted secrets, `.first()`, no blind fallbacks |
| Script verification (re-run headless) | ⚠️ Built but **off by default** | `scriptVerifier.ts`, opt-in via `config.verifyScript` |
| Unit tests + CI | ✅ Present | 7 unit specs, GitHub Actions |

**Honest summary:** you have a working, non-trivial deterministic QA execution engine with a real evidence pipeline. Phases 0, 1 and half of 4 in `PRODUCTION_PLAN.md` are genuinely done, not aspirationally done.

### What the vision assumes but the code does not have

| Vision element | Reality |
|---|---|
| **"AI will help us"** | ❌ **There is no AI in the product.** No `@anthropic-ai/sdk`, no `openai`, no model call anywhere in `src/`. The only hits for "LLM/Claude" are in a comment and the plan doc. The "intelligence" is ~2,900 lines of hand-written regex grammar (`testCaseParser.ts`) plus heuristic DOM scoring. |
| **"Create a smoke suite / regression suite"** | ⚠️ Partial. `execType: Functional \| Smoke \| Regression` is a **label on a test case**. There is no suite entity, no suite page, no "run the Smoke suite" action. |
| **"Execute the suite any time using the automation code"** | ❌ **No replay path exists.** Generated specs are written to `generated-tests/` (47 files sitting there) and listed read-only at `/generated-scripts`. `scriptVerifier` can spawn one spec — but nothing lets a user select N saved scripts and run them. The fast-path replay loop that makes the whole economics work is missing. |
| **Script library with versions / verified badge** | ❌ Scripts are derived by scanning `reports/*.json` for a path (`api/scripts/route.ts`). They aren't entities: no version, no link back to the test case, no verified status, no diff. |
| **Self-healing** | ❌ Blocked — it is defined in the plan as needing the AI executor that doesn't exist. |
| **Persistence** | ⚠️ Everything is JSON files on local disk (`reports/` has 173 files) plus in-flight state on `globalThis` (`runRegistry.ts` — its own comment says single-process only). No DB. |
| **Async runs** | ❌ `POST /api/run-test` blocks for the entire run. A 10-minute suite is a 10-minute HTTP request. |
| **Multi-user / auth / SSRF guard** | ❌ Open endpoints, arbitrary `page.goto()`. |

---

## 3. Alignment verdict

**Are we aligned with the vision? Partly — about 45–50% of the way, and the built half is the *right* half.**

Scored against the three layers:

| Layer | Alignment | Note |
|---|---|---|
| A. Intake | 🟢 **~85%** | CSV/XLSX/free-text all work. Genuinely on-vision. |
| B. Adaptive execution | 🟡 **~40%** | Executes reliably — but on **pattern matching, not intent**. Any phrasing outside the grammar is rejected by the linter before the browser opens. |
| C. Codification & reuse | 🔴 **~20%** | Code is generated but never replayed. The "reuse quickly, easily, anytime" promise is not deliverable today. |

**The core misalignment in one sentence:** *the product is sold as an AI agent that understands intent and produces reusable automation, but it is currently a regex interpreter that produces write-only scripts.*

---

## 4. The three things that actually matter

### 4.1 The regex parser is the ceiling, not a stepping stone

`testCaseParser.ts` is 1,262 lines of high-quality craftsmanship — fill-verb × connector grammar, numbered-run splitting, URL-safe tokenising. It is genuinely good code. **And it will never reach the vision**, because the vision is "a QA writes what they mean" and a grammar can only accept what was anticipated.

The tell is `stepLinter.ts` + the 422 gate: today, an unrecognised phrasing **blocks the run entirely**. That is the correct behaviour *for a deterministic engine* — and exactly the opposite of what the vision promises. Every new customer phrasing becomes a code change by you.

**This is not wasted work.** In the target architecture the deterministic engine is the *fast path* — it should handle the 80% of steps it already parses, cheaply and with zero tokens, and hand off the rest. The mistake would be continuing to grow the grammar to cover the tail. **Stop adding grammar rules; add an escape hatch instead.**

Recommended posture:

```
step → parser understands it?  ── yes ──▶ deterministic execution (free, fast)
                               └── no ──▶ AI executor (observe → act → verify)
                                              └─▶ records real locators → regenerates the script
```

Note this also flips the linter's role: instead of "block the run", unparsed steps become "route to AI".

### 4.2 The replay loop is missing — and it is the cheapest big win

Right now the value story breaks at the last mile. You generate a `.spec.ts`, verify is off by default, and then… nothing consumes it. 47 specs on disk, zero replays.

Closing this needs surprisingly little:

1. Make `verifyScript` **on by default** — an unverified script is a liability, not an asset. Store the verdict with the script.
2. Promote scripts to real entities: `{ id, testCaseId, version, specPath, status: verified|stale|broken, lastVerifiedAt }` instead of scraping report JSON.
3. A `Suites` concept: a named set of test-case IDs (Smoke / Regression / per-module).
4. `POST /api/suites/:id/run` → `npx playwright test <specs> --reporter=json` → ingest results into the **existing** report pipeline (which already works).

That is a 1–2 week slice with no AI dependency, and it is the piece that makes the whole product's economics real: *AI runs once, regression replays forever for free.* Right now you pay full execution cost every time.

### 4.3 File-and-globalThis storage will cap you at "demo"

`reports/` at 173 JSON files, run state on `globalThis`, artifacts written into `public/` at runtime (breaks under `next build`), a 10-minute blocking POST. Each of these is fine for a single-user prototype and fatal for a shared internal tool. Two QAs running suites concurrently on one deployed box will collide.

SQLite + Prisma solves most of it with near-zero ops. This can run in parallel with everything else and does not block the AI work.

---

## 5. Smaller things worth flagging

- **`smart-matcher/` is dead code.** A well-documented, tested semantic-matching library (fuzzy matching, multi-language, selector generation) that **is not imported anywhere** in the app — the app has its own `elementDiscovery.ts` doing the same job. Two implementations of the hardest sub-problem. Pick one, delete the other, or the divergence will cost you later.
- **`report-bug-tracker` exists twice** — as a sibling package and as `src/lib/report-bug-tracker/`. Same problem, flagged as task 0.4 and still open.
- **Repo hygiene:** loose HTML/screenshot dumps in the workspace root (`audit_details_drawer`, `compare_modal`, `run_test_page`, …), `.playwright-mcp/` logs. Cosmetic, but it obscures the real structure. Also: `qa-login-agent` is no longer a login agent — the name undersells it and confuses newcomers.
- **`README.md` is one line.** For a platform you want others to adopt, this is the cheapest credibility fix available.
- **The known credential leak** (the QA password, flagged in Phase 0 of `PRODUCTION_PLAN.md`) is still listed as outstanding user action. It is not only in git history — `tests/example.spec.ts` carries it in plaintext at HEAD, alongside a real email address. Rotate it and scrub both before this repo is shared anywhere.

---

## 6. Where I'd take it — a re-cut sequence

The existing `PRODUCTION_PLAN.md` is a good document and I'd keep it. I'd only **change the order**: it puts the AI executor (Phase 2, 2–3 weeks) before the recorder/library (Phase 3). I'd flip that.

**Reason:** the replay loop has no AI dependency, is the visibly missing half of the pitch, and de-risks the AI phase — once replay exists, the AI executor plugs into a slot that already works end-to-end, rather than being built against a hole.

| Order | Slice | Why now | Rough size |
|---|---|---|---|
| **1** | **Suites + replay + script entities** (Phase 3 core) | Completes the value story with zero AI risk. Turns 47 dead files into a regression asset. | 1–2 wks |
| **2** | **Persistence: SQLite/Prisma + async runs + SSE** (5.1–5.4) | Unblocks concurrent users; can overlap with 1. | 1.5–2 wks |
| **3** | **AI executor as fallback, not replacement** (Phase 2) | Deterministic first, AI on unparsed step or failure. Keeps cost bounded and the fast path intact. | 2–3 wks |
| **4** | **Recorder feeds the generator** (3.1–3.2) | Scripts built from *actually executed* locators, not parsed guesses — quality jump. | ~1 wk |
| **5** | **Self-healing + AI triage** (4.2–4.3) | Only meaningful once 1–4 exist. | ~2 wks |
| **6** | **Auth, SSRF guard, scheduling/CI hook, Docker** (5.5–5.8) | Needed before anyone outside the team touches it. | 1–2 wks |

---

## 7. Decisions I need from you

1. **AI integration route** — direct Anthropic tool-use loop (recommended: you control the recording hooks, and recording is the whole point) vs. Playwright MCP + Agent SDK (faster to first demo).
2. **Cost posture** — AI on first run + failures only (recommended) vs. AI on every run. This decides whether the deterministic engine stays a first-class citizen or becomes legacy.
3. **`smart-matcher`: adopt or delete?** Two discovery engines is the single clearest source of future waste in this repo.
4. **Deployment target** — single internal box (SQLite is fine) vs. multi-instance (Postgres from day one, and `globalThis` run state must go regardless).
5. **Scope check** — is CI gating (a pipeline triggers a suite and blocks a deploy on the result) in scope for v1? It changes how much the async/API-key work matters.

---

## 8. Bottom line

**Vision: good. Foundation: better than you'd expect at this stage. Alignment: half.**

The gap is not effort or code quality — it's that two of the three load-bearing promises aren't implemented yet: *the AI* and *the reuse loop*. The deterministic engine you've built is not a detour; it is the fast path the final architecture needs. The risk is spending the next month deepening the regex grammar (which raises the ceiling by inches) instead of building the replay loop and the AI fallback (which is the actual product).

**My recommendation: ship the regression replay loop first, then add AI as a fallback — and freeze the parser grammar today.**
