// SVG icon set ported from the visual contract. IconSprite is mounted once;
// Icon references a symbol by name.

export type IconName =
  | "home"
  | "jobs"
  | "catalogue"
  | "access"
  | "canary"
  | "bell"
  | "audit"
  | "settings"
  | "docs"
  | "search"
  | "chevron"
  | "close"
  | "play"
  | "copy"
  | "plus"
  | "refresh"
  | "external"
  | "check"
  | "alert"
  | "lock"
  | "arrow"
  | "shield"
  | "edit"
  | "trash"
  | "zap"
  | "clock"
  | "inbox"
  | "activity"
  | "gauge"
  | "info"
  | "power"
  | "server"
  | "key";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={`ic ${className ?? ""}`} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <symbol id="i-home" viewBox="0 0 24 24">
          <path d="M3 11l9-8 9 8" />
          <path d="M5 10v10a1 1 0 001 1h12a1 1 0 001-1V10" />
        </symbol>
        <symbol id="i-jobs" viewBox="0 0 24 24">
          <path d="M4 6h16M4 12h16M4 18h10" />
        </symbol>
        <symbol id="i-catalogue" viewBox="0 0 24 24">
          <path d="M12 3l8 4.5-8 4.5-8-4.5L12 3z" />
          <path d="M4 12l8 4.5 8-4.5" />
          <path d="M4 16.5l8 4.5 8-4.5" />
        </symbol>
        <symbol id="i-access" viewBox="0 0 24 24">
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 20c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" />
          <path d="M16 5.2a3.2 3.2 0 010 5.6M17.5 20c0-2.4-1-4.4-2.6-5.4" />
        </symbol>
        <symbol id="i-canary" viewBox="0 0 24 24">
          <path d="M3 12h4l2.5 7 5-14 2.5 7H21" />
        </symbol>
        <symbol id="i-bell" viewBox="0 0 24 24">
          <path d="M6 9a6 6 0 1112 0c0 4.5 1.8 6 1.8 6H4.2S6 13.5 6 9z" />
          <path d="M10 20a2 2 0 004 0" />
        </symbol>
        <symbol id="i-audit" viewBox="0 0 24 24">
          <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
          <path d="M14 3v5h5" />
          <path d="M9 13h6M9 17h4" />
        </symbol>
        <symbol id="i-settings" viewBox="0 0 24 24">
          <path d="M4 7h11M19 7h1" />
          <path d="M4 12h5M13 12h7" />
          <path d="M4 17h9M17 17h3" />
          <circle cx="17" cy="7" r="2" />
          <circle cx="11" cy="12" r="2" />
          <circle cx="15" cy="17" r="2" />
        </symbol>
        <symbol id="i-docs" viewBox="0 0 24 24">
          <path d="M12 6C10 4.6 7 4.2 4 5v14c3-.8 6-.4 8 1 2-1.4 5-1.8 8-1V5c-3-.8-6-.4-8 1z" />
          <path d="M12 6v14" />
        </symbol>
        <symbol id="i-search" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </symbol>
        <symbol id="i-chevron" viewBox="0 0 24 24">
          <path d="M9 6l6 6-6 6" />
        </symbol>
        <symbol id="i-close" viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6L6 18" />
        </symbol>
        <symbol id="i-play" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z" />
        </symbol>
        <symbol id="i-copy" viewBox="0 0 24 24">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 012-2h10" />
        </symbol>
        <symbol id="i-plus" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" />
        </symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24">
          <path d="M20 12a8 8 0 11-2.3-5.6" />
          <path d="M20 4v5h-5" />
        </symbol>
        <symbol id="i-external" viewBox="0 0 24 24">
          <path d="M14 4h6v6M20 4l-9 9" />
          <path d="M18 13v6a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h6" />
        </symbol>
        <symbol id="i-check" viewBox="0 0 24 24">
          <path d="M4 12l5 5L20 6" />
        </symbol>
        <symbol id="i-alert" viewBox="0 0 24 24">
          <path d="M12 3.5l9.5 16H2.5z" />
          <path d="M12 9v5M12 17v.5" />
        </symbol>
        <symbol id="i-lock" viewBox="0 0 24 24">
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 018 0v3" />
        </symbol>
        <symbol id="i-arrow" viewBox="0 0 24 24">
          <path d="M4 12h15M13 6l6 6-6 6" />
        </symbol>
        <symbol id="i-shield" viewBox="0 0 24 24">
          <path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z" />
        </symbol>
        <symbol id="i-edit" viewBox="0 0 24 24">
          <path d="M4 20h4L19 9l-4-4L4 16z" />
          <path d="M14 6l4 4" />
        </symbol>
        <symbol id="i-trash" viewBox="0 0 24 24">
          <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />
        </symbol>
        <symbol id="i-zap" viewBox="0 0 24 24">
          <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
        </symbol>
        <symbol id="i-clock" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </symbol>
        <symbol id="i-inbox" viewBox="0 0 24 24">
          <path d="M4 13l2-8h12l2 8v5a1 1 0 01-1 1H5a1 1 0 01-1-1z" />
          <path d="M4 13h4l1.5 2h5L15 13h5" />
        </symbol>
        <symbol id="i-activity" viewBox="0 0 24 24">
          <path d="M3 12h4l2.5 7 5-14 2.5 7H21" />
        </symbol>
        <symbol id="i-gauge" viewBox="0 0 24 24">
          <path d="M4 18a8 8 0 1116 0" />
          <path d="M12 18l4-5" />
        </symbol>
        <symbol id="i-info" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8v.5" />
        </symbol>
        <symbol id="i-power" viewBox="0 0 24 24">
          <path d="M12 4v8" />
          <path d="M7 6a8 8 0 1010 0" />
        </symbol>
        <symbol id="i-server" viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="7" rx="1.5" />
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <path d="M7 7.5v.01M7 16.5v.01" />
        </symbol>
        <symbol id="i-key" viewBox="0 0 24 24">
          <circle cx="8" cy="9" r="4" />
          <path d="M11 12l8 8M16.5 17.5l2-2" />
        </symbol>
      </defs>
    </svg>
  );
}
