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
  const normalizedPath = pathname.replace(/\/+$/u, "") || "/";
  if (normalizedPath === "/operator.html") return <PublicOperatorApp />;
  if (normalizedPath === "/display-demo.html") return <PublicDisplayApp />;
  if (normalizedPath === "/device-test.html") return <PublicDeviceTestApp />;
  if (normalizedPath === "/healthz.html") return <PublicHealthApp />;
  return <PublicDemoApp />;
}

createRoot(rootElement).render(
  <StrictMode>
    {applicationForPath(window.location.pathname)}
  </StrictMode>,
);
