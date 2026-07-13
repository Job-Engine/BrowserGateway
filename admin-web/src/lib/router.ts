// Minimal hash router. Keeps the bundle lean (no react-router). A route is
// "#/<top>?<query>"; the top segment selects the view, query params carry
// cross-link state (filters, focus).
import { useSyncExternalStore } from "react";

export interface Route {
  top: string;
  params: Record<string, string>;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const top = path.split("/")[0] || "home";
  const params: Record<string, string> = {};
  if (query) {
    for (const pair of query.split("&")) {
      const [k, v] = pair.split("=");
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  return { top, params };
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

let cache: Route = parse();
let cacheHash = window.location.hash;
function getSnapshot(): Route {
  if (window.location.hash !== cacheHash) {
    cacheHash = window.location.hash;
    cache = parse();
  }
  return cache;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function buildHash(
  top: string,
  params?: Record<string, string | number | undefined>,
): string {
  const usp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") usp.set(k, String(v));
    }
  }
  const q = usp.toString();
  return `#/${top}${q ? `?${q}` : ""}`;
}

export function navigate(top: string, params?: Record<string, string | number | undefined>): void {
  window.location.hash = buildHash(top, params);
}
