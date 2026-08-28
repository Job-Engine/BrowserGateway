// Live diagnosis harness: times each layer of a run in isolation so a stall
// can be attributed (credentials, session creation, navigation, observe,
// extract). Read-only; prints no secret values. Run:
//   set -a; source .env; set +a; npx tsx scripts/live-debug.ts
import { z } from "zod";
import { createSession } from "../src/browser.js";
import { resolveAction } from "../src/gateway/catalogue.js";
import { resolvePortalCredentials } from "../src/gateway/secrets.js";

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// Hard watchdog: this script must never hang the terminal.
const watchdog = setTimeout(() => {
  log("WATCHDOG: 240s elapsed, aborting");
  process.exit(2);
}, 240_000);
watchdog.unref();

const action = resolveAction("lightreach.ntpDate", "spartan");
log(`action resolved: url=${action.url} credentialItem=${action.credentialItem}`);

log("resolving credentials via op...");
const creds = await resolvePortalCredentials(action.credentialItem, { withOtp: true });
log(`credentials ok (username ${creds.username.slice(0, 2)}***, otp: ${Boolean(creds.otp)})`);

log("creating Browserbase session...");
const agent = await createSession({ env: "BROWSERBASE", model: "anthropic/claude-sonnet-4-6" });
log(
  `session up: id=${agent.sessionId ?? "(none)"} replayUrl=${agent.sessionReplayUrl ?? "(none)"}`,
);

try {
  log(`goto ${action.url} ...`);
  await agent.goto(action.url);
  log("goto done");

  log("extract: describe the current page (first LLM call)...");
  const page = await agent.extract(
    "Briefly describe this page: its title and the main visible elements. Do not include any personal data.",
    z.object({ title: z.string(), description: z.string() }),
  );
  log(`page: ${JSON.stringify(page)}`);

  log("observe: locate the login fields...");
  const candidates = await agent.observe(
    "Find the username or email input field of the login form",
  );
  log(
    `observe done: ${candidates.length} candidate(s); first: ${candidates[0]?.description ?? "(none)"} method=${candidates[0]?.method ?? "-"}`,
  );
} finally {
  log("closing session...");
  await agent.close().catch(() => {});
  log("closed");
}
