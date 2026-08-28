// Triage: what is wrong now. Attention feed (red canaries, error-heavy pairs,
// backlog, long-runners), headline stats, a recent runs-by-outcome chart, and
// the currently running strip. Everything deep-links into the relevant view.
import { useMemo } from "react";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { ErrorBanner, Loading, StateChip } from "../components/primitives";
import { useConfig } from "../lib/context";
import { useAsync } from "../lib/useAsync";
import { navigate, buildHash } from "../lib/router";
import { elapsedSeconds } from "../lib/format";
import type { CataloguePair, JobRow, StatsResponse } from "../api/types";

interface AttentionCard {
  sev: "danger" | "warning" | "info";
  icon: IconName;
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}

const RUN_BUDGET_S = 180;

function buildAttention(
  jobs: JobRow[],
  pairs: CataloguePair[],
  stats: StatsResponse,
): AttentionCard[] {
  const cards: AttentionCard[] = [];

  for (const p of pairs.filter((x) => x.lastCanaryStatus && x.lastCanaryStatus !== "success")) {
    cards.push({
      sev: "danger",
      icon: "canary",
      title: `${p.useCase} / ${p.client} canary is ${p.lastCanaryStatus}`,
      body: "The last scheduled canary did not pass. Open the pair's jobs to see the failing run.",
      cta: "View jobs",
      onClick: () => navigate("jobs", { useCase: p.useCase, client: p.client }),
    });
  }

  // Error-heavy pairs from the recent job sample.
  const byPair = new Map<
    string,
    { useCase: string; client: string; errors: number; total: number }
  >();
  for (const j of jobs) {
    if (j.state !== "DONE" || !j.envelope) continue;
    const key = `${j.useCase}:${j.client}`;
    const cur = byPair.get(key) ?? { useCase: j.useCase, client: j.client, errors: 0, total: 0 };
    cur.total += 1;
    if (j.envelope.status === "error") cur.errors += 1;
    byPair.set(key, cur);
  }
  for (const p of byPair.values()) {
    if (p.errors >= 2) {
      cards.push({
        sev: "warning",
        icon: "activity",
        title: `${p.useCase} / ${p.client} is erroring`,
        body: `${p.errors} of ${p.total} recent runs errored. Investigate the portal or the credential.`,
        cta: "View error jobs",
        onClick: () => navigate("jobs", { useCase: p.useCase, client: p.client, outcome: "error" }),
      });
    }
  }

  if (stats.jobs.QUEUED > 5) {
    cards.push({
      sev: "info",
      icon: "inbox",
      title: `${stats.jobs.QUEUED} jobs queued`,
      body: "The queue is backing up. Check that the worker is claiming jobs under its caps.",
      cta: "View queued",
      onClick: () => navigate("jobs", { state: "QUEUED" }),
    });
  }

  for (const j of jobs.filter((x) => x.state === "RUNNING")) {
    if (elapsedSeconds(j.startedAt) > RUN_BUDGET_S - 30) {
      cards.push({
        sev: "warning",
        icon: "clock",
        title: `Job ${j.id.slice(0, 8)} may be stuck`,
        body: `${j.useCase} / ${j.client} has been running ${elapsedSeconds(
          j.startedAt,
        )}s, close to the ${RUN_BUDGET_S}s budget.`,
        cta: "Open job",
        onClick: () => navigate("jobs", { job: j.id }),
      });
    }
  }

  return cards;
}

