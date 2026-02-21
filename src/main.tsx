import React from "react";
import ReactDOM from "react-dom/client";
import Overlay from "./components/Overlay";
import { AppProvider, ThemeProvider } from "./contexts";
import "./global.css";
import AppRoutes from "./routes";
import { isTauri } from "./lib/platform/detection";

// Check if running in Tauri
const isInTauri = isTauri();

let windowLabel = "dashboard";
if (isInTauri) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const currentWindow = getCurrentWindow();
  windowLabel = currentWindow.label;
} else {
  // Web mode: detect from hash or default to mobile if on mobile device
  const isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobileDevice && !window.location.hash) {
    window.location.hash = "#/mobile";
  }
}

const ensureDashboardInitialRoute = () => {
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

ensureDashboardInitialRoute();

// Render different components based on window label
if (windowLabel.startsWith("capture-overlay-")) {
  const monitorIndex = parseInt(windowLabel.split("-")[2], 10) || 0;
  // Render overlay without providers
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Overlay monitorIndex={monitorIndex} />
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}
