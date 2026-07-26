# Login session reuse

A module with 10–20 test cases normally repeats the same three or four login steps in
every TC. Without reuse the suite pays for 10–20 real UI logins **and** 10–20 browser
launches. Two independent optimisations fix that:

| Setting | Default | Effect |
|---|---|---|
| `reuseSession` | on | One real login per module; every other TC starts already authenticated. |
| `reuseBrowser` | on | One browser process per run; each TC gets its own isolated context. |

Both are toggles on the Run Test screen (Execution Options).

## Browser reuse

`reuseBrowser` launches Chrome/Firefox/WebKit **once per run** and gives each test case a
fresh `BrowserContext`. A context is as isolated as a new process for cookies, storage and
cache — only the process start-up (~0.5–1.5s each) is shared. Verified: a 2-TC run makes
1 launch with the flag on, 2 with it off.

Turn it off if a test case can crash the browser and you want the next one fully insulated
from that.

## Session reuse

1. **Detect** — [loginFlow.ts](../src/core/execution/loginFlow.ts) finds the *login prologue*:
   the leading steps up to and including the click that submits the login form.
2. **Classify** — every suite falls into one of three buckets:
   - **login suite** — opens with a login flow; that flow gets skipped.
   - **continuation suite** — enters no credentials at all and jumps straight into an
     authenticated page (`navigate to /desktop/home`, open the profile menu…). Without a
     session it lands on the login page and fails, so it is given the shared session.
   - **excluded** — negative login, or `@fresh-login`; runs from a clean, logged-out browser.
3. **Group** — login suites whose flow fingerprints match (same site, browser, device profile,
   credentials) share one session. Different users/sites/browsers never share.
   See `computeSessionKey()` in [sessionManager.ts](../src/core/execution/sessionManager.ts).
4. **Prime** — with no valid cached session and 2+ consumers, the runner logs in once up
   front and stores Playwright's `storageState` (cookies + localStorage) in
   `test-runs/sessions/<key>.json` (gitignored — it holds real auth cookies).
   Continuation suites attach to the first login flow that actually produces a working
   session, so a flow that fails to log in cannot strand them.
5. **Reuse** — each suite gets `newContext({ storageState })`, navigates to the recorded
   landing URL, and continues from the step after its login prologue.
6. **Verify** — before trusting a restored session the runner confirms no login form is
   showing and the app did not bounce back to a login URL. If it did, the cache entry is
   deleted and that suite logs in for real (a continuation suite logs in inline, as setup).

Cached sessions expire after `sessionTtlMinutes` (default 20). A lone login suite is not
primed — that would cost two logins instead of one — but its session **is** cached, so the
next run starts warm.

### Self-healing retry

Some assertions only hold after a *real* submit — a flash message like
`page should contain "You logged into a secure area"` does not exist when the login was
skipped. Rather than guessing which test cases those are, the runner reuses aggressively and
**re-runs any suite that reused a session and failed, once, with a real login**. The reported
result is the retry's. Passing suites never pay for this; the budget is 3 retries per run and
the log says when it is exhausted.

### When a real login always happens

| Case | Why |
|---|---|
| `enter invalid credentials` | A negative-login test needs a clean, logged-out context. |
| A login that asserts a rejection ("Incorrect Email or Password", "invalid", "wrong") | Same — recognised even when the wrong values are typed literally. |
| A login suite containing a **logout** step | A server-side logout can invalidate the token other suites are using. |
| An assertion inside the login sequence | Skipping it would silently drop that coverage. |
| `@fresh-login` | Explicit author opt-out. |
| `reuseSession: false` | Global opt-out. |

Suites that log out are **scheduled last** so they cannot end the shared session while other
suites are still using it, and the cache is invalidated after the run.

## Directives

Write these on the TC header or on their own line:

```
TC01: Invalid login                          <- negative test, always logged out
navigate to https://stage.example.com/login
fill Email field with wrong@example.com
fill Password field with WrongPass
click Login button
verify "Incorrect Email or Password" is visible

TC02: Valid login                            <- login steps skipped, session injected
navigate to https://stage.example.com/login
fill Email field with {{qa_valid_username}}
fill Password field with {{qa_valid_password}}
click Login button
verify url contains /dashboard

TC03: Create a task                          <- no login steps: starts authenticated
navigate to https://stage.example.com/desktop/home
Click on Create Task
verify that text "Task created" is visible

TC04: Password change @fresh-login           <- force a real login for this TC
TC05: Dashboard KPIs
@reuse-session                               <- (reserved) force reuse for this TC
```

Credentials belong in `.env` as `QA_*` / `TEST_*` variables referenced as `{{name}}`.
Literal passwords in step text end up in reports and generated specs in plain text.

## Effect on generated scripts

Reports and generated specs are unaffected by reuse. Skipped login steps keep the selectors
resolved during the one real login (`prologueSelectors` in the cache record), so every
generated `*.spec.ts` still contains a complete, standalone login and runs on its own.
In reports and the results table those steps are marked `cached login`.

## Configuration reference

| Key | Default | Where |
|---|---|---|
| `config.reuseSession` | `true` | Run Test → Execution Options → "Reuse Login Session" |
| `config.reuseBrowser` | `true` | Run Test → Execution Options → "Reuse Browser Process" |
| `config.sessionTtlMinutes` | `20` | `POST /api/run-test` body, or `reports/settings.json` |

`clearAllSessions()` in [sessionManager.ts](../src/core/execution/sessionManager.ts) wipes the
cache if a fully cold run is ever needed.

## Troubleshooting

Check the live log for `[SESSION]` lines — they state exactly what happened:

```
[SESSION] No cached session — logging in once to share across test cases...
[SESSION] Shared login succeeded in 6.8s — landing: https://stage.example.com/dashboard
[SESSION] Reusing cached login for TC02, TC03 (cached 14:21:05)
[TC02]    Restoring cached login session — skipping 4 login step(s)...
[TC02]    Cached session accepted — resumed at https://stage.example.com/dashboard
```

If `reusedSuites` is 0, one of these is true: every suite is excluded (see the table above),
no suite performs a successful login, or the module has a single login suite (which caches
its session for the next run instead).
