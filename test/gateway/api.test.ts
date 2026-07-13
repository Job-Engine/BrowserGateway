import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createJobStore, type JobStore } from "../../src/gateway/jobs/store.js";
import { createAuthStore } from "../../src/gateway/auth/tokens.js";
import { createLogger } from "../../src/gateway/observability/logger.js";
import { createRegistry } from "../../src/gateway/registry.js";
import { buildApp, type App } from "../../src/gateway/api/app.js";

let db: TestDb;
let app: App;
let store: JobStore;
let scopedToken: string;
let otherToken: string;
let lgcycoToken: string;
let adminToken: string;

const goodInput = { name: "Jane Homeowner", address: "123 Solar Way, Austin TX 78701" };

beforeAll(async () => {
  db = await createTestDb();
  store = createJobStore(db.pool);
  const auth = createAuthStore(db.pool);
  const registry = createRegistry(db.pool);
  await registry.seed();
  // Force the pairs this suite submits against to live (the lifecycle flow
  // itself is covered in registry.test.ts).
  await db.pool.query(
    `update action_clients set state = 'live'
     where use_case = 'lightreach.ntpDate' and client in ('default', 'brandx')`,
  );
  scopedToken = (await auth.issueToken("app-scoped", ["lightreach.ntpDate:default"])).token;
  otherToken = (await auth.issueToken("app-other", ["lightreach.ntpDate:default"])).token;
  lgcycoToken = (await auth.issueToken("app-lgcyco", ["lightreach.ntpDate:lgcyco"])).token;
  adminToken = (await auth.issueToken("ops-admin", ["*:*"], { isAdmin: true })).token;
  app = buildApp({ store, auth, logger: createLogger("silent"), registry });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.teardown();
});

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("auth surface (S2, fail closed)", () => {
  it("serves /health without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects missing and invalid tokens on every other route", async () => {
    for (const url of ["/catalogue", "/jobs/00000000-0000-0000-0000-000000000000"]) {
      const bare = await app.inject({ method: "GET", url });
      expect(bare.statusCode).toBe(401);
      const bad = await app.inject({ method: "GET", url, headers: authed("bgw_wrong") });
      expect(bad.statusCode).toBe(401);
    }
    const post = await app.inject({ method: "POST", url: "/jobs", payload: {} });
    expect(post.statusCode).toBe(401);
  });
});

describe("GET /catalogue", () => {
  it("returns v1-compatible useCases plus machine-readable actions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/catalogue",
      headers: authed(scopedToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.useCases).toContain("lightreach.ntpDate");
    const action = body.actions.find(
      (a: { useCase: string }) => a.useCase === "lightreach.ntpDate",
    );
    expect(action.platform).toBe("lightreach");
    expect(action.inputSchema.properties).toHaveProperty("name");
    expect(action.extractSchema.properties).toHaveProperty("ntpDate");
  });
});

