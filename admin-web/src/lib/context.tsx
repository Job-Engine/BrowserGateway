// App-wide config + bound API client. The token/base URL live here and in
// sessionStorage; changing them (Settings) rebinds the API for every view.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { loadConfig, saveConfig, type GatewayConfig } from "./config";
import { makeApi, type Api } from "../api/client";

interface ConfigContextValue {
  config: GatewayConfig;
  setConfig: (config: GatewayConfig) => void;
  api: Api;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<GatewayConfig>(() => loadConfig());
  const setConfig = useCallback((next: GatewayConfig) => {
    saveConfig(next);
    setConfigState(next);
  }, []);
  const api = useMemo(() => makeApi(config), [config]);
  const value = useMemo(() => ({ config, setConfig, api }), [config, setConfig, api]);
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigContextValue {
  const value = useContext(ConfigContext);
  if (!value) throw new Error("useConfig must be used within ConfigProvider");
  return value;
}
