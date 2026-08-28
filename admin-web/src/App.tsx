import { useEffect, useState } from "react";
import "./styles.css";
import { ConfigProvider, useConfig } from "./lib/context";
import { ToastProvider } from "./components/Toast";
import { IconSprite } from "./components/Icon";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { CommandPalette } from "./components/CommandPalette";
import { TokenGate } from "./components/TokenGate";
import { useRoute } from "./lib/router";
import { Home } from "./views/Home";
import { Jobs } from "./views/Jobs";
import { Catalogue } from "./views/Catalogue";
import { Access } from "./views/Access";
import { Canaries } from "./views/Canaries";
import { Audit } from "./views/Audit";
import { Settings } from "./views/Settings";
import { Docs } from "./views/Docs";

function View({ top }: { top: string }) {
  switch (top) {
    case "jobs":
      return <Jobs />;
    case "catalogue":
      return <Catalogue />;
    case "access":
      return <Access />;
    case "canaries":
      return <Canaries />;
    case "audit":
      return <Audit />;
    case "settings":
      return <Settings />;
    case "docs":
      return <Docs />;
    case "home":
    default:
      return <Home />;
  }
}

function Shell() {
  const { config } = useConfig();
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!config.token) {
    return (
      <>
        <IconSprite />
        <TokenGate />
      </>
    );
  }

  return (
    <>
      <IconSprite />
      <Sidebar current={route.top} />
      <Topbar onOpenPalette={() => setPaletteOpen(true)} />
      <main className="content">
        <div className="view-wrap">
          <View top={route.top} />
        </div>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

export default function App() {
  return (
    <ConfigProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </ConfigProvider>
  );
}
