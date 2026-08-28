// Append-only admin audit log.
import { useState } from "react";
import { Icon } from "../components/Icon";
import { Empty, ErrorBanner, Loading } from "../components/primitives";
import { useConfig } from "../lib/context";
import { useAsync } from "../lib/useAsync";
import { formatDateTime } from "../lib/format";

function detailText(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function Audit() {
  const { api } = useConfig();
  const [limit, setLimit] = useState(100);
  const { data, error, loading, reload } = useAsync(() => api.audit(limit), `audit-${limit}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit</h1>
          <div className="sub">Every admin action, newest first. Immutable and append-only.</div>
        </div>
        <div className="hstack">
          <span className="tag">
            <Icon name="lock" />
            append-only
          </span>
          <button className="btn btn-sm" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
        </div>
      </div>

      <div className="toolbar">
        <label className="sm txt2" htmlFor="audit-limit">
          Show
        </label>
        <select id="audit-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={250}>250</option>
          <option value={500}>500</option>
        </select>
      </div>

      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
      {loading && !data ? (
        <Loading label="Loading audit log" />
      ) : (
        <div className="tbl-wrap">
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th className="nowrap">When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data && data.entries.length ? (
                  data.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap sm txt2">{formatDateTime(e.createdAt)}</td>
                      <td className="sm mono">{e.actor}</td>
                      <td>
                        <span className="tag tag-accent">{e.action}</span>
                      </td>
                      <td className="mono xs">{e.entity}</td>
                      <td className="sm txt2 mono">{detailText(e.detail)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <Empty
                        icon="audit"
                        title="No audit entries yet"
                        hint="Admin actions appear here."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
