// Gateway connection config. The admin token is entered by the user and lives
// only in sessionStorage: never in code, never in localStorage (it is cleared
// when the tab closes). The base URL is configurable via the Settings view.

export interface GatewayConfig {
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = "gateway-admin-config";
export const DEFAULT_BASE_URL = "http://localhost:8080";

export function loadConfig(): GatewayConfig {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
      return {
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULT_BASE_URL,
        token: typeof parsed.token === "string" ? parsed.token : "",
      };
    }
  } catch {
    // Corrupt or unavailable storage: fall back to defaults.
  }
  return { baseUrl: DEFAULT_BASE_URL, token: "" };
}

export function saveConfig(config: GatewayConfig): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
