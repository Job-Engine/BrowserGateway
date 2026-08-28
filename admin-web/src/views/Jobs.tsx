// Jobs table with server-side state filter and client-side search/outcome/pair
// filters, plus a detail drawer showing the full envelope, replay link, input
// and per-step progress. Deep-linkable via ?job / ?useCase / ?client / ?state.
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import {
  CopyButton,
  Empty,
  ErrorBanner,
  Loading,
  OutcomePill,
  StateChip,
} from "../components/primitives";
import { Drawer } from "../components/Drawer";
import { useConfig } from "../lib/context";
import { useAsync } from "../lib/useAsync";
import { useRoute, buildHash, navigate } from "../lib/router";
import { elapsedSeconds, formatClock, formatDateTime, formatDuration } from "../lib/format";
import type { JobRow, JobStatus } from "../api/types";

function durationText(job: JobRow): string {
  if (job.state === "RUNNING") return `${elapsedSeconds(job.startedAt)}s`;
  return formatDuration(job.envelope?.meta.durationMs ?? null);
}

function JobTimeline({ state }: { state: JobRow["state"] }) {
  const order = ["accepted", "queued", "running", "done"];
  // accepted is always done; the rest track the async state machine.
  const activeIdx = state === "QUEUED" ? 1 : state === "RUNNING" ? 2 : 3;
  return (
    <div className="timeline">
      {order.map((label, i) => {
        const cls = i < activeIdx ? "done" : i === activeIdx ? "active" : "dim";
        return (
          <div className={`tl-step ${cls}`} key={label}>
            <div className="tl-mark">
              <div className="tl-dot">
                {cls === "done" ? (
                  <Icon name="check" />
                ) : cls === "active" ? (
                  <span className="pulse" />
                ) : null}
              </div>
              {i < order.length - 1 ? <div className="tl-line" /> : null}
            </div>
            <div className="tl-body">
              <div className="t1">{label}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function JobDetail({ job }: { job: JobRow }) {
  const [tab, setTab] = useState<"pretty" | "raw">("pretty");
  const env = job.envelope;
  const raw = env ? JSON.stringify(env, null, 2) : "(no envelope yet)";
  const inputText = (() => {
    try {
      return JSON.stringify(job.input, null, 2);
    } catch {
      return String(job.input);
    }
  })();

  return (
    <>
      <div className="kv">
        <span className="k">Use case</span>
        <span className="v">
          <a href={buildHash("catalogue", { focus: `${job.useCase}:${job.client}` })}>
            {job.useCase}
          </a>
        </span>
        <span className="k">Client</span>
        <span className="v">
          <span className="tag tag-mono">{job.client}</span>
        </span>
        <span className="k">Platform</span>
        <span className="v sm txt2">{job.platform}</span>
        <span className="k">Caller</span>
        <span className="v mono xs">{job.callerId}</span>
        <span className="k">State</span>
        <span className="v">
          <StateChip state={job.state} />
        </span>
        <span className="k">Outcome</span>
        <span className="v">
          {env ? <OutcomePill status={env.status} /> : <span className="muted">-</span>}
        </span>
        <span className="k">Attempts</span>
        <span className="v mono xs">{job.attempts}</span>
        <span className="k">Created</span>
        <span className="v sm txt2">{formatDateTime(job.createdAt)}</span>
        <span className="k">Finished</span>
        <span className="v sm txt2">{formatDateTime(job.finishedAt)}</span>
      </div>

      {job.state !== "DONE" ? (
        <>
          <div className="section-head">
            <h2>Progress</h2>
          </div>
          <JobTimeline state={job.state} />
        </>
      ) : null}

      <div className="section-head">
        <h2>Session replay</h2>
      </div>
      {env?.meta.sessionReplayUrl ? (
        <a
          className="replay"
          href={env.meta.sessionReplayUrl}
          target="_blank"
          rel="noreferrer"
          style={{ textDecoration: "none" }}
        >
          <div className="play">
            <Icon name="play" className="ic-lg ic-fill" />
          </div>
          <div className="cap">Open session replay · {env.meta.sessionId ?? "session"}</div>
        </a>
      ) : (
        <div className="note" style={{ marginTop: 0 }}>
          <Icon name="info" />
          <div>No replay URL yet. It appears once the run starts a Browserbase session.</div>
        </div>
      )}

      <div className="section-head">
        <h2>Input</h2>
      </div>
      <pre>{inputText}</pre>

      <div className="section-head">
        <h2>Envelope</h2>
        <div className="hstack">
          <span className="tabset">
            <button className={tab === "pretty" ? "on" : ""} onClick={() => setTab("pretty")}>
              Pretty
            </button>
            <button className={tab === "raw" ? "on" : ""} onClick={() => setTab("raw")}>
              Raw
            </button>
          </span>
          <CopyButton text={raw} label="Envelope" />
        </div>
      </div>
      {tab === "raw" || !env ? (
        <pre>{raw}</pre>
      ) : (
        <div className="kv" style={{ gridTemplateColumns: "120px 1fr" }}>
          <span className="k">status</span>
          <span className="v">
            <OutcomePill status={env.status} />
          </span>
          {env.data !== undefined && env.data !== null ? (
            <>
              <span className="k">data</span>
              <span className="v mono xs">{JSON.stringify(env.data)}</span>
            </>
          ) : null}
          {env.error ? (
            <>
              <span className="k">error.code</span>
              <span className="v">
                <span className="tag tag-warning">{env.error.code}</span>
              </span>
              <span className="k">error.message</span>
              <span className="v sm">{env.error.message}</span>
            </>
          ) : null}
          <span className="k">sessionId</span>
          <span className="v mono xs">{env.meta.sessionId ?? "-"}</span>
          <span className="k">durationMs</span>
          <span className="v mono xs">{env.meta.durationMs}</span>
          <span className="k">attempts</span>
          <span className="v mono xs">{env.meta.attempts}</span>
          {env.meta.stepsUsed !== undefined ? (
            <>
              <span className="k">stepsUsed</span>
              <span className="v mono xs">{env.meta.stepsUsed}</span>
            </>
          ) : null}
          <span className="k">ranAt</span>
          <span className="v mono xs">{env.meta.ranAt}</span>
        </div>
      )}
    </>
  );
}

function JobDrawer({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const { api } = useConfig();
  const { data, loading, error } = useAsync(
    () => (jobId ? api.job(jobId) : Promise.resolve(null)),
    `job-detail-${jobId ?? "none"}`,
  );

  return (
    <Drawer
      open={jobId !== null}
      onClose={onClose}
      icon="jobs"
      title={jobId ? `Job ${jobId.slice(0, 8)}` : ""}
      subtitle={data?.useCase}
      footer={
        <>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {loading && !data ? (
        <Loading label="Loading job" />
      ) : error ? (
        <ErrorBanner error={error} />
      ) : data ? (
        <JobDetail job={data} />
      ) : null}
    </Drawer>
  );
}

export function Jobs() {
  const { api } = useConfig();
  const { params } = useRoute();
  const [stateFilter, setStateFilter] = useState(params.state ?? "");
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState(params.outcome ?? "");
  const [useCase, setUseCase] = useState(params.useCase ?? "");
  const [client, setClient] = useState(params.client ?? "");
  const [openId, setOpenId] = useState<string | null>(params.job ?? null);

  // React to cross-link params (Home, Canaries, Catalogue deep-links).
  useEffect(() => {
    if (params.state !== undefined) setStateFilter(params.state);
    setUseCase(params.useCase ?? "");
    setClient(params.client ?? "");
    setOutcome(params.outcome ?? "");
    if (params.job) setOpenId(params.job);
  }, [params.state, params.useCase, params.client, params.outcome, params.job]);

  const { data, error, loading, reload } = useAsync(
    () => api.jobs({ state: stateFilter || undefined, limit: 200 }),
    `jobs-${stateFilter}`,
  );

  const rows = useMemo(() => {
    const all = data?.jobs ?? [];
    const q = search.trim().toLowerCase();
    return all.filter((j) => {
      if (useCase && j.useCase !== useCase) return false;
      if (client && j.client !== client) return false;
      if (outcome && j.envelope?.status !== outcome) return false;
      if (q) {
        const hay = `${j.id} ${j.useCase} ${j.client} ${j.platform} ${j.callerId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, search, useCase, client, outcome]);

  const filtered = useCase || client || outcome || search;
  const clearFilters = () => {
    setSearch("");
    setOutcome("");
    setUseCase("");
    setClient("");
    navigate("jobs");
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <div className="sub">Every run, newest first. Click a row for the full envelope.</div>
        </div>
        <button className="btn btn-sm" onClick={reload}>
          <Icon name="refresh" />
          Refresh
        </button>
      </div>

      <div className="toolbar">
        <div className="input-icon grow">
          <Icon name="search" />
          <input
            type="text"
            value={search}
            placeholder="Search job id, use case, client, caller"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="">All states</option>
          <option value="QUEUED">queued</option>
          <option value="RUNNING">running</option>
          <option value="DONE">done</option>
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">All outcomes</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
          <option value="error">error</option>
        </select>
        {filtered ? (
          <button className="btn btn-ghost btn-sm" onClick={clearFilters}>
            Clear
          </button>
        ) : null}
      </div>

      {useCase || client ? (
        <div className="wrap-chips" style={{ marginBottom: 12 }}>
          <span className="xs muted">filtered to pair:</span>
          {useCase ? <span className="tag tag-mono">{useCase}</span> : null}
          {client ? <span className="tag tag-mono">{client}</span> : null}
        </div>
      ) : null}

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      {loading && !data ? (
        <Loading label="Loading jobs" />
      ) : (
        <div className="tbl-wrap">
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>Job id</th>
                  <th>Use case</th>
                  <th>Client</th>
                  <th>Platform</th>
                  <th>State</th>
                  <th>Outcome</th>
                  <th className="right">Duration</th>
                  <th className="right">Started</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((j) => (
                    <tr key={j.id} className="tbl-row click" onClick={() => setOpenId(j.id)}>
                      <td className="mono">{j.id.slice(0, 8)}</td>
                      <td className="mono">{j.useCase}</td>
                      <td>
                        <span className="tag tag-mono">{j.client}</span>
                      </td>
                      <td className="sm txt2">{j.platform}</td>
                      <td>
                        <StateChip state={j.state} />
                      </td>
                      <td>
                        {j.envelope ? (
                          <OutcomePill status={j.envelope.status as JobStatus} />
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td className="right nowrap">{durationText(j)}</td>
                      <td className="right nowrap sm txt2">{formatClock(j.createdAt)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8}>
                      <Empty
                        icon="search"
                        title="No jobs match"
                        hint="Try clearing the search or the filters above."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <JobDrawer jobId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}
