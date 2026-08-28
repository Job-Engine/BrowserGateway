// First-load gate: collect the gateway base URL and admin token, verify them
// against /health and /admin/stats (proves the token is valid and admin), then
// store in sessionStorage. The token is never written to code or localStorage.
import { useState } from "react";
import { Icon } from "./Icon";
import { useConfig } from "../lib/context";
import { DEFAULT_BASE_URL } from "../lib/config";
import { makeApi, type ApiError } from "../api/client";

export function TokenGate() {
  const { config, setConfig } = useConfig();
  const [baseUrl, setBaseUrl] = useState(config.baseUrl || DEFAULT_BASE_URL);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = () => {
    const trimmedToken = token.trim();
    const trimmedBase = baseUrl.trim() || DEFAULT_BASE_URL;
    if (!trimmedToken) {
      setError("Enter an admin token.");
      return;
    }
    setBusy(true);
    setError(null);
    const probe = makeApi({ baseUrl: trimmedBase, token: trimmedToken });
    probe
      .health()
      .then(() => probe.stats())
      .then(() => setConfig({ baseUrl: trimmedBase, token: trimmedToken }))
      .catch((e: unknown) => {
        const err = e as ApiError;
        if (err.status === 401) setError("Token rejected. Check the value and try again.");
        else if (err.status === 403)
          setError("That token is valid but not an admin token. Admin scope is required here.");
        else setError(err.message);
        setBusy(false);
      });
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-brand">
          <div className="brand-mark">
            <Icon name="shield" className="ic-lg" />
          </div>
          <div className="brand-txt">
            <strong style={{ fontSize: 16 }}>Gateway Admin</strong>
            <span>Connect to your gateway</span>
          </div>
        </div>
        <p className="sub" style={{ marginBottom: 4 }}>
          Enter an admin bearer token. It is kept in this browser tab only and cleared when the tab
          closes.
        </p>
        <label className="f" htmlFor="gate-url">
          Gateway base URL
        </label>
        <input
          id="gate-url"
          type="text"
          value={baseUrl}
          placeholder={DEFAULT_BASE_URL}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <label className="f" htmlFor="gate-token">
          Admin token
        </label>
        <input
          id="gate-token"
          type="password"
          value={token}
          placeholder="bgw_..."
          autoFocus
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") connect();
          }}
        />
        {error ? (
          <div className="banner" style={{ marginTop: 14, marginBottom: 0 }}>
            <Icon name="alert" />
            <div className="sm">{error}</div>
          </div>
        ) : null}
        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", marginTop: 16 }}
          onClick={connect}
          disabled={busy}
        >
          {busy ? "Connecting" : "Connect"}
        </button>
      </div>
    </div>
  );
}
