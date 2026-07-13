// Top bar: command-palette trigger, live connection status, link to Settings.
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { useConfig } from "../lib/context";
import { buildHash } from "../lib/router";

type Conn = "unknown" | "ok" | "bad";

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { api, config } = useConfig();
  const [conn, setConn] = useState<Conn>("unknown");

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.health().then(
        () => alive && setConn("ok"),
        () => alive && setConn("bad"),
      );
    };
    tick();
    const id = window.setInterval(tick, 20000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [api]);

  let host = config.baseUrl;
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    /* leave as-is for relative base URLs */
  }

  return (
    <header className="topbar">
      <button className="cmdk" onClick={onOpenPalette} aria-label="Open command palette">
        <Icon name="search" />
        <span className="flex1">Search or jump to</span>
        <span className="kbd">Cmd K</span>
      </button>
      <div className="top-right">
        <div className="env-ctl" title="Gateway base URL">
          <Icon name="server" />
          <span className="val mono">{host}</span>
        </div>
        <div
          className={`conn${conn === "ok" ? " ok" : conn === "bad" ? " bad" : ""}`}
          title="Gateway connection"
        >
          <span className="dot" />
          {conn === "ok" ? "Connected" : conn === "bad" ? "Offline" : "Checking"}
        </div>
        <a className="icon-btn" href={buildHash("settings")} aria-label="Settings">
          <Icon name="settings" />
        </a>
      </div>
    </header>
  );
}
