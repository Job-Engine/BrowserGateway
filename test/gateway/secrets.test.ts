import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gateway secrets tests: C1 (OTP never cached) and M2 (minimal env to op).
 * The op CLI is mocked at the child_process boundary.
 */

const op = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
  responses: new Map<string, string>(),
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(
    () => {
      throw new Error("callback execFile not expected in tests");
    },
    {
      [promisify.custom]: async (
        _cmd: string,
        args: string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        op.calls.push({ args, env: options.env ?? {} });
        const ref = args[args.length - 1];
        for (const [needle, value] of op.responses) {
          if (ref.includes(needle)) return { stdout: `${value}\n`, stderr: "" };
        }
        throw new Error(`no mock response for ${ref}`);
      },
    },
  );
  return { execFile };
});

import { clearCredentialCache, resolvePortalCredentials } from "../../src/gateway/secrets.js";

function opReadsMatching(needle: string) {
  return op.calls.filter((c) => c.args.some((a) => a.includes(needle)));
}

beforeEach(() => {
  op.calls.length = 0;
  op.responses.clear();
  op.responses.set("/username", "user1");
  op.responses.set("/password", "pw1");
  op.responses.set("one-time password", "111111");
  clearCredentialCache();
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "tok_test");
  vi.stubEnv("OP_PORTALS_VAULT", "Portals");
  vi.stubEnv("ANTHROPIC_API_KEY", "secret-anthropic");
  vi.stubEnv("BROWSERBASE_API_KEY", "secret-bb");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolvePortalCredentials (1Password path)", () => {
  it("C1: resolves OTP fresh on every call and never caches it", async () => {
    const first = await resolvePortalCredentials("lightreach", { withOtp: true });
    expect(first.otp).toBe("111111");

    // The TOTP rotates; a cached value would come back stale.
    op.responses.set("one-time password", "222222");
    const second = await resolvePortalCredentials("lightreach", { withOtp: true });
    expect(second.otp).toBe("222222");

    expect(opReadsMatching("one-time password")).toHaveLength(2);
  });

  it("C1: username and password stay cached across calls", async () => {
    await resolvePortalCredentials("lightreach", { withOtp: true });
    await resolvePortalCredentials("lightreach", { withOtp: true });
    expect(opReadsMatching("/username")).toHaveLength(1);
    expect(opReadsMatching("/password")).toHaveLength(1);
  });

  it("does not read the OTP field when withOtp is false", async () => {
    const creds = await resolvePortalCredentials("lightreach");
    expect(creds.otp).toBeUndefined();
    expect(opReadsMatching("one-time password")).toHaveLength(0);
  });

  it("S6: concurrent resolves share one in-flight op read (single-flight)", async () => {
    const [a, b, c] = await Promise.all([
      resolvePortalCredentials("lightreach"),
      resolvePortalCredentials("lightreach"),
      resolvePortalCredentials("lightreach"),
    ]);
    expect(a.username).toBe("user1");
    expect(b.username).toBe("user1");
    expect(c.username).toBe("user1");
    expect(opReadsMatching("/username")).toHaveLength(1);
    expect(opReadsMatching("/password")).toHaveLength(1);
  });

  it("M2: the op child receives a minimal env, never the process API keys", async () => {
    await resolvePortalCredentials("lightreach", { withOtp: true });
    expect(op.calls.length).toBeGreaterThan(0);
    const allowed = new Set(["OP_SERVICE_ACCOUNT_TOKEN", "HOME", "PATH"]);
    for (const call of op.calls) {
      expect(call.env.OP_SERVICE_ACCOUNT_TOKEN).toBe("tok_test");
      expect(call.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(call.env).not.toHaveProperty("BROWSERBASE_API_KEY");
      for (const key of Object.keys(call.env)) {
        expect(allowed.has(key), `unexpected env var passed to op: ${key}`).toBe(true);
      }
    }
  });
});

describe("resolvePortalCredentials (env fallback)", () => {
  beforeEach(() => {
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "");
    vi.stubEnv("PORTAL_LIGHTREACH_USERNAME", "envuser");
    vi.stubEnv("PORTAL_LIGHTREACH_PASSWORD", "envpw");
    vi.stubEnv("PORTAL_LIGHTREACH_OTP", "333333");
  });

  it("uses PORTAL_* env vars without touching op", async () => {
    const creds = await resolvePortalCredentials("lightreach", { withOtp: true });
    expect(creds).toEqual({ username: "envuser", password: "envpw", otp: "333333" });
    expect(op.calls).toHaveLength(0);
  });

  it("omits otp when withOtp is false", async () => {
    const creds = await resolvePortalCredentials("lightreach");
    expect(creds.otp).toBeUndefined();
  });

  it("throws a sanitized error when nothing is configured", async () => {
    vi.stubEnv("PORTAL_LIGHTREACH_USERNAME", "");
    vi.stubEnv("PORTAL_LIGHTREACH_PASSWORD", "");
    await expect(resolvePortalCredentials("lightreach")).rejects.toThrow(/No credentials/);
  });
});

describe("secretReferenceBase", () => {
  it("resolves a bare item name inside the configured portals vault", async () => {
    const { secretReferenceBase } = await import("../../src/gateway/secrets.js");
    const previous = process.env.OP_PORTALS_VAULT;
    process.env.OP_PORTALS_VAULT = "Portals";
    expect(secretReferenceBase("lightreach")).toBe("op://Portals/lightreach");
    process.env.OP_PORTALS_VAULT = previous;
  });

  it("passes a FULL op:// reference through untouched", async () => {
    // Daylight's two installer logins live in their own per-tenant vaults and
    // predate this service. Copying a live credential into the portals vault
    // would create a second place it can leak from and a second thing to
    // rotate, which is worse than reading the reference we were handed.
    const { secretReferenceBase } = await import("../../src/gateway/secrets.js");
    expect(secretReferenceBase("op://Daylight/qvohv6flztebotuucxtkyfneee")).toBe(
      "op://Daylight/qvohv6flztebotuucxtkyfneee",
    );
  });

  it("trims a trailing slash, which op rejects confusingly", async () => {
    const { secretReferenceBase } = await import("../../src/gateway/secrets.js");
    expect(secretReferenceBase("op://Daylight/item/")).toBe("op://Daylight/item");
  });

  it("defaults the vault name when none is configured", async () => {
    const { secretReferenceBase } = await import("../../src/gateway/secrets.js");
    const previous = process.env.OP_PORTALS_VAULT;
    delete process.env.OP_PORTALS_VAULT;
    expect(secretReferenceBase("x")).toBe("op://Portals/x");
    if (previous !== undefined) process.env.OP_PORTALS_VAULT = previous;
  });
});
