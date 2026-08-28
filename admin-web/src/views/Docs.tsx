// Static how-to-call reference: architecture, request lifecycle, status
// semantics, the closed error-code set, and a copy-ready curl example that uses
// the configured base URL and a real useCase from the catalogue.
import { useState } from "react";
import { Icon } from "../components/Icon";
import { CopyButton, LifecycleChip, OutcomePill, StateChip } from "../components/primitives";
import { useConfig } from "../lib/context";
import { useAsync } from "../lib/useAsync";

const LIFECYCLE_STEPS: [string, string][] = [
  ["Submit", "Caller POSTs { useCase, client, input } with a bearer token"],
  ["Authorize", "Token is checked against the useCase-by-client scope"],
  ["Resolve", "useCase maps to a platform action definition"],
  ["Validate", "Input is validated against the zod schema"],
  ["Merge override", "Client navigation override is merged onto the base"],
  ["Credentials", "The op:// item is read just in time from 1Password"],
  ["Launch", "A Browserbase session starts"],
  ["Login and verify", "Agent logs in, finds and verifies the record"],
  ["Execute", "The goal runs, output is checked against the locked extract schema"],
  ["Deliver", "The envelope is sealed and returned on the next poll"],
];

// The server's closed error-code set (packages/gateway-client ERROR_CODES) plus
// the stage each tends to arise in and whether it reads as failure or error.
const ERROR_CODES: { code: string; family: "failure" | "error"; meaning: string }[] = [
  { code: "INVALID_INPUT", family: "failure", meaning: "Input did not match the action schema" },
  {
    code: "AUTH_UNAVAILABLE",
    family: "error",
    meaning: "Credentials could not be read or were rejected",
  },
  {
    code: "MATCH_FAILED",
    family: "failure",
    meaning: "A record was found but identity did not verify",
  },
  {
    code: "NTP_FIELD_NOT_FOUND",
    family: "failure",
    meaning: "Verified record lacked the requested field",
  },
  {
    code: "GOAL_NOT_COMPLETED",
    family: "failure",
    meaning: "Agent finished without meeting the goal",
  },
  {
    code: "ACTION_BLOCKED",
    family: "error",
    meaning: "A non-read-only step was refused by the allowlist",
  },
  { code: "RUN_ERROR", family: "error", meaning: "The browser run failed mid-flight" },
  { code: "TIMEOUT", family: "error", meaning: "Run exceeded its wall-clock deadline" },
  { code: "GATEWAY_ERROR", family: "error", meaning: "Unexpected server-side failure" },
];

export function Docs() {
  const { api, config } = useConfig();
  const [stepIdx, setStepIdx] = useState(0);
  const cat = useAsync(() => api.callerCatalogue(), "docs-catalogue");
  const sampleUseCase = cat.data?.useCases[0] ?? "lightreach.milestoneStatus";

  const curl =
    `# 1. Submit a job\n` +
    `curl -sS -X POST ${config.baseUrl}/jobs \\\n` +
    `  -H "authorization: Bearer $GATEWAY_TOKEN" \\\n` +
    `  -H "content-type: application/json" \\\n` +
    `  -d '{\n` +
    `    "useCase": "${sampleUseCase}",\n` +
    `    "client": "default",\n` +
    `    "input": { "name": "Jane Q. Homeowner", "address": "123 Solar Way, Austin TX" }\n` +
    `  }'\n` +
    `# => { "jobId": "...", "state": "QUEUED" }\n\n` +
    `# 2. Poll until DONE\n` +
    `curl -sS ${config.baseUrl}/jobs/$JOB_ID \\\n` +
    `  -H "authorization: Bearer $GATEWAY_TOKEN"\n` +
    `# => { "jobId": "...", "state": "DONE", "envelope": { "status": "success", ... } }`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Docs</h1>
          <div className="sub">
            How a job flows through the gateway, and what each status means.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Architecture</h3>
        </div>
        <div className="arch">
          <div className="arch-stack">
            <div className="arch-box">
              <div className="t1">JobEngine apps</div>
              <div className="t2">callers</div>
            </div>
          </div>
          <div className="arch-arrow">
            <Icon name="arrow" className="ic-lg" />
          </div>
          <div className="arch-box gw" style={{ minWidth: 220 }}>
            <div className="t1">Gateway</div>
            <div className="t2">bearer auth, job store, queue</div>
            <div className="arch-inner">
              <span className="tag">catalogue</span>
              <span className="tag">registry</span>
              <span className="tag">secrets</span>
              <span className="tag">runner</span>
            </div>
          </div>
          <div className="arch-arrow">
            <Icon name="arrow" className="ic-lg" />
          </div>
          <div className="arch-stack">
            <div className="arch-box">
              <div className="t1">1Password</div>
              <div className="t2">credentials</div>
            </div>
            <div className="arch-box">
              <div className="t1">Browserbase</div>
              <div className="t2">browser sessions</div>
            </div>
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2>Call the gateway</h2>
        <CopyButton text={curl} label="Example" />
      </div>
      <pre>{curl}</pre>

      <div className="grid" style={{ gridTemplateColumns: "1.1fr 1fr", marginTop: 14 }}>
        <div className="card">
          <div className="card-head">
            <h3>Request lifecycle</h3>
            <span className="xs muted">click a step</span>
          </div>
          <div className="stepper">
            {LIFECYCLE_STEPS.map((s, i) => (
              <button
                key={s[0]}
                className={`step-btn${stepIdx === i ? " on" : ""}`}
                onClick={() => setStepIdx(i)}
              >
                <span className="step-num">{i + 1}</span>
                <span className="vstack">
                  <span className="st1">{s[0]}</span>
                  <span className="st2">{s[1]}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h3>Status semantics</h3>
            </div>
            <div className="vstack" style={{ gap: 12 }}>
              <div>
                <div className="xs muted" style={{ marginBottom: 6 }}>
                  OUTCOME (envelope status)
                </div>
                <div className="wrap-chips">
                  <OutcomePill status="success" />
                  <OutcomePill status="failure" />
                  <OutcomePill status="error" />
                </div>
                <div className="xs muted" style={{ marginTop: 6 }}>
                  success = data returned. failure = ran fine, business answer is negative (automate
                  on it). error = the run itself broke (alert on it).
                </div>
              </div>
              <div>
                <div className="xs muted" style={{ marginBottom: 6 }}>
                  JOB STATE (async lifecycle)
                </div>
                <div className="wrap-chips">
                  <StateChip state="QUEUED" />
                  <StateChip state="RUNNING" />
                  <StateChip state="DONE" />
                </div>
              </div>
              <div>
                <div className="xs muted" style={{ marginBottom: 6 }}>
                  CATALOGUE LIFECYCLE (per pair, first-live-run rule)
                </div>
                <div className="wrap-chips">
                  <LifecycleChip state="draft" />
                  <LifecycleChip state="validated" />
                  <LifecycleChip state="tested" />
                  <LifecycleChip state="live" />
                  <LifecycleChip state="disabled" />
                </div>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>Error-code taxonomy</h3>
            </div>
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Family</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {ERROR_CODES.map((e) => (
                    <tr key={e.code}>
                      <td className="mono xs">{e.code}</td>
                      <td>
                        <span
                          className="tag"
                          style={{
                            color: e.family === "error" ? "var(--danger)" : "var(--warning)",
                          }}
                        >
                          {e.family}
                        </span>
                      </td>
                      <td className="sm txt2">{e.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
