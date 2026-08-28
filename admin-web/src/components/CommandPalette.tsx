// Cmd-K jump-to-view palette.
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Modal } from "./Modal";
import { navigate } from "../lib/router";

const DESTINATIONS: { top: string; label: string; icon: IconName }[] = [
  { top: "home", label: "Home / Triage", icon: "home" },
  { top: "jobs", label: "Jobs", icon: "jobs" },
  { top: "catalogue", label: "Catalogue", icon: "catalogue" },
  { top: "access", label: "Access", icon: "access" },
  { top: "canaries", label: "Canaries & Alerts", icon: "canary" },
  { top: "audit", label: "Audit", icon: "audit" },
  { top: "settings", label: "Settings", icon: "settings" },
  { top: "docs", label: "Docs", icon: "docs" },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const list = DESTINATIONS.filter((d) => d.label.toLowerCase().includes(query.toLowerCase()));
  const go = (top: string) => {
    onClose();
    navigate(top);
  };

  return (
    <Modal open={open} onClose={onClose}>
      <div className="modal-body" style={{ paddingTop: 16 }}>
        <div className="input-icon">
          <Icon name="search" />
          <input
            type="text"
            autoFocus
            value={query}
            placeholder="Jump to a view"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && list[0]) go(list[0].top);
            }}
          />
        </div>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          {list.length ? (
            list.map((d) => (
              <button key={d.top} className="step-btn" onClick={() => go(d.top)}>
                <Icon name={d.icon} />
                <span className="st1">{d.label}</span>
                <span className="spacer" />
                <Icon name="arrow" />
              </button>
            ))
          ) : (
            <div className="empty" style={{ padding: 24 }}>
              <Icon name="search" />
              <div className="t2">No views match</div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
