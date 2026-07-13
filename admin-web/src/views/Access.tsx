// Caller tokens: list with scopes, issue a new token (scopes are useCase:client,
// isAdmin optional) with a one-time secret reveal, and disable a token.
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { CopyButton, Empty, ErrorBanner, Loading } from "../components/primitives";
import { Modal, ConfirmDialog } from "../components/Modal";
import { useConfig } from "../lib/context";
import { useToast } from "../components/Toast";
import { useAsync } from "../lib/useAsync";
import { formatDateTime } from "../lib/format";
import type { Caller } from "../api/types";

const SCOPE_RE = /^[^:]+:[^:]+$/;

export function Access() {
  const { api } = useConfig();
  const { push } = useToast();
  const tokens = useAsync(() => api.tokens(), "access-tokens");
  const catalogue = useAsync(() => api.catalogue(), "access-catalogue");

  const [issueOpen, setIssueOpen] = useState(false);
  const [name, setName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [scopeDraft, setScopeDraft] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<Caller | null>(null);
  const [disabling, setDisabling] = useState(false);

  const scopeSuggestions = useMemo(() => {
    const set = new Set<string>(["*:*"]);
    for (const p of catalogue.data?.pairs ?? []) {
      set.add(`${p.useCase}:${p.client}`);
      set.add(`${p.useCase}:*`);
    }
    return Array.from(set).sort();
  }, [catalogue.data]);

  const resetForm = () => {
    setName("");
    setIsAdmin(false);
    setScopeDraft("");
    setScopes([]);
  };

  const addScope = (value: string) => {
    const s = value.trim();
    if (!s) return;
    if (!SCOPE_RE.test(s)) {
      push("Scope must be useCase:client (one colon).", false);
      return;
    }
    if (!scopes.includes(s)) setScopes((cur) => [...cur, s]);
    setScopeDraft("");
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      push("Token needs a name.", false);
      return;
    }
    if (scopes.length === 0) {
      push("At least one scope is required.", false);
      return;
    }
    setSubmitting(true);
    api
      .issueToken({ name: trimmedName, scopes, isAdmin })
      .then((res) => {
        setIssueOpen(false);
        resetForm();
        setRevealed({ name: res.caller.name, token: res.token });
        tokens.reload();
      })
      .catch((e: unknown) => push(e instanceof Error ? e.message : String(e), false))
      .finally(() => setSubmitting(false));
  };

  const doDisable = () => {
    if (!confirmDisable) return;
    setDisabling(true);
    api
      .disableToken(confirmDisable.id)
      .then(() => {
        push(`Token ${confirmDisable.name} disabled`);
        setConfirmDisable(null);
        tokens.reload();
      })
      .catch((e: unknown) => push(e instanceof Error ? e.message : String(e), false))
      .finally(() => setDisabling(false));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Access</h1>
          <div className="sub">
            Scopes are useCase-by-client: an app may run an action for some clients and not others.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setIssueOpen(true)}>
          <Icon name="plus" />
          Issue token
        </button>
      </div>

      {tokens.error ? <ErrorBanner error={tokens.error} onRetry={tokens.reload} /> : null}

      {tokens.loading && !tokens.data ? (
        <Loading label="Loading tokens" />
      ) : tokens.data && tokens.data.callers.length ? (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(420px,1fr))" }}>
          {tokens.data.callers.map((c) => (
            <div className="card" key={c.id}>
              <div className="card-head">
                <div className="hstack">
                  <Icon name="key" />
                  <h3
                    style={{
                      textTransform: "none",
                      letterSpacing: 0,
                      fontSize: 14,
                      color: "var(--text)",
                    }}
                  >
                    {c.name}
                  </h3>
                  {c.isAdmin ? <span className="tag tag-warning">admin</span> : null}
                </div>
                <span className={`pill ${c.disabled ? "pill-bad" : "pill-healthy"}`}>
                  <span className="dot" />
                  {c.disabled ? "disabled" : "active"}
                </span>
              </div>
              <div className="kv">
                <span className="k">Caller id</span>
                <span className="v mono xs">{c.id}</span>
                <span className="k">Issued</span>
                <span className="v sm">{formatDateTime(c.createdAt)}</span>
              </div>
              <label className="f">Scopes (useCase-by-client)</label>
              <div className="wrap-chips">
                {c.scopes.length ? (
                  c.scopes.map((s) => (
                    <span key={s} className="tag tag-mono">
                      {s}
                    </span>
                  ))
                ) : (
                  <span className="tag tag-none">no scopes</span>
                )}
              </div>
              {!c.disabled ? (
                <div className="toolbar" style={{ margin: "14px 0 0" }}>
                  <span className="spacer" />
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDisable(c)}>
                    Disable token
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Empty
          icon="key"
          title="No tokens issued"
          hint="Issue a caller token to grant scoped access."
        />
      )}

      <div className="section-head">
        <h2>Endpoints</h2>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
        {(
          [
            ["GET", "/health", "Liveness"],
            ["GET", "/catalogue", "Enabled useCases the token may call"],
            ["POST", "/jobs", "Submit a job, returns a jobId"],
            ["GET", "/jobs/:id", "Poll a job, returns the envelope"],
          ] as const
        ).map((e) => (
          <div className="card" key={e[1]} style={{ padding: "14px 16px" }}>
            <div className="hstack">
              <span className={`tag ${e[0] === "POST" ? "tag-accent" : "tag-info"}`}>{e[0]}</span>
              <span className="mono sm">{e[1]}</span>
            </div>
            <div className="xs muted" style={{ marginTop: 8 }}>
              {e[2]}
            </div>
          </div>
        ))}
      </div>

      <Modal open={issueOpen} onClose={() => setIssueOpen(false)}>
        <div className="modal-head">
          <h2>Issue caller token</h2>
        </div>
        <div className="modal-body">
          <label className="f" htmlFor="tk-name">
            App name
          </label>
          <input
            id="tk-name"
            type="text"
            value={name}
            placeholder="billing-service"
            onChange={(e) => setName(e.target.value)}
          />

          <label className="f">Scopes</label>
          <div className="hstack" style={{ gap: 8 }}>
            <input
              type="text"
              list="scope-suggestions"
              value={scopeDraft}
              placeholder="lightreach.milestoneStatus:default"
              onChange={(e) => setScopeDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addScope(scopeDraft);
                }
              }}
            />
            <button className="btn" onClick={() => addScope(scopeDraft)}>
              Add
            </button>
          </div>
          <datalist id="scope-suggestions">
            {scopeSuggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <div className="wrap-chips" style={{ marginTop: 10 }}>
            {scopes.length ? (
              scopes.map((s) => (
                <span key={s} className="tag tag-mono">
                  {s}
                  <button
                    className="btn-ghost"
                    style={{ border: "none", background: "none", cursor: "pointer", padding: 0 }}
                    aria-label={`Remove ${s}`}
                    onClick={() => setScopes((cur) => cur.filter((x) => x !== s))}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              ))
            ) : (
              <span className="xs muted">Add at least one useCase:client scope.</span>
            )}
          </div>

          <div className="tgl-row" style={{ marginTop: 14 }}>
            <div>
              <div className="t1">Admin token</div>
              <div className="t2">Grants access to this admin API. Issue sparingly.</div>
            </div>
            <button
              className="tgl"
              role="switch"
              aria-checked={isAdmin}
              aria-label="Admin token"
              onClick={() => setIsAdmin((v) => !v)}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => setIssueOpen(false)}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? "Issuing" : "Issue token"}
          </button>
        </div>
      </Modal>

      <Modal open={revealed !== null} onClose={() => setRevealed(null)}>
        <div className="modal-head">
          <h2>Token issued</h2>
        </div>
        <div className="modal-body">
          <p className="txt2 sm">
            Shown once. Copy it into 1Password now; it cannot be retrieved again.
          </p>
          <div className="code-block">
            <pre>{revealed?.token}</pre>
          </div>
          {revealed ? <CopyButton text={revealed.token} label="Token" /> : null}
        </div>
        <div className="modal-foot">
          <button className="btn btn-primary" onClick={() => setRevealed(null)}>
            Done
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDisable !== null}
        title={`Disable ${confirmDisable?.name ?? ""}?`}
        body="Every request with this token gets 401 immediately. Running jobs finish."
        confirmLabel="Disable token"
        danger
        busy={disabling}
        onConfirm={doDisable}
        onCancel={() => setConfirmDisable(null)}
      />
    </>
  );
}
