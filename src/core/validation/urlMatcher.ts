/**
 * urlMatcher.ts — Decides whether the browser is where the test case says it
 * should be, without demanding that the author guessed the app's exact routing.
 *
 * A step written as `verify url contains /dashboard` is making a claim about
 * *which page the user ended up on*, not about a substring. Apps name that page
 * `/dashboard`, `/home`, `/desktop/home`, `/overview`, `/portal` — all the same
 * page to everyone except a substring comparison. Failing the run over the
 * vocabulary the developers happened to pick reports a defect that does not
 * exist, and a suite that cries wolf stops being read.
 *
 * The flexibility is deliberately bounded. Matching runs in tiers, each one
 * needing more evidence than a plain substring rather than less:
 *
 *   exact     the normalised URL contains the expected fragment
 *   segment   the fragment matches whole path segments, ignoring query and hash
 *   semantic  the fragment and the real URL name the same *kind* of page, and
 *             the page itself corroborates it
 *
 * Semantic matching only covers page roles whose naming is genuinely arbitrary
 * across apps — the post-login landing page and the sign-in page. Everything
 * else stays strict, because `/settings` and `/billing` really are different
 * claims. And a semantic pass is always reported as one, never silently: the
 * report shows what was expected, what was actually there, and why it counted.
 */

/**
 * Page roles whose URL naming varies arbitrarily between applications.
 *
 * Confined to two. These are the cases where a test author cannot reasonably be
 * expected to know the app's word for a page that every app has. Adding roles
 * like `settings` or `profile` here would start excusing real routing bugs.
 */
const PAGE_ROLES: Record<string, string[]> = {
  landing: [
    'dashboard', 'dashboards', 'home', 'homepage', 'main', 'overview',
    'portal', 'workspace', 'desktop', 'start', 'hub', 'index', 'app',
  ],
  auth: ['login', 'signin', 'sign-in', 'log-in', 'logon', 'auth', 'sso', 'authenticate'],
};

export type UrlMatchTier = 'exact' | 'segment' | 'semantic';

export interface UrlMatchResult {
  matched: boolean;
  tier?: UrlMatchTier;
  /** Human-readable explanation, shown in the step log and the report. */
  note?: string;
  /** The role both sides resolved to, when the match was semantic. */
  role?: string;
}

/**
 * Normalises a URL or fragment for comparison: lowercased, no hash, no trailing
 * slash. `https://app.com/Desktop/Home/` → `https://app.com/desktop/home`
 */
export function normaliseUrl(u: string): string {
  return (u || '').toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '').trim();
}

/** Path segments of a URL or bare fragment, with query and hash discarded. */
function segmentsOf(value: string): string[] {
  let path = normaliseUrl(value).replace(/\?.*$/, '');
  path = path.replace(/^[a-z]+:\/\/[^/]+/, ''); // drop scheme + host if present
  return path.split('/').filter(Boolean);
}

/** The role a fragment or URL names, or null when it names nothing well known. */
export function roleOf(value: string): string | null {
  const segments = segmentsOf(value);
  if (segments.length === 0) return null;
  for (const [role, vocabulary] of Object.entries(PAGE_ROLES)) {
    // Only whole segments count: `/user-dashboard-settings` is not the landing page.
    if (segments.some((s) => vocabulary.includes(s))) return role;
  }
  return null;
}

/** Tier 1 + 2 — pure string comparison, no page inspection. */
export function matchUrlLiterally(expected: string, actual: string): UrlMatchResult {
  const needle = normaliseUrl(expected);
  if (!needle) return { matched: false };

  if (normaliseUrl(actual).includes(needle)) {
    return { matched: true, tier: 'exact' };
  }

  // Segment comparison ignores query strings and matches whole path segments, so
  // `/dashboard` is satisfied by `/app/dashboard?tab=recent` — the same page.
  const wanted = segmentsOf(expected);
  const have = segmentsOf(actual);
  if (wanted.length > 0 && wanted.length <= have.length) {
    const contiguous = have.some((_, i) => wanted.every((w, j) => have[i + j] === w));
    if (contiguous) {
      return {
        matched: true,
        tier: 'segment',
        note: `Matched on path segments (expected "${expected}", actual "${actual}") — query string and trailing slash ignored.`,
      };
    }
  }

  return { matched: false };
}

/**
 * Tier 3 — the expected fragment and the real URL name the same kind of page.
 *
 * `corroborated` is the caller's evidence that the page really is what its URL
 * suggests. For the landing role that means "we are inside the authenticated
 * app", which is what the assertion was actually there to check; without it a
 * failed login sitting on a URL like `/home` would sail through.
 */
export function matchUrlSemantically(
  expected: string,
  actual: string,
  corroborated: boolean,
): UrlMatchResult {
  const expectedRole = roleOf(expected);
  const actualRole = roleOf(actual);

  if (!expectedRole || expectedRole !== actualRole) return { matched: false };
  if (!corroborated) return { matched: false };

  const description =
    expectedRole === 'landing'
      ? 'both name the application\'s post-login landing page, and the page is confirmed to be an authenticated view'
      : 'both name the sign-in page';

  return {
    matched: true,
    tier: 'semantic',
    role: expectedRole,
    note:
      `Semantic URL match: expected "${expected}" but the application uses "${actual}" — ${description}. ` +
      `The route itself was NOT verified literally; if the exact path matters here, write the step as ` +
      `"verify url is exactly ${actual}".`,
  };
}
