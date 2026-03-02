import React from "react";
import ReactDOM from "react-dom/client";
import Overlay from "./components/Overlay";
import { AppProvider, ThemeProvider } from "./contexts";
import "./global.css";
import AppRoutes from "./routes";
import { isTauri } from "./lib/tauri";

const ensureDashboardInitialRoute = (windowLabel: string) => {
  if (windowLabel !== "dashboard") {
    return;
  }

  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const requestedRoute = params.get("route");

  const targetRoute = requestedRoute
    ? requestedRoute.startsWith("/")
      ? requestedRoute
      : `/${requestedRoute}`
    : "/dashboard";

  if (requestedRoute) {
    params.delete("route");
  }

  const newSearch = params.toString();
  const newHash = `#${targetRoute}`;
  const newUrl = `${url.origin}${url.pathname}${newSearch ? `?${newSearch}` : ""}${newHash}`;

  const currentHash = window.location.hash || "";
  if (currentHash !== newHash || requestedRoute) {
    window.history.replaceState(null, "", newUrl);
  }
};

const bootstrap = async () => {
  let windowLabel = "web";

  if (isTauri()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      windowLabel = getCurrentWindow().label;
    } catch (error) {
      console.warn("Failed to detect Tauri window label, falling back to web:", error);
    }
  } else {
    // Web mode: default to the mobile experience.
    if (!window.location.hash) {
      window.location.hash = "#/mobile";
    }
  }

  ensureDashboardInitialRoute(windowLabel);

  // Render different components based on window label
  if (windowLabel.startsWith("capture-overlay-")) {
    const monitorIndex = parseInt(windowLabel.split("-")[2], 10) || 0;
    // Render overlay without providers
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <Overlay monitorIndex={monitorIndex} />
      </React.StrictMode>
    );
    return;
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
};

bootstrap();
