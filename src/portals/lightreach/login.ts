import { chromium } from "playwright-core";
import type { CookieGet, WarmSession } from "./batch.js";

/**
 * LightReach login — the one live-browser step of the code-action (issue #467).
 * Auth0 (auth.palmetto.com) blocks pure-HTTP login (ROPG disabled, verified in
 * recon), so we drive a real browser on Browserbase with plain Playwright (no
 * LLM, no Stagehand) to log in, then capture the palmetto.finance cookie jar.
 * Reads run afterward over plain HTTP with that jar — the browser is closed
 * first (validated end-to-end in recon pass 5).
 *
 * The access_token cookie lives ~24h, so this login happens ~once per client
 * per day; everything else is browserless.
 */

const LOGIN_URL = "https://auth.palmetto.com/login";
const APP_HOME = "https://palmetto.finance";
const EMAIL_SEL = 'input[type="email"], input[name="username"], #username';
const PASS_SEL = 'input[type="password"]';

export interface LightreachLoginConfig {
  username: string;
  password: string;
  /** One-time code, when the account ever has MFA (none today). */
  otp?: string;
  apiKey?: string;
  projectId?: string;
  /** An account id to load post-login to seat the palmetto.finance session. */
  seatAccountId?: string;
  now?: () => number;
  /** Injectable session-connect for tests; defaults to Browserbase over CDP. */
  connect?: () => Promise<{ cookieHeader: string; close: () => Promise<void> } | null>;
}

async function browserbaseConnect(config: LightreachLoginConfig) {
  const apiKey = config.apiKey ?? process.env.BROWSERBASE_API_KEY;
  const projectId = config.projectId ?? process.env.BROWSERBASE_PROJECT_ID;
  const res = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "x-bb-api-key": apiKey ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  const session = (await res.json()) as { connectUrl?: string };
  if (!session.connectUrl) throw new Error("Browserbase session create failed");

  const browser = await chromium.connectOverCDP(session.connectUrl);
  const close = async () => {
    await browser.close().catch(() => {});
  };
  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector(EMAIL_SEL, { timeout: 20_000 });
    await page.fill(EMAIL_SEL, config.username);
    if (!(await page.$(PASS_SEL))) {
      await page.keyboard.press("Enter");
      await page.waitForSelector(PASS_SEL, { timeout: 20_000 });
    }
    await page.fill(PASS_SEL, config.password);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(6_000);

    // Seat: loading an app page completes the OAuth handoff and sets the
    // palmetto.finance cookies (without this the API 401s — recon finding).
    const seatUrl = config.seatAccountId
      ? `${APP_HOME}/accounts/${encodeURIComponent(config.seatAccountId)}`
      : APP_HOME;
    await page.goto(seatUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(5_000);

    const cookies = await ctx.cookies(APP_HOME);
    if (cookies.length === 0) {
      throw new Error("LightReach login produced no palmetto.finance cookies (login may have failed)");
    }
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return { cookieHeader, close };
  } catch (e) {
    await close();
    throw e;
  }
}

export async function loginLightreach(config: LightreachLoginConfig): Promise<WarmSession> {
  const connect = config.connect ?? (() => browserbaseConnect(config));
  const result = await connect();
  if (!result) throw new Error("LightReach login connect returned no session");
  try {
    return { cookieHeader: result.cookieHeader, capturedAt: (config.now ?? Date.now)() };
  } finally {
    await result.close();
  }
}

/** Production read: a plain HTTP GET carrying the captured cookie jar. Recon 5
 *  proved the browser can be closed before reads — this needs no browser. */
export const httpGetWithCookie: CookieGet = (url, cookieHeader) =>
  fetch(url, { headers: { Cookie: cookieHeader, Accept: "application/json" } });
