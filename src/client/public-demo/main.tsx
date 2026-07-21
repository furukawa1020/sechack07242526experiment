import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PublicDemoApp } from "./PublicDemoApp.js";
import {
  PublicDeviceTestApp,
  PublicDisplayApp,
  PublicHealthApp,
  PublicOperatorApp,
} from "./ReviewApps.js";
import "./public-demo.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Public demo root element is missing.");

function applicationForPath(pathname: string): React.JSX.Element {
  const withoutIndex = pathname.replace(/\/index\.html$/u, "");
  const normalizedPath = withoutIndex.replace(/\/+$/u, "") || "/";
  if (normalizedPath === "/operator") return <PublicOperatorApp />;
  if (normalizedPath === "/display/demo") return <PublicDisplayApp />;
  if (normalizedPath === "/device-test") return <PublicDeviceTestApp />;
  if (normalizedPath === "/healthz") return <PublicHealthApp />;
  return <PublicDemoApp />;
}

createRoot(rootElement).render(
  <StrictMode>
    {applicationForPath(window.location.pathname)}
  </StrictMode>,
);
