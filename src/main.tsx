import React from "react";
import ReactDOM from "react-dom/client";
import Overlay from "./components/Overlay";
import { AppProvider, ThemeProvider } from "./contexts";
import "./global.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AppRoutes from "./routes";

const currentWindow = getCurrentWindow();
const windowLabel = currentWindow.label;

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