export function Home() {
  const { api } = useConfig();
  const stats = useAsync(() => api.stats(), "home-stats");
  const jobsData = useAsync(() => api.jobs({ limit: 200 }), "home-jobs");
  const catalogue = useAsync(() => api.catalogue(), "home-catalogue");

  const jobs = useMemo(() => jobsData.data?.jobs ?? [], [jobsData.data]);
  const pairs = catalogue.data?.pairs ?? [];

  const done = useMemo(() => jobs.filter((j) => j.state === "DONE" && j.envelope), [jobs]);
  const outcomeCounts = useMemo(() => {
    const c = { success: 0, failure: 0, error: 0 };
    for (const j of done) {
      const s = j.envelope?.status;
      if (s === "success") c.success += 1;
      else if (s === "failure") c.failure += 1;
      else if (s === "error") c.error += 1;
    }
    return c;
  }, [done]);

  const successRate = done.length
    ? Math.round((outcomeCounts.success / done.length) * 1000) / 10
    : null;

  const medianDuration = useMemo(() => {
    const durs = done
      .map((j) => j.envelope?.meta.durationMs)
      .filter((d): d is number => typeof d === "number")
      .sort((a, b) => a - b);
    if (!durs.length) return null;
    return durs[Math.floor(durs.length / 2)];
  }, [done]);

  const days = useMemo(() => {
    const buckets: { label: string; key: string; ok: number; fail: number; err: number }[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      buckets.push({
        label: d.toLocaleDateString(undefined, { weekday: "short" }),
        key: d.toDateString(),
        ok: 0,
        fail: 0,
        err: 0,
      });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const j of done) {
      const b = byKey.get(new Date(j.finishedAt ?? j.createdAt).toDateString());
      if (!b) continue;
      const s = j.envelope?.status;
      if (s === "success") b.ok += 1;
      else if (s === "failure") b.fail += 1;
      else if (s === "error") b.err += 1;
    }
    return buckets;
  }, [done]);
  const maxDay = Math.max(1, ...days.map((d) => d.ok + d.fail + d.err));

  const running = useMemo(() => jobs.filter((j) => j.state === "RUNNING"), [jobs]);
  const attention = useMemo(
    () => (stats.data ? buildAttention(jobs, pairs, stats.data) : []),
    [jobs, pairs, stats.data],
  );

  const loading = stats.loading && !stats.data && jobsData.loading && !jobsData.data;
  const error = stats.error ?? jobsData.error ?? catalogue.error;

  const kpis: { key: string; icon: IconName; value: string; desc: string; cls?: string }[] = [
    {
      key: "recent",
      icon: "jobs",
      value: String(jobs.length),
      desc: "recent jobs in view",
    },
    {
      key: "success",
      icon: "check",
      value: successRate == null ? "-" : `${successRate}%`,
      desc: `success ${outcomeCounts.success}, failure ${outcomeCounts.failure}, error ${outcomeCounts.error}`,
      cls:
        successRate == null
          ? undefined
          : successRate >= 85
            ? "v-ok"
            : successRate >= 70
              ? "v-warn"
              : "v-bad",
    },
    {
      key: "running",
      icon: "activity",
      value: String(stats.data?.jobs.RUNNING ?? 0),
      desc: "sessions running now",
    },
    {
      key: "queued",
      icon: "inbox",
      value: String(stats.data?.jobs.QUEUED ?? 0),
      desc: "jobs waiting to claim",
    },
    {
      key: "errors",
      icon: "alert",
      value: String(outcomeCounts.error),
      desc: "error outcomes (recent)",
      cls: outcomeCounts.error ? "v-bad" : "v-ok",
    },
    {
      key: "median",
      icon: "clock",
      value: medianDuration == null ? "-" : `${Math.round(medianDuration / 1000)}s`,
      desc: "median run duration",
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">Triage</h1>
          <div className="sub">
            A live read across all platforms and clients. Fix what is red first.
          </div>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => {
            stats.reload();
            jobsData.reload();
            catalogue.reload();
          }}
        >
          <Icon name="refresh" />
          Refresh
        </button>
      </div>

      {error ? (
        <ErrorBanner
          error={error}
          onRetry={() => {
            stats.reload();
            jobsData.reload();
            catalogue.reload();
          }}
        />
      ) : null}

      {loading ? (
        <Loading label="Loading triage" />
      ) : (
        <>
          {attention.length ? (
            <>
              <div className="section-head">
                <h2>Needs attention</h2>
                <span className="tag">{attention.length} items</span>
              </div>
              <div className="feed">
                {attention.map((c, i) => (
                  <button key={i} className={`att sev-${c.sev}`} onClick={c.onClick}>
                    <span className="att-ic">
                      <Icon name={c.icon} />
                    </span>
                    <span className="att-body">
                      <span className="t1">{c.title}</span>
                      <span className="t2">{c.body}</span>
                      <span className="t3">
                        {c.cta} <Icon name="arrow" />
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="note accent">
              <Icon name="check" />
              <div>Nothing red right now. No failing canaries, error-heavy pairs, or backlog.</div>
            </div>
          )}

          <div
            className="grid"
            style={{
              gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
              margin: "24px 0",
            }}
          >
            {kpis.map((s) => (
              <div className="stat" key={s.key}>
                <div className="k">
                  <Icon name={s.icon} />
                  {kpiLabel(s.key)}
                </div>
                <div className={`v ${s.cls ?? ""}`}>{s.value}</div>
                <div className="d">{s.desc}</div>
              </div>
            ))}
          </div>

          <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
            <div className="card">
              <div className="card-head">
                <h3>Recent runs per day</h3>
                <span className="xs muted">stacked by outcome</span>
              </div>
              <div className="bars">
                {days.map((d) => {
                  const h = (v: number) => ((v / maxDay) * 128).toFixed(1);
                  return (
                    <div className="bar-col" key={d.key}>
                      <div className="bar-stack">
                        <div
                          className="seg-ok"
                          style={{ height: `${h(d.ok)}px` }}
                          title={`${d.ok} success`}
                        />
                        <div
                          className="seg-fail"
                          style={{ height: `${h(d.fail)}px` }}
                          title={`${d.fail} failure`}
                        />
                        <div
                          className="seg-err"
                          style={{ height: `${h(d.err)}px` }}
                          title={`${d.err} error`}
                        />
                      </div>
                      <div className="bar-lbl">{d.label}</div>
                    </div>
                  );
                })}
              </div>
              <div className="legend">
                <span>
                  <i className="seg-ok" />
                  success
                </span>
                <span>
                  <i className="seg-fail" />
                  failure
                </span>
                <span>
                  <i className="seg-err" />
                  error
                </span>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Running now</h3>
                <span className="tag">{running.length}</span>
              </div>
              {running.length ? (
                <div className="run-strip">
                  {running.map((j) => {
                    const el = elapsedSeconds(j.startedAt);
                    const pct = Math.min(96, Math.round((el / RUN_BUDGET_S) * 100));
                    return (
                      <a key={j.id} className="run-item" href={buildHash("jobs", { job: j.id })}>
                        <div className="hstack">
                          <span className="mono">{j.id.slice(0, 8)}</span>
                          <StateChip state="RUNNING" />
                        </div>
                        <div className="right sm muted">
                          {el}s / {RUN_BUDGET_S}s
                        </div>
                        <div className="mono xs muted" style={{ gridColumn: "1 / -1" }}>
                          {j.useCase} · {j.client}
                        </div>
                        <div className="prog">
                          <div style={{ width: `${pct}%` }} />
                        </div>
                      </a>
                    );
                  })}
                </div>
              ) : (
                <div className="empty">
                  <Icon name="activity" />
                  <div className="t2">No sessions running</div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function kpiLabel(key: string): string {
  switch (key) {
    case "recent":
      return "Recent jobs";
    case "success":
      return "Success rate";
    case "running":
      return "Running now";
    case "queued":
      return "Queued";
    case "errors":
      return "Errors";
    case "median":
      return "Median duration";
    default:
      return key;
  }
}
