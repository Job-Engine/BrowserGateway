// Full live run with a visible event stream, outside the gateway: used to
// validate and correct the catalogue's assumed flow against the real portal.
// Secrets are redacted by the loop before events are emitted. Run:
//   set -a; source .env; set +a; npx tsx scripts/live-run.ts "<name>" "<address>" [client]
import { runAgent } from "../src/index.js";
import { READ_ONLY_METHODS } from "../src/types.js";
import { resolveAction } from "../src/gateway/catalogue.js";
import { resolvePortalCredentials } from "../src/gateway/secrets.js";

const [name, address, client = "spartan"] = process.argv.slice(2);
if (!name || !address) {
  console.error('usage: tsx scripts/live-run.ts "<name>" "<address>" [client]');
  process.exit(1);
}

const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const action = resolveAction("lightreach.ntpDate", client);
const creds = await resolvePortalCredentials(action.credentialItem, { withOtp: true });
const credentials: Record<string, string> = {
  username: creds.username,
  password: creds.password,
};
if (creds.otp) credentials.otp = creds.otp;
log(`starting run: client=${client} url=${action.url}`);

const result = await runAgent({
  url: action.url,
  goal: action.buildGoal({ name, address }, { hasOtp: Boolean(creds.otp) }),
  data: { name, address },
  credentials,
  extractSchema: action.extractSchema,
  allowedMethods: READ_ONLY_METHODS,
  timeoutMs: action.timeoutMs ?? 600_000,
  maxSteps: 30,
  onEvent: (e) => {
    switch (e.type) {
      case "planned":
        log(`step ${e.step} plan: ${e.instruction}${e.isDone ? " [DONE]" : ""}`);
        break;
      case "observed":
        log(
          `step ${e.step} observed: ${e.action ? `${e.action.method ?? "?"} -> ${e.action.description}` : "(no element found)"}`,
        );
        break;
      case "acted":
        log(`step ${e.step} acted: ${e.outcome}${e.message ? ` (${e.message.slice(0, 80)})` : ""}`);
        break;
      case "done":
        log(`loop done: ${e.status}`);
        break;
    }
  },
});

log(`status=${result.status} steps=${result.stepsUsed}`);
log(`summary: ${result.summary}`);
log(`sessionId: ${result.sessionId ?? "(none)"}`);
log(`replay: ${result.sessionReplayUrl ?? "(none)"}`);
log(`extracted: ${JSON.stringify(result.extractedData, null, 2)}`);
process.exit(result.success ? 0 : 1);
