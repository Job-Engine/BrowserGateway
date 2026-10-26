import { describe, expect, it, vi } from "vitest";

/**
 * The LightReach code-action's session economics (issue #467).
 *
 * `runLightreachBatch` accepts a warm session and returns "(possibly refreshed)
 * session, FOR REUSE ACROSS RUNS" with a 23h TTL — but the handler never passed
 * one in and dropped the one it got back, so every job logged in fresh.
 *
 * Measured in prod 2026-09-04: two create-polls at 15:02 and 15:03 consumed both
 * slots of `loginsPerHour: 2`, and a refresh run at 15:08 got
 * "login budget exhausted" on all 7 accounts. The 2h sweep is routinely starved
 * by create-polls, which is why a 14-deal backlog was draining at ~8 per 2h.
 */

const { loginMock, getMock, bodies } = vi.hoisted(() => {
  const bodies = new Map<string, unknown>();
  const loginMock = vi.fn(async () => ({
    cookieHeader: `jar-${loginMock.mock.calls.length}`,
    capturedAt: Date.now(),
  }));
  const getMock = vi.fn(async (url: string) => {
    const body = bodies.get(url);
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: async () => body,
    };
  });
  return { loginMock, getMock, bodies };
});

vi.mock("../../../src/portals/lightreach/login.js", () => ({
  loginLightreach: loginMock,
  httpGetWithCookie: getMock,
}));

const { lightreachSnapshotHandler } = await import("../../../src/portals/lightreach/action.js");

function seed(id: string) {
  bodies.set(`https://palmetto.finance/api/v2/accounts/${id}`, {
    id,
    milestones: [
      {
        name: "Notice to Proceed",
        status: "approved",
        completed: true,
        completedAt: "2026-08-21T00:00:00.000Z",
      },
    ],
  });
  bodies.set(`https://palmetto.finance/api/accounts/${id}/stipulations`, []);
  bodies.set(`https://palmetto.finance/api/accounts/${id}/applications`, [
    { creditExpiryDate: "2027-02-17T00:00:00.000Z" },
  ]);
}

const CREDS = { username: "u", password: "p" };

describe("lightreachSnapshotHandler — warm session reuse", () => {
  it("⭐ logs in ONCE across three jobs, so a 2/hour login budget is not exhausted", async () => {
    // A distinct client gets a fresh process-scoped PolitenessBudget.
    const client = "t-reuse";
    ["r1", "r2", "r3"].forEach(seed);

    const outcomes: Array<{ results: Array<{ status: string; error?: string }> }> = [];
    for (const id of ["r1", "r2", "r3"]) {
      outcomes.push(
        (await lightreachSnapshotHandler({
          input: { accountIds: [id] },
          credentials: CREDS,
          client,
        })) as { results: Array<{ status: string; error?: string }> },
      );
    }

    // The symptom: the third job is the one that died in prod.
    const errors = outcomes.flatMap((o) => o.results).filter((r) => r.status !== "success");
    expect(errors).toEqual([]);
    expect(loginMock.mock.calls.length).toBe(1);
  });

  it("keeps sessions separate per client — one client's jar is never served to another", async () => {
    ["a1", "b1"].forEach(seed);
    await lightreachSnapshotHandler({ input: { accountIds: ["a1"] }, credentials: CREDS, client: "t-iso-a" });
    const before = loginMock.mock.calls.length;
    await lightreachSnapshotHandler({ input: { accountIds: ["b1"] }, credentials: CREDS, client: "t-iso-b" });
    // A different client must NOT reuse the first client's session.
    expect(loginMock.mock.calls.length).toBe(before + 1);
  });
});