describe("POST /jobs", () => {
  it("accepts a scoped submission and persists a QUEUED job", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(scopedToken),
      payload: { useCase: "lightreach.ntpDate", input: goodInput },
    });
    expect(res.statusCode).toBe(202);
    const { jobId, state } = res.json();
    expect(state).toBe("QUEUED");
    const row = await store.get(jobId);
    expect(row?.useCase).toBe("lightreach.ntpDate");
    expect(row?.client).toBe("default");
  });

  it("returns the same job on idempotent resubmission", async () => {
    const payload = {
      useCase: "lightreach.ntpDate",
      input: goodInput,
      idempotencyKey: "api-idem-1",
    };
    const first = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(scopedToken),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(scopedToken),
      payload,
    });
    expect(second.json().jobId).toBe(first.json().jobId);
  });

  it("403s a token without scope for the client", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(scopedToken),
      payload: { useCase: "lightreach.ntpDate", client: "brandx", input: goodInput },
    });
    expect(res.statusCode).toBe(403);
  });

  it("WL: accepts a rostered client with a wildcard scope and persists it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(adminToken),
      payload: { useCase: "lightreach.ntpDate", client: "brandx", input: goodInput },
    });
    expect(res.statusCode).toBe(202);
    const row = await store.get(res.json().jobId);
    expect(row?.client).toBe("brandx");
  });

  it("OPS: 403s a scoped caller whose pair is not live (first-live-run rule)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(lgcycoToken),
      payload: { useCase: "lightreach.ntpDate", client: "lgcyco", input: goodInput },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("not live");
  });

  it("WL: 400s a client that is not on the action's roster", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(adminToken),
      payload: { useCase: "lightreach.ntpDate", client: "ghost", input: goodInput },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unknown client");
  });

  it("400s unknown useCases and invalid input", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(scopedToken),
      payload: { useCase: "nope.nothing", input: goodInput },
    });
    expect(unknown.statusCode).toBe(400);
    const invalid = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(scopedToken),
      payload: { useCase: "lightreach.ntpDate", input: { name: "" } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().details.join(" ")).toContain("address");
  });

  it("S5: rejects oversized bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { ...authed(scopedToken), "content-type": "application/json" },
      payload: JSON.stringify({
        useCase: "lightreach.ntpDate",
        input: { name: "x".repeat(70 * 1024), address: "y" },
      }),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("GET /jobs/:id ownership (S1)", () => {
  it("shows a job to its submitter, hides it from other callers, shows it to admin", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(scopedToken),
      payload: { useCase: "lightreach.ntpDate", input: goodInput },
    });
    const { jobId } = created.json();

    const own = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: authed(scopedToken),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().state).toBe("QUEUED");

    const other = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: authed(otherToken),
    });
    expect(other.statusCode).toBe(404);

    const admin = await app.inject({
      method: "GET",
      url: `/jobs/${jobId}`,
      headers: authed(adminToken),
    });
    expect(admin.statusCode).toBe(200);
  });

  it("404s a malformed job id without touching the store", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/jobs/not-a-uuid",
      headers: authed(scopedToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /openapi.json and admin surface", () => {
  it("serves the OpenAPI document without auth and with the closed error enum", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.paths["/jobs"]).toBeDefined();
    expect(doc.components.schemas.JobEnvelope.properties.error.properties.code.enum).toContain(
      "MATCH_FAILED",
    );
    // No issued secret ever appears in the public document.
    for (const token of [scopedToken, adminToken]) {
      expect(JSON.stringify(doc)).not.toContain(token.slice(4));
    }
  });

  it("blocks non-admin callers from every /admin route", async () => {
    for (const url of ["/admin/stats", "/admin/jobs", "/admin/catalogue", "/admin/audit"]) {
      const res = await app.inject({ method: "GET", url, headers: authed(scopedToken) });
      expect(res.statusCode).toBe(403);
    }
  });

  it("admin can issue a scoped token whose plaintext appears exactly once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/tokens",
      headers: authed(adminToken),
      payload: { name: "new-app", scopes: ["lightreach.ntpDate:default"] },
    });
    expect(res.statusCode).toBe(201);
    const { token, caller } = res.json();
    expect(token).toMatch(/^bgw_/);
    const list = await app.inject({
      method: "GET",
      url: "/admin/tokens",
      headers: authed(adminToken),
    });
    const listed = list.json().callers.find((c: { id: string }) => c.id === caller.id);
    expect(listed.name).toBe("new-app");
    expect(JSON.stringify(listed)).not.toContain(token);
    // The new token works for its scope.
    const submit = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: authed(token),
      payload: { useCase: "lightreach.ntpDate", input: goodInput },
    });
    expect(submit.statusCode).toBe(202);
  });

  it("admin catalogue lists lifecycle state per pair", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/catalogue",
      headers: authed(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const pairs = res.json().pairs;
    const live = pairs.find(
      (p: { useCase: string; client: string }) =>
        p.useCase === "lightreach.ntpDate" && p.client === "default",
    );
    expect(live.clientState).toBe("live");
    const disabled = pairs.find((p: { client: string }) => p.client === "lgcyco");
    expect(disabled.clientState).toBe("disabled");
  });
});
