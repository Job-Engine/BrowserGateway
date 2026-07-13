// Per-pair canary status derived from the catalogue registry, plus a global
// "Run all" trigger. Alert routing (Slack webhook, thresholds) is configured in
// the gateway environment, not here, so this view surfaces the state read-only.
import { useState } from "react";
import { Icon } from "../components/Icon";
import { Empty, ErrorBanner, Loading, OutcomePill } from "../components/primitives";
import { useConfig } from "../lib/context";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useRoute, buildHash, navigate } from "../lib/router";
import { relativeTime } from "../lib/format";
import type { CataloguePair } from "../api/types";

function canaryPill(status: string | null) {
  if (!status) return <span className="chip">never run</span>;
  if (status === "success") return <OutcomePill status="success" label="success" />;
  if (status === "failure") return <OutcomePill status="failure" label="failure" />;
  return <OutcomePill status="error" label={status} />;
}

export function Canaries() {
  const { api } = useConfig();
  const { push } = useToast();
  const { params } = useRoute();
  const [running, setRunning] = useState(false);
  const { data, error, loading, reload } = useAsync(() => api.catalogue(), "canaries-catalogue");

  // Canaries only run for live pairs; also show any pair that has a recorded
  // canary verdict so a pair that was demoted still shows its last result.
  const rows: CataloguePair[] = (data?.pairs ?? []).filter(
    (p) => p.clientState === "live" || p.lastCanaryStatus,
  );
  const failing = rows.filter((p) => p.lastCanaryStatus && p.lastCanaryStatus !== "success");

  const runAll = () => {
    setRunning(true);
    api
      .runCanaries()
      .then((res) => {
        const n = res.enqueued.length;
        push(
          n
            ? `${n} canary ${n === 1 ? "run" : "runs"} enqueued`
            : "No live pairs have canary input yet",
        );
        // Verdicts land asynchronously; reload shortly to pick up new state.
        window.setTimeout(reload, 2500);
      })
      .catch((e: unknown) => push(e instanceof Error ? e.message : String(e), false))
      .finally(() => setRunning(false));
  };

  const focus = params.focus;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Canaries &amp; Alerts</h1>
          <div className="sub">
            Canaries run per platform-and-client pair, because each brand can break in its own way.
          </div>
        </div>
        <div className="hstack">
          <button className="btn btn-sm" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
          <button className="btn btn-primary" onClick={runAll} disabled={running}>
            <Icon name="play" />
            {running ? "Enqueuing" : "Run all"}
          </button>
        </div>
      </div>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}

      <div className="section-head">
        <h2>Canary matrix</h2>
        <span className="tag">{rows.length} pairs</span>
      </div>

      {loading && !data ? (
        <Loading label="Loading canaries" />
      ) : (
        <div className="tbl-wrap">
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>Use case / client</th>
                  <th>Last canary</th>
                  <th>Last run</th>
                  <th>Jobs</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((p) => {
                    const key = `${p.useCase}:${p.client}`;
                    return (
                      <tr key={key} className={focus === key ? "focus-row" : ""}>
                        <td className="mono">
                          {p.useCase} / {p.client}
                        </td>
                        <td>{canaryPill(p.lastCanaryStatus)}</td>
                        <td className="sm txt2">{relativeTime(p.lastCanaryAt)}</td>
                        <td>
                          <a
                            className="linkish sm"
                            href={buildHash("jobs", { useCase: p.useCase, client: p.client })}
                          >
                            view jobs
                          </a>
                        </td>
                        <td className="right nowrap">
                          <a
                            className="btn btn-sm btn-ghost"
                            href={buildHash("catalogue", { focus: key })}
                          >
                            <Icon name="catalogue" />
                            Pair
                          </a>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <Empty
                        icon="canary"
                        title="No canaries yet"
                        hint="Enable a pair (validate, record a test, then enable) to start scheduling canaries."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="note">
        <Icon name="info" />
        <div>
          Canary outcome is independent of credential health: a canary can be red from layout drift
          while the login is fine. A failing canary links to that pair&apos;s jobs so you can open
          the run that broke.
        </div>
      </div>

      <div className="section-head">
        <h2>Alerts</h2>
        <span className="tag">{failing.length} active</span>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Active canary alerts</h3>
        </div>
        {failing.length ? (
          <div className="run-strip">
            {failing.map((p) => {
              const key = `${p.useCase}:${p.client}`;
              return (
                <button
                  key={key}
                  className="att sev-danger"
                  style={{ boxShadow: "none" }}
                  onClick={() => navigate("jobs", { useCase: p.useCase, client: p.client })}
                >
                  <span className="att-ic">
                    <Icon name="canary" />
                  </span>
                  <span className="att-body">
                    <span className="t1">
                      {p.useCase} / {p.client} canary is {p.lastCanaryStatus}
                    </span>
                    <span className="t2">
                      Last run {relativeTime(p.lastCanaryAt)}. Open the pair&apos;s jobs to see the
                      failing run.
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="sm txt2">All canaries are green.</div>
        )}
        <div className="note" style={{ marginBottom: 0 }}>
          <Icon name="info" />
          <div>
            Alert delivery (Slack webhook and thresholds) is configured in the gateway environment.
            This console shows the resulting state; it does not edit alert rules.
          </div>
        </div>
      </div>
    </>
  );
}
