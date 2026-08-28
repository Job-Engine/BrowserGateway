// Connection settings: gateway base URL and admin token. Both are stored in
// sessionStorage only. "Test" verifies reachability and admin access.
import { useState } from "react";
import { Icon } from "../components/Icon";
import { useConfig } from "../lib/context";
import { useToast } from "../components/Toast";
import { DEFAULT_BASE_URL } from "../lib/config";
import { makeApi, type ApiError } from "../api/client";

export function Settings() {
  const { config, setConfig } = useConfig();
  const { push } = useToast();
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const dirty = baseUrl.trim() !== config.baseUrl || token.trim() !== "";

  const effectiveToken = () => token.trim() || config.token;

  const test = () => {
    setTesting(true);
    const probe = makeApi({ baseUrl: baseUrl.trim() || DEFAULT_BASE_URL, token: effectiveToken() });
    probe
      .health()
      .then(() => probe.stats())
      .then(() => push("Connected. Token has admin access."))
      .catch((e: unknown) => {
        const err = e as ApiError;
        if (err.status === 401) push("Token rejected (401).", false);
        else if (err.status === 403) push("Token is not an admin token (403).", false);
        else push(err.message, false);
      })
      .finally(() => setTesting(false));
  };

  const save = () => {
    setConfig({ baseUrl: baseUrl.trim() || DEFAULT_BASE_URL, token: effectiveToken() });
    setToken("");
    push("Settings saved");
  };

  const disconnect = () => {
    setConfig({ baseUrl: config.baseUrl, token: "" });
    push("Disconnected");
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">
            Point the console at a gateway and authenticate. Values live in this browser tab only.
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-head">
          <h3>Connection</h3>
          <span className="tag">
            <Icon name="lock" />
            sessionStorage
          </span>
        </div>

        <label className="f" htmlFor="set-url">
          Gateway base URL
        </label>
        <input
          id="set-url"
          type="text"
          value={baseUrl}
          placeholder={DEFAULT_BASE_URL}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <div className="note" style={{ marginTop: 8 }}>
          <Icon name="info" />
          <div>
            In local dev the Vite server proxies gateway paths, so a localhost base URL works
            without CORS. For a remote gateway, enter its full origin.
          </div>
        </div>

        <label className="f" htmlFor="set-token">
          Admin token
        </label>
        <input
          id="set-token"
          type="password"
          value={token}
          placeholder={config.token ? "token set (leave blank to keep)" : "bgw_..."}
          onChange={(e) => setToken(e.target.value)}
        />

        <div className="toolbar" style={{ margin: "16px 0 0" }}>
          <button className="btn btn-primary" onClick={save} disabled={!dirty}>
            Save
          </button>
          <button className="btn" onClick={test} disabled={testing}>
            <Icon name="refresh" />
            {testing ? "Testing" : "Test connection"}
          </button>
          <span className="spacer" />
          <button className="btn btn-danger" onClick={disconnect} disabled={!config.token}>
            <Icon name="power" />
            Disconnect
          </button>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 14 }}>
        <div className="card-head">
          <h3>Current</h3>
        </div>
        <div className="kv">
          <span className="k">Base URL</span>
          <span className="v mono sm">{config.baseUrl}</span>
          <span className="k">Token</span>
          <span className="v sm">{config.token ? "set" : "not set"}</span>
        </div>
      </div>
    </>
  );
}
