/**
 * sessionManager.ts — Authenticated-session cache (Playwright storageState).
 *
 * Logging in through the UI once per test case is the single biggest cost in a
 * multi-TC run: a 20-TC module pays the login cost 20 times. This module stores
 * the cookies + localStorage snapshot produced by ONE successful login and lets
 * every later suite start already authenticated via
 * `browser.newContext({ storageState })`.
 *
 * Each suite still gets its own isolated BrowserContext — it receives a *copy*
 * of the state, so parallel suites never share a live context. Only the login
 * UI walk is skipped.
 *
 * Cached sessions live under test-runs/sessions/ (gitignored — they contain real
 * auth cookies) and are keyed so a session is never reused across a different
 * target site, browser engine, device profile, or login flow.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { BrowserContext } from '@playwright/test';
import { ParsedStep } from '@/types/testCase';
import { BrowserEngine, DeviceMode } from '@/types/mvp';
import { logger } from '@/utils/logger';

/** Playwright's storageState payload — opaque to us, passed straight back to newContext(). */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface CachedSession {
  /** Cache key this record was stored under. */
  key: string;
  /** ISO timestamp of the login that produced this state. */
  createdAt: string;
  /** URL the browser landed on once login completed — where reusing suites resume. */
  landingUrl: string;
  /** Cookies + localStorage captured from the authenticated context. */
  storageState: StorageState;
  /**
   * Selectors resolved for each login step during the real login, indexed by
   * prologue position. Suites that skip the login still need these so the
   * Playwright spec they generate contains a complete, standalone login.
   */
  prologueSelectors?: (string | null)[];
  /** How long the real login took — used to estimate the time reuse saves. */
  loginDurationMs?: number;
}

export const SESSIONS_DIR = path.join(process.cwd(), 'test-runs', 'sessions');

/** Default lifetime of a cached session. Short enough that app-side idle timeouts rarely bite. */
export const DEFAULT_SESSION_TTL_MINUTES = 20;

function sessionFilePath(key: string): string {
  return path.join(SESSIONS_DIR, `${key}.json`);
}

/**
 * Builds a stable fingerprint of a login flow. Two suites share a cached session
 * only when they log in the same way, on the same site, in the same browser and
 * device profile — so a "login as admin" session can never leak into a
 * "login as viewer" test case.
 */
export function computeSessionKey(params: {
  url: string;
  browser: BrowserEngine;
  deviceMode: DeviceMode;
  loginSteps: ParsedStep[];
}): string {
  const flow = params.loginSteps
    .map((s) =>
      [s.type, s.action ?? '', s.targetField ?? '', s.value ?? '', s.waitMs ?? ''].join('|'),
    )
    .join('>>');

  // Credential values themselves are {{vars}} or 'valid'/'invalid' markers, never
  // plaintext secrets — but hash anyway so nothing sensitive lands in a filename.
  const raw = [params.url, params.browser, params.deviceMode, flow].join('::');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/**
 * Loads a cached session if one exists and has not aged past the TTL.
 * Anything unreadable or expired is treated as a miss (and cleaned up).
 */
export function loadSession(key: string, ttlMinutes = DEFAULT_SESSION_TTL_MINUTES): CachedSession | null {
  const file = sessionFilePath(key);
  try {
    if (!fs.existsSync(file)) return null;

    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CachedSession;
    if (!parsed?.storageState || !parsed?.landingUrl || !parsed?.createdAt) {
      invalidateSession(key);
      return null;
    }

    const ageMs = Date.now() - new Date(parsed.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs > ttlMinutes * 60_000) {
      logger.info(`Cached session ${key} expired (age ${Math.round(ageMs / 1000)}s) — discarding.`);
      invalidateSession(key);
      return null;
    }

    return parsed;
  } catch (err) {
    logger.error(`Failed to read cached session ${key}`, err);
    invalidateSession(key);
    return null;
  }
}

export function saveSession(session: CachedSession): void {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    fs.writeFileSync(sessionFilePath(session.key), JSON.stringify(session, null, 2), 'utf-8');
    logger.info(`Cached authenticated session ${session.key} (landing: ${session.landingUrl})`);
  } catch (err) {
    // A failed cache write must never fail the run — the next suite just logs in itself.
    logger.error(`Failed to cache session ${session.key}`, err);
  }
}

export function invalidateSession(key: string): void {
  try {
    const file = sessionFilePath(key);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      logger.info(`Invalidated cached session ${key}`);
    }
  } catch (err) {
    logger.error(`Failed to invalidate cached session ${key}`, err);
  }
}

/** Clears every cached session. Exposed for a "force fresh login" control. */
export function clearAllSessions(): number {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return 0;
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    files.forEach((f) => fs.unlinkSync(path.join(SESSIONS_DIR, f)));
    return files.length;
  } catch (err) {
    logger.error('Failed to clear cached sessions', err);
    return 0;
  }
}
