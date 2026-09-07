import { describe, expect, it } from "vitest";
import {
  buildLoginBody,
  buildLoginHeaders,
  extractCsrfFormToken,
  interpretLoginResponse,
  performDaylightLogin,
  readSetCookie,
} from "../../../src/portals/daylight/login.js";

const BASE = "https://daylightportal.com";

describe("extractCsrfFormToken", () => {
  it("reads the hidden field with name before value", () => {
    expect(
      extractCsrfFormToken(`<input type="hidden" name="csrfmiddlewaretoken" value="abc123">`),
    ).toBe("abc123");
  });

  it("reads it with value before name, because attribute order is not guaranteed", () => {
    // One pattern silently returns null on the other half of renders.
    expect(
      extractCsrfFormToken(`<input value="xyz789" name="csrfmiddlewaretoken" type="hidden">`),
    ).toBe("xyz789");
  });

  it("returns null when the field is absent", () => {
    expect(extractCsrfFormToken("<form></form>")).toBeNull();
  });
});

describe("readSetCookie", () => {
  it("reads a normal cookie value", () => {
    expect(readSetCookie(["daylight_sessionid=abc; Path=/; HttpOnly"], "daylight_sessionid")).toBe(
      "abc",
    );
  });

  it("treats a QUOTED-EMPTY deletion as absent", () => {
    // TRAP 1. A logout sends `daylight_sessionid=""` with literal quotes. A bare
    // `value !== ""` check stores the two-character string `""` as a session id,
    // which then authenticates as nothing for ever.
    expect(
      readSetCookie(
        ['daylight_sessionid=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'],
        "daylight_sessionid",
      ),
    ).toBeNull();
  });

  it("treats a bare-empty deletion as absent too", () => {
    expect(readSetCookie(["daylight_sessionid=; Path=/"], "daylight_sessionid")).toBeNull();
  });

  it("ignores a different cookie with a similar prefix", () => {
    expect(readSetCookie(["daylight_csrftoken=csrf1; Path=/"], "daylight_sessionid")).toBeNull();
  });
});

describe("buildLoginHeaders", () => {
  it("sets Referer and Origin, which Django REQUIRES over HTTPS", () => {
    // TRAP 2. Without them Django 403s, and a 403 reads exactly like a wrong
    // password, which sends an operator off to rotate a healthy credential.
    const headers = buildLoginHeaders(BASE, "csrf-cookie");
    expect(headers.Referer).toBe(`${BASE}/installers/login`);
    expect(headers.Origin).toBe(BASE);
  });

  it("never sends a session cookie", () => {
    // A login presenting an existing session is a 302 no-op that issues
    // nothing, so including one turns minting into a silent failure.
    const headers = buildLoginHeaders(BASE, "csrf-cookie");
    expect(headers.Cookie).toBe("daylight_csrftoken=csrf-cookie");
    expect(headers.Cookie).not.toContain("daylight_sessionid");
  });

  it("tolerates a base url with a trailing slash", () => {
    expect(buildLoginHeaders(`${BASE}/`, "c").Origin).toBe(BASE);
  });
});

describe("interpretLoginResponse", () => {
  it("succeeds only when a session was actually issued", () => {
    expect(interpretLoginResponse({ status: 302, sessionId: "abc" })).toEqual({
      ok: true,
      sessionId: "abc",
    });
  });

  it("does NOT treat a bare 302 as success", () => {
    // TRAP 3. An already-authenticated request also 302s while issuing nothing.
    const verdict = interpretLoginResponse({ status: 302, sessionId: null });
    expect(verdict.ok).toBe(false);
  });

  it("names a CSRF rejection distinctly from a credential failure", () => {
    const verdict = interpretLoginResponse({ status: 403, sessionId: null });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/CSRF/);
  });

  it("surfaces the portal's own wording when the form re-renders", () => {
    const verdict = interpretLoginResponse({
      status: 200,
      sessionId: null,
      bodyText: "<p>Please enter a correct username and password.</p>",
    });
    if (!verdict.ok) expect(verdict.reason).toMatch(/correct username/i);
  });
});

