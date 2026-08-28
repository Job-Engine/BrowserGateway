// Right-side sliding panel used for job detail. Content mounts only while open.
import { useEffect } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  icon = "jobs",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={`drawer${open ? " open" : ""}`} role="dialog" aria-modal="true">
      {open ? (
        <>
          <div className="drawer-head">
            <div className="drawer-title">
              <Icon name={icon} className="ic-lg" />
              <div>
                <h2>{title}</h2>
                {subtitle ? <div className="xs muted mono">{subtitle}</div> : null}
              </div>
            </div>
            <button className="icon-btn" aria-label="Close" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
          <div className="drawer-body">{children}</div>
          {footer ? <div className="drawer-foot">{footer}</div> : null}
        </>
      ) : null}
    </div>
  );
}
