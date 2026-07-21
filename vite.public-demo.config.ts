import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const projectRoot = import.meta.dirname;
const publicDemoRoot = resolve(projectRoot, "public-demo");
const publicDemoSourceSegment = "/src/client/public-demo/";
const publicDemoHtmlInputs = Object.freeze({
  index: resolve(publicDemoRoot, "index.html"),
  operator: resolve(publicDemoRoot, "operator", "index.html"),
  displayDemo: resolve(publicDemoRoot, "display", "demo", "index.html"),
  deviceTest: resolve(publicDemoRoot, "device-test", "index.html"),
  healthz: resolve(publicDemoRoot, "healthz", "index.html"),
});
const expectedHtmlArtifacts = new Set([
  "index.html",
  "operator/index.html",
  "display/demo/index.html",
  "device-test/index.html",
  "healthz/index.html",
]);
const forbiddenSourcePatterns = [
  { label: "network API", pattern: /fetch\s*\(|XMLHttpRequest|\bWebSocket\b|EventSource|sendBeacon/u },
  { label: "browser persistence", pattern: /localStorage|sessionStorage|document\.cookie/iu },
] as const;
const forbiddenArtifactPatterns = [
  { label: "form destination", pattern: /forms\.gle|docs\.google\.com\/forms|Googleフォーム/iu },
  { label: "QR implementation", pattern: /qrcode|QRコード/iu },
  { label: "research API route", pattern: /\/api(?:\/|\b)/u },
  { label: "real-time route", pattern: /\/ws(?:[/'"`?]|\b)/u },
  { label: "browser persistence", pattern: /localStorage|sessionStorage|document\.cookie/iu },
  { label: "research credential", pattern: /researchId|operatorToken|displayToken|sessionId/iu },
  { label: "research logger", pattern: /ExperimentLogger|data\/sessions|\.jsonl\b|sessions\.csv/iu },
  { label: "device adapter", pattern: /SerialPufferDevice|MockPufferDevice|serialport/iu },
  { label: "internal condition code", pattern: /ABDC|BCAD|CDBA|DACB/u },
] as const;

function verifyPublicDemoArtifact(): Plugin {
  return {
    name: "verify-public-demo-artifact",
    enforce: "post",
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/").split("?", 1)[0] ?? id;
      if (!normalizedId.includes(publicDemoSourceSegment)) return null;
      for (const forbidden of forbiddenSourcePatterns) {
        const match = forbidden.pattern.exec(source);
        if (match !== null) {
          throw new Error(`Forbidden ${forbidden.label} found in public demo source: ${normalizedId}`);
        }
      }
      return null;
    },
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith(".map")) {
          throw new Error(`Source map is forbidden in the public demo artifact: ${fileName}`);
        }
        if (!expectedHtmlArtifacts.has(fileName) && !fileName.startsWith("assets/")) {
          throw new Error(`Unexpected public demo artifact: ${fileName}`);
        }

        const content = output.type === "chunk"
          ? output.code
          : typeof output.source === "string"
            ? output.source
            : new TextDecoder().decode(output.source);
        for (const forbidden of forbiddenArtifactPatterns) {
          const match = forbidden.pattern.exec(content);
          if (match !== null) {
            throw new Error(
              `Forbidden ${forbidden.label} (${JSON.stringify(match[0])}) found in public demo artifact: ${fileName}`,
            );
          }
        }
      }

      for (const expectedHtml of expectedHtmlArtifacts) {
        if (!(expectedHtml in bundle)) {
          throw new Error(`Required public review route is missing: ${expectedHtml}`);
        }
      }
    },
  };
}

export default defineConfig({
  root: publicDemoRoot,
  base: "./",
  publicDir: false,
  plugins: [react(), verifyPublicDemoArtifact()],
  build: {
    outDir: resolve(projectRoot, "dist-public-demo"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: publicDemoHtmlInputs,
    },
  },
});
