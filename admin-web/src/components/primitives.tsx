// Small shared UI atoms. Outcome pills (success/failure/error), lifecycle chips
// (draft/validated/tested/live/disabled) and job-state chips (queued/running/
// done) are deliberately separate visual families.
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useToast } from "./Toast";
import type { ActionState, ClientState, JobState, JobStatus } from "../api/types";

export function OutcomePill({ status, label }: { status: JobStatus; label?: string }) {
  return (
    <span className={`pill pill-${status}`}>
      <span className="dot" />
      {label ?? status}
    </span>
  );
}

export function HealthPill({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className={`pill ${ok ? "pill-healthy" : "pill-bad"}`}>
      <span className="dot" />
      {label ?? (ok ? "healthy" : "failing")}
    </span>
  );
}

export function LifecycleChip({ state }: { state: ActionState | ClientState }) {
  return (
    <span className={`lc lc-${state}`}>
      <span className="dot" />
      {state}
    </span>
  );
}

export function StateChip({ state }: { state: JobState }) {
  return (
    <span className={`chip ${state === "RUNNING" ? "chip-running" : ""}`}>
      <span className="dot" />
      {state.toLowerCase()}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-wrap">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Empty({
  icon = "inbox",
  title,
  hint,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
}) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <div className="t1">{title}</div>
      {hint ? <div className="t2">{hint}</div> : null}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="banner">
      <Icon name="alert" />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>Could not load from the gateway</div>
        <div className="sm">{error.message}</div>
      </div>
      {onRetry ? (
        <button className="btn btn-sm" onClick={onRetry}>
          <Icon name="refresh" />
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function CopyButton({ text, label = "Copied" }: { text: string; label?: string }) {
  const { push } = useToast();
  const onClick = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => push(`${label} to clipboard`),
        () => push("Copy failed", false),
      );
    } else {
      push("Clipboard unavailable", false);
    }
  };
  return (
    <button className="btn btn-sm btn-ghost" onClick={onClick}>
      <Icon name="copy" />
      Copy
    </button>
  );
}
