// Left navigation. Badges (running jobs, red canaries) poll the gateway every
// 20s and fail silent so a flaky gateway never blanks the nav.
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { useConfig } from "../lib/context";
import { buildHash } from "../lib/router";

interface NavItem {
  top: string;
  label: string;
  icon: IconName;
  badge?: { text: string; kind: "" | "accent" | "danger" | "warning" };
}

export function Sidebar({ current }: { current: string }) {
  const { api } = useConfig();
  const [running, setRunning] = useState(0);
  const [canariesRed, setCanariesRed] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      Promise.all([api.stats(), api.catalogue()])
        .then(([stats, cat]) => {
          if (!alive) return;
          setRunning(stats.jobs.RUNNING ?? 0);
          setCanariesRed(
            cat.pairs.filter((p) => p.lastCanaryStatus && p.lastCanaryStatus !== "success").length,
          );
        })
        .catch(() => {
          /* keep the last known counts; the view surfaces real errors */
        });
    };
    tick();
    const id = window.setInterval(tick, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [api]);

  const groups: { group: string | null; items: NavItem[] }[] = [
    {
      group: null,
      items: [
        { top: "home", label: "Home", icon: "home" },
        {
          top: "jobs",
          label: "Jobs",
          icon: "jobs",
          badge: running ? { text: `${running} running`, kind: "accent" } : undefined,
        },
        { top: "catalogue", label: "Catalogue", icon: "catalogue" },
        { top: "access", label: "Access", icon: "access" },
      ],
    },
    {
      group: "Operations",
      items: [
        {
          top: "canaries",
          label: "Canaries & Alerts",
          icon: "canary",
          badge: canariesRed ? { text: String(canariesRed), kind: "danger" } : undefined,
        },
        { top: "audit", label: "Audit", icon: "audit" },
      ],
    },
    {
      group: null,
      items: [
        { top: "settings", label: "Settings", icon: "settings" },
        { top: "docs", label: "Docs", icon: "docs" },
      ],
    },
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="shield" className="ic-lg" />
        </div>
        <div className="brand-txt">
          <strong>Gateway Admin</strong>
          <span>Browser Automation Gateway</span>
        </div>
      </div>
      <nav className="nav">
        {groups.map((section, i) => (
          <div key={i}>
            {section.group ? <div className="nav-group">{section.group}</div> : null}
            {section.items.map((item) => (
              <a
                key={item.top}
                className={`nav-item${item.top === current ? " active" : ""}`}
                href={buildHash(item.top)}
              >
                <Icon name={item.icon} />
                <span className="lbl">{item.label}</span>
                {item.badge ? (
                  <span className={`nav-badge ${item.badge.kind}`}>{item.badge.text}</span>
                ) : null}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <Icon name="server" />
        <span>console 0.5.0</span>
      </div>
    </aside>
  );
}
