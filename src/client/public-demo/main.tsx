import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PublicDemoApp } from "./PublicDemoApp.js";
import "./public-demo.css";

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Public demo root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <PublicDemoApp />
  </StrictMode>,
);
