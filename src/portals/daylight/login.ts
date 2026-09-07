/**
 * Daylight portal login, a code action, deterministic, no LLM and no browser.
 *
 * ## Why there is no Browserbase session here
 *
 * LightReach drives a real browser because Auth0 genuinely defeats pure HTTP
 * (ROPG disabled, verified in recon, see `../lightreach/login.ts`). Daylight
 * does not: it is a plain Django session login, a form POST with a CSRF pair,
 * and it works over `fetch` today. This module follows the gateway's own rule of
 * using a browser only where HTTP fails, so a Daylight login costs zero metered
 * Browserbase minutes.
 *
 * What the gateway is providing here is the part that actually matters: the
 * trust boundary. Credentials are resolved just-in-time from 1Password inside
 * this process and never reach the calling app, which is the same guarantee
 * LightReach gets.
 *
 * If Daylight ever adds bot detection or MFA, {@link performDaylightLogin} is
 * where a Browserbase path slots in behind the same signature, and nothing that
 * calls it has to change.
 *
 * ## Three traps, each measured against the live portal
 *
 * Ported from the job-automation implementation, which learned them the hard
 * way. They are the reason this is not five lines of `fetch`.
 */

/** Both halves of Django's CSRF defence. Sending one without the other is a 403. */
export interface DaylightCsrfPair {
  /** The `daylight_csrftoken` cookie. */
  cookie: string;
  /** The hidden `csrfmiddlewaretoken` form field. */
  formToken: string;
}

/**
 * The hidden CSRF field from the login page.
 *
 * Two patterns because the attribute order is not guaranteed: some renders put
 * `name` before `value` and some the other way round, and a single pattern
 * silently returns null on the other half of the time.
 */
export function extractCsrfFormToken(loginHtml: string): string | null {
  const patterns = [
    /name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(loginHtml);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * One cookie's value out of a `Set-Cookie` list.
 *
 * TRAP 1: A DELETION MUST READ AS ABSENT. A logout sends
 * `daylight_sessionid=""; expires=Thu, 01 Jan 1970 …`, with LITERAL QUOTE
 * CHARACTERS. A bare `value !== ""` check passes that through as the
 * two-character string `""`, which then gets stored as a session id and
 * authenticates as nothing, for ever. Strip the quotes first, then test.
 */
export function readSetCookie(setCookies: readonly string[], name: string): string | null {
  for (const raw of setCookies) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(raw.trim());
    if (!match) continue;
    const value = match[1]!.replace(/^"(.*)"$/, "$1").trim();
    if (value !== "") return value;
  }
  return null;
}

export function buildLoginBody(form: {
  csrfmiddlewaretoken: string;
  username: string;
  password: string;
}): string {
  return new URLSearchParams(form).toString();
}

/**
 * Headers for the login POST.
 *
 * TRAP 2: `Referer` and `Origin` ARE NOT POLITENESS. Django rejects an HTTPS
 * POST whose Referer does not match the origin, with a 403 that looks exactly
 * like a wrong password and sends you to rotate a perfectly good credential.
 *
 * NO `daylight_sessionid` IS EVER SENT. A login that presents an existing
 * session is a 302 no-op that issues nothing, so including one turns minting
 * into a silent failure that still looks like a redirect to success.
 */
export function buildLoginHeaders(baseUrl: string, csrfCookie: string): Record<string, string> {
  const origin = baseUrl.replace(/\/$/, "");
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: `daylight_csrftoken=${csrfCookie}`,
    Referer: `${origin}/installers/login`,
    Origin: origin,
  };
}

/**
 * Did the login actually succeed?
 *
 * TRAP 3: A 302 ALONE IS NOT SUCCESS. An already-authenticated request also
 * 302s while issuing nothing, and a failed login can re-render the form with
 * 200. The only proof is a freshly issued session id.
 */
export function interpretLoginResponse(input: {
  status: number;
  sessionId: string | null;
  bodyText?: string;
}): { ok: true; sessionId: string } | { ok: false; reason: string } {
  if (input.sessionId) return { ok: true, sessionId: input.sessionId };
  if (input.status === 403) {
    return {
      ok: false,
      reason: "403, CSRF rejected (check both csrf halves and the Referer header)",
    };
  }
  const hint = input.bodyText
    ? /(invalid|incorrect|does not match|please enter a correct)[^.<]{0,80}/i.exec(
        input.bodyText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
      )?.[0]
    : undefined;
  return {
    ok: false,
    reason: `HTTP ${input.status} issued no session${hint ? `, portal said: ${hint.trim()}` : ""}`,
  };
}

export interface DaylightLoginConfig {
  baseUrl: string;
  username: string;
  password: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DaylightLoginResult {
  sessionId: string;
  /** First 8 hex of sha256(sessionId), safe to log; the cookie never is. */
  fingerprint: string;
  /** Proven live by a post-login probe, not merely issued. */
  verified: boolean;
}

const LOGIN_PATH = "/installers/login";
const SENTINEL_PATH = "/installers/dashboard?view=installer";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a Daylight session.
 *
 * Four steps, none of them skippable:
 *   1. GET the login page for BOTH csrf halves
 *   2. POST credentials with no session cookie present
 *   3. read the issued `daylight_sessionid`
 *   4. PROBE it against a real page before returning it
 *
 * Step 4 is the one people drop. A session id that was issued is not the same
 * as a session that works, and handing back an unverified cookie moves the
 * failure to whatever tries to use it an hour later.
 */
export async function performDaylightLogin(
  config: DaylightLoginConfig,
): Promise<DaylightLoginResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const base = config.baseUrl.replace(/\/$/, "");

  const loginPage = await doFetch(`${base}${LOGIN_PATH}`, { redirect: "manual" });
  const csrfCookie = readSetCookie(loginPage.headers.getSetCookie?.() ?? [], "daylight_csrftoken");
  const formToken = extractCsrfFormToken(await loginPage.text());
  if (!csrfCookie || !formToken) {
    throw new Error(
      `Daylight login page did not yield a CSRF pair (cookie=${Boolean(csrfCookie)}, ` +
        `form=${Boolean(formToken)}); the login route has probably moved`,
    );
  }

  const posted = await doFetch(`${base}${LOGIN_PATH}`, {
    method: "POST",
    redirect: "manual",
    headers: buildLoginHeaders(base, csrfCookie),
    body: buildLoginBody({
      csrfmiddlewaretoken: formToken,
      username: config.username,
      password: config.password,
    }),
  });

  const sessionId = readSetCookie(posted.headers.getSetCookie?.() ?? [], "daylight_sessionid");
  const verdict = interpretLoginResponse({
    status: posted.status,
    sessionId,
    bodyText: posted.status === 200 ? await posted.text() : undefined,
  });
  if (!verdict.ok) throw new Error(`Daylight login failed: ${verdict.reason}`);

  // Step 4. Prove it before returning it.
  const probe = await doFetch(`${base}${SENTINEL_PATH}`, {
    redirect: "manual",
    headers: { Cookie: `daylight_sessionid=${verdict.sessionId}` },
  });
  if (probe.status !== 200) {
    throw new Error(
      `Daylight issued a session but it did not authenticate (sentinel returned ` +
        `${probe.status}); refusing to hand back a cookie that does not work`,
    );
  }

  return {
    sessionId: verdict.sessionId,
    fingerprint: (await sha256Hex(verdict.sessionId)).slice(0, 8),
    verified: true,
  };
}