describe("buildLoginBody", () => {
  it("form-encodes all three fields", () => {
    const body = buildLoginBody({ csrfmiddlewaretoken: "t", username: "u@x.com", password: "p&p" });
    expect(body).toBe("csrfmiddlewaretoken=t&username=u%40x.com&password=p%26p");
  });
});

/** A fake portal that walks the whole four-step flow. */
function fakePortal(over: { sessionId?: string | null; sentinelStatus?: number } = {}) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? "GET" });

    if (href.endsWith("/installers/login") && (init?.method ?? "GET") === "GET") {
      return {
        status: 200,
        headers: { getSetCookie: () => ["daylight_csrftoken=csrf1; Path=/"] },
        text: async () => `<input name="csrfmiddlewaretoken" value="form1">`,
      } as unknown as Response;
    }
    if (href.endsWith("/installers/login")) {
      const sid = over.sessionId === undefined ? "sess1" : over.sessionId;
      return {
        status: 302,
        headers: { getSetCookie: () => (sid ? [`daylight_sessionid=${sid}; Path=/`] : []) },
        text: async () => "",
      } as unknown as Response;
    }
    return {
      status: over.sentinelStatus ?? 200,
      headers: { getSetCookie: () => [] },
      text: async () => "<html>dashboard</html>",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("performDaylightLogin", () => {
  const config = { baseUrl: BASE, username: "u", password: "p" };

  it("mints a verified session and returns a loggable fingerprint", async () => {
    const { fetchImpl } = fakePortal();
    const result = await performDaylightLogin({ ...config, fetchImpl });
    expect(result.sessionId).toBe("sess1");
    expect(result.verified).toBe(true);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // The fingerprint must not leak the cookie itself.
    expect(result.fingerprint).not.toContain("sess1");
  });

  it("PROBES the session before returning it", async () => {
    // A session that was issued is not the same as a session that works.
    // Without this step the failure lands on whoever uses the cookie later.
    const { fetchImpl, calls } = fakePortal();
    await performDaylightLogin({ ...config, fetchImpl });
    expect(calls.at(-1)!.url).toContain("/installers/dashboard");
  });

  it("throws when the issued session does not authenticate", async () => {
    const { fetchImpl } = fakePortal({ sentinelStatus: 302 });
    await expect(performDaylightLogin({ ...config, fetchImpl })).rejects.toThrow(
      /did not authenticate/,
    );
  });

  it("throws when the POST issued no session", async () => {
    const { fetchImpl } = fakePortal({ sessionId: null });
    await expect(performDaylightLogin({ ...config, fetchImpl })).rejects.toThrow(/login failed/);
  });

  it("throws a diagnosable error when the CSRF pair is missing", async () => {
    const fetchImpl = (async () =>
      ({
        status: 200,
        headers: { getSetCookie: () => [] },
        text: async () => "<html>login moved</html>",
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(performDaylightLogin({ ...config, fetchImpl })).rejects.toThrow(
      /CSRF pair.*route has probably moved/s,
    );
  });
});

describe("daylight.login catalogue entry", () => {
  it('refuses the "default" client, which would resolve a nonexistent credential', async () => {
    const { daylightLoginHandler } = await import("../../../src/portals/daylight/action.js");
    await expect(
      daylightLoginHandler({ input: {}, credentials: {}, client: "default" }),
    ).rejects.toThrow(/no "default" client/);
  });

  it("keeps the two installers on separate 1Password items", async () => {
    const { resolveAction } = await import("../../../src/gateway/catalogue.js");
    // Bare names, resolved inside OP_PORTALS_VAULT, matching LightReach.
    // Verified against the live vault 2026-09-08.
    expect(resolveAction("daylight.login", "wolfpack").credentialItem).toBe(
      "Daylight portal - Wolfpack",
    );
    expect(resolveAction("daylight.login", "2ndcity").credentialItem).toBe(
      "Daylight portal - 2ndCity",
    );
  });

  it("is a code action, so no LLM or browser path is reachable", async () => {
    const { getEntry } = await import("../../../src/gateway/catalogue.js");
    expect(getEntry("daylight.login").handler).toBeDefined();
  });
});
