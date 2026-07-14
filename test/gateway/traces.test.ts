import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createTraceStore, type TraceStore } from "../../src/gateway/traces.js";

let db: TestDb;
let store: TraceStore;

const KEY = { useCase: "lightreach.ntpDate", client: "spartan" };
const steps = [
  {
    selector: "xpath=/html[1]/body[1]/div[1]/input[1]",
    method: "fill",
    arguments: ["%username%"],
    description: "Type %username% into the Email field",
    paramTemplate: null,
  },
];
const readSelectors = { matchedName: "xpath=/html[1]/body[1]/h1[1]" };

beforeAll(async () => {
  db = await createTestDb();
  store = createTraceStore(db.pool);
});
afterAll(async () => {
  await db.teardown();
});

describe("trace store", () => {
  it("saves an active trace at version 1 and finds it", async () => {
    const row = await store.saveTrace({
      ...KEY,
      steps,
      readSelectors,
      activate: true,
      secretValues: ["hunter2"],
    });
    expect(row.version).toBe(1);
    expect(row.state).toBe("active");
    const active = await store.getActive(KEY.useCase, KEY.client);
    expect(active?.id).toBe(row.id);
    expect(active?.steps).toEqual(steps);
  });

  it("bumps the version and retires the previous active on re-save", async () => {
    const v2 = await store.saveTrace({
      ...KEY,
      steps,
      readSelectors,
      activate: true,
      secretValues: [],
    });
    expect(v2.version).toBe(2);
    const active = await store.getActive(KEY.useCase, KEY.client);
    expect(active?.version).toBe(2);
    const all = await store.list(KEY.useCase);
    expect(all.filter((t) => t.state === "active")).toHaveLength(1);
  });

  it("carries heal_count forward and increments it on healed saves", async () => {
    const healed = await store.saveTrace({
      ...KEY,
      steps,
      readSelectors,
      activate: true,
      healed: true,
      secretValues: [],
    });
    expect(healed.healCount).toBe(1);
  });

  it("stores retired (not active) when activate is false", async () => {
    const inactive = await store.saveTrace({
      useCase: "lightreach.ntpDate",
      client: "lgcyco",
      steps,
      readSelectors: {},
      activate: false,
      secretValues: [],
    });
    expect(inactive.state).toBe("retired");
    expect(await store.getActive("lightreach.ntpDate", "lgcyco")).toBeNull();
  });

  it("rejects a trace containing a credential literal", async () => {
    const leaky = [{ ...steps[0], arguments: ["hunter2"] }];
    await expect(
      store.saveTrace({
        ...KEY,
        steps: leaky,
        readSelectors,
        activate: true,
        secretValues: ["hunter2"],
      }),
    ).rejects.toThrow(/credential/i);
  });

  it("records success and invalidates", async () => {
    const active = await store.getActive(KEY.useCase, KEY.client);
    await store.recordSuccess(active!.id);
    const after = await store.getActive(KEY.useCase, KEY.client);
    expect(after?.lastSuccessAt).toBeTruthy();
    expect(await store.invalidate(KEY.useCase, KEY.client)).toBe(true);
    expect(await store.getActive(KEY.useCase, KEY.client)).toBeNull();
    expect(await store.invalidate(KEY.useCase, KEY.client)).toBe(false);
  });
});
