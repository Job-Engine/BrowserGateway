// Ephemeral toast notifications. useToast().push(message, ok?) from anywhere
// under ToastProvider.
import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

interface ToastItem {
  id: number;
  message: string;
  ok: boolean;
}

interface ToastApi {
  push: (message: string, ok?: boolean) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const push = useCallback((message: string, ok = true) => {
    const id = ++idRef.current;
    setItems((cur) => [...cur, { id, message, ok }]);
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 2800);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.ok ? "" : " err"}`}>
            <Icon name={t.ok ? "check" : "alert"} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used within ToastProvider");
  return value;
}
