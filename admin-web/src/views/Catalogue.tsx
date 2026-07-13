// Catalogue lifecycle. Actions (per useCase) validate draft -> validated;
// pairs (per useCase-client) walk record-test -> enable(live) / disable, with
// the first-live-run rule enforced server-side. Each pair cross-links to its
// jobs and its canary.
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { Empty, ErrorBanner, Loading, LifecycleChip, OutcomePill } from "../components/primitives";
import { Modal, ConfirmDialog } from "../components/Modal";
import { useConfig } from "../lib/context";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { useRoute, buildHash } from "../lib/router";
import { relativeTime, formatClock } from "../lib/format";
import type { ActionState, CataloguePair, JobRow } from "../api/types";

interface ActionGroup {
  useCase: string;
  platform: string;
  actionState: ActionState;
  pairs: CataloguePair[];
}

function canaryCell(status: string | null) {
  if (!status) return <span className="muted xs">no canary</span>;
  if (status === "success") return <OutcomePill status="success" label="success" />;
  if (status === "failure") return <OutcomePill status="failure" label="failure" />;
  return <OutcomePill status="error" label={status} />;
}

export function Catalogue() {
  const { api } = useConfig();
  const { push } = useToast();
  const { params } = useRoute();
  const catalogue = useAsync(() => api.catalogue(), "catalogue-pairs");
  const jobsData = useAsync(() => api.jobs({ limit: 200 }), "catalogue-jobs");

  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ useCase: string; items: string[] } | null>(null);
  const [record, setRecord] = useState<{ useCase: string; client: string } | null>(null);
  const [recordJobId, setRecordJobId] = useState("");
  const [confirmDisable, setConfirmDisable] = useState<{ useCase: string; client: string } | null>(
    null,
  );

  const groups: ActionGroup[] = useMemo(() => {
    const map = new Map<string, ActionGroup>();
    for (const p of catalogue.data?.pairs ?? []) {
      let g = map.get(p.useCase);
      if (!g) {
        g = { useCase: p.useCase, platform: p.platform, actionState: p.actionState, pairs: [] };
        map.set(p.useCase, g);
      }
      g.pairs.push(p);
    }
    return Array.from(map.values());
  }, [catalogue.data]);

  const candidateJobs: JobRow[] = useMemo(() => {
    if (!record) return [];
    return (jobsData.data?.jobs ?? []).filter(
      (j) =>
        j.useCase === record.useCase &&
        j.client === record.client &&
        j.state === "DONE" &&
        j.envelope?.status === "success",
    );
  }, [record, jobsData.data]);

  const reloadAll = () => {
    catalogue.reload();
    jobsData.reload();
  };

  const validate = (useCase: string) => {
    setBusy(`validate:${useCase}`);
    api
      .validateAction(useCase)
      .then((res) => {
        if ("problems" in res) {
          setProblems({ useCase, items: res.problems });
          push(`${useCase}: ${res.problems.length} problem(s)`, false);
        } else {
          push(`${useCase} validated`);
          catalogue.reload();
        }
      })
      .catch((e: unknown) => push(e instanceof Error ? e.message : String(e), false))
      .finally(() => setBusy(null));
  };

  const enable = (useCase: string, client: string) => {
    setBusy(`enable:${useCase}:${client}`);
    api
      .enablePair(useCase, client)
      .then((res) => {
        if ("reason" in res) {
          push(res.reason, false);
        } else {
          push(`${useCase} / ${client} is live`);
          catalogue.reload();
        }
      })
      .catch((e: unknown) => push(e instanceof Error ? e.message : String(e), false))
      .finally(() => setBusy(null));
  };

  const submitRecord = () => {
    if (!record) return;
    const jobId = recordJobId.trim();
    if (!jobId) {
      push("Choose or paste a job id.", false);
      return;
    }
    setBusy(`record:${record.useCase}:${record.client}`);
    api
      .recordTest(record.useCase, record.client, jobId)
      .then((res) => {
        if ("reason" in res) {
          push(res.reason, false);
        } else {
          push(`Test recorded for ${record.useCase} / ${record.client}`);
          setRecord(null);
          setRecordJobId("");
          catalogue.reload();
        }
      })
      .catch((e: unknown) => push(e instanceof Error ? e.message : String(e), false))
      .finally(() => setBusy(null));
  };

  const doDisable = () => {
    if (!confirmDisable) return;
    const { useCase, client } = confirmDisable;
    setBusy(`disable:${useCase}:${client}`);
    api
      .disablePair(useCase, client)
      .then(() => {
        push(`${useCase} / ${client} disabled`);
        setConfirmDisable(null);
        catalogue.reload();
      })
      .catch((e: unknown) => push(e instanceof Error ? e.message : String(e), false))
      .finally(() => setBusy(null));
  };

  const focus = params.focus;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Catalogue</h1>
          <div className="sub">
            An action is defined once per useCase; each client walks its own lifecycle. A pair
            serves traffic only once it is live.
          </div>
        </div>
        <button className="btn btn-sm" onClick={reloadAll}>
          <Icon name="refresh" />
          Refresh
        </button>
      </div>

      {catalogue.error ? <ErrorBanner error={catalogue.error} onRetry={reloadAll} /> : null}

      {catalogue.loading && !catalogue.data ? (
        <Loading label="Loading catalogue" />
      ) : groups.length === 0 ? (
        <Empty
          icon="catalogue"
          title="Catalogue is empty"
          hint="Seed the registry from the code catalogue to populate actions and clients."
        />
      ) : (
        groups.map((g) => (
          <div className="card" key={g.useCase} style={{ marginBottom: 16 }}>
            <div className="card-head" style={{ marginBottom: 10 }}>
              <div className="hstack">
                <Icon name="catalogue" />
                <div>
                  <div className="hstack" style={{ gap: 8 }}>
                    <strong className="mono" style={{ fontSize: 13.5 }}>
                      {g.useCase}
                    </strong>
                    <LifecycleChip state={g.actionState} />
                  </div>
                  <div className="xs muted">
                    platform {g.platform} · {g.pairs.length} client
                    {g.pairs.length === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              <button
                className="btn btn-sm"
                onClick={() => validate(g.useCase)}
                disabled={busy === `validate:${g.useCase}`}
              >
                <Icon name="check" />
                {g.actionState === "validated" ? "Re-validate" : "Validate"}
              </button>
            </div>

            <div className="tbl-wrap">
              <div className="tbl-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Lifecycle</th>
                      <th>Canary</th>
                      <th>Test job</th>
                      <th>Links</th>
                      <th className="right">Lifecycle actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.pairs.map((p) => {
                      const key = `${p.useCase}:${p.client}`;
                      return (
                        <tr key={key} className={focus === key ? "focus-row" : ""}>
                          <td>
                            <span className="tag tag-mono">{p.client}</span>
                          </td>
                          <td>
                            <LifecycleChip state={p.clientState} />
                          </td>
                          <td>{canaryCell(p.lastCanaryStatus)}</td>
                          <td className="mono xs">
                            {p.testJobId ? (
                              p.testJobId.slice(0, 8)
                            ) : (
                              <span className="muted">-</span>
                            )}
                          </td>
                          <td className="nowrap">
                            <a
                              className="linkish xs"
                              href={buildHash("jobs", { useCase: p.useCase, client: p.client })}
                            >
                              jobs
                            </a>
                            {"  "}
                            <a className="linkish xs" href={buildHash("canaries", { focus: key })}>
                              canary
                            </a>
                          </td>
                          <td className="right nowrap">
                            <button
                              className="btn btn-sm btn-ghost"
                              disabled={g.actionState !== "validated"}
                              title={
                                g.actionState !== "validated"
                                  ? "Validate the action first"
                                  : "Record a passing test run"
                              }
                              onClick={() => {
                                setRecord({ useCase: p.useCase, client: p.client });
                                setRecordJobId("");
                              }}
                            >
                              <Icon name="play" />
                              Record test
                            </button>{" "}
                            <button
                              className="btn btn-sm btn-ghost"
                              disabled={p.clientState !== "tested" || busy === `enable:${key}`}
                              title={
                                p.clientState !== "tested"
                                  ? "A recorded passing test is required first"
                                  : "Promote to live"
                              }
                              onClick={() => enable(p.useCase, p.client)}
                            >
                              <Icon name="check" />
                              Enable
                            </button>{" "}
                            <button
                              className="btn btn-sm btn-ghost"
                              disabled={p.clientState === "disabled" || busy === `disable:${key}`}
                              onClick={() =>
                                setConfirmDisable({ useCase: p.useCase, client: p.client })
                              }
                            >
                              <Icon name="power" />
                              Disable
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ))
      )}

      <div className="note accent">
        <Icon name="info" />
        <div>
          The extract schema is locked at the action level, so every client returns one shape. The
          first-live-run rule is enforced in the gateway: a pair cannot go live without a recorded,
          match-verified passing test run.
        </div>
      </div>

      <Modal open={problems !== null} onClose={() => setProblems(null)}>
        <div className="modal-head">
          <h2>Validation problems</h2>
        </div>
        <div className="modal-body">
          <p className="txt2 sm">
            <span className="mono">{problems?.useCase}</span> stays a draft until these are fixed in
            the code catalogue:
          </p>
          <ul style={{ margin: "10px 0 0 18px" }}>
            {problems?.items.map((p, i) => (
              <li key={i} className="sm" style={{ marginBottom: 4 }}>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div className="modal-foot">
          <button className="btn btn-primary" onClick={() => setProblems(null)}>
            Close
          </button>
        </div>
      </Modal>

      <Modal open={record !== null} onClose={() => setRecord(null)}>
        <div className="modal-head">
          <h2>Record a passing test run</h2>
        </div>
        <div className="modal-body">
          <p className="txt2 sm">
            Certify <span className="mono">{record?.useCase}</span> /{" "}
            <span className="mono">{record?.client}</span> with a DONE, success, match-verified job.
            This unlocks Enable.
          </p>
          {candidateJobs.length ? (
            <>
              <label className="f">Successful jobs for this pair</label>
              <select value={recordJobId} onChange={(e) => setRecordJobId(e.target.value)}>
                <option value="">Select a job</option>
                {candidateJobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.id.slice(0, 8)} · {formatClock(j.finishedAt ?? j.createdAt)} ·{" "}
                    {relativeTime(j.finishedAt ?? j.createdAt)}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <div className="note" style={{ marginTop: 10 }}>
              <Icon name="info" />
              <div>
                No successful DONE job found for this pair in the recent list. Run one (admin
                callers may submit to a non-live pair), then record it here.
              </div>
            </div>
          )}
          <label className="f">Job id</label>
          <input
            type="text"
            value={recordJobId}
            placeholder="paste a job id"
            onChange={(e) => setRecordJobId(e.target.value)}
          />
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => setRecord(null)}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submitRecord}
            disabled={record ? busy === `record:${record.useCase}:${record.client}` : false}
          >
            Record test
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDisable !== null}
        title="Disable this pair?"
        body={`${confirmDisable?.useCase} / ${confirmDisable?.client} will stop serving caller traffic. Re-enabling needs a recorded test again only if it was never live.`}
        confirmLabel="Disable pair"
        danger
        busy={
          confirmDisable
            ? busy === `disable:${confirmDisable.useCase}:${confirmDisable.client}`
            : false
        }
        onConfirm={doDisable}
        onCancel={() => setConfirmDisable(null)}
      />
    </>
  );
}
