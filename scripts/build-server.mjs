import { build } from "esbuild";

await build({
  entryPoints: {
    index: "src/server/index.ts",
    rehearsal: "src/server/rehearsal.ts",
    preflight: "scripts/preflight.ts",
    healthcheck: "scripts/healthcheck.ts",
    "verify-release": "scripts/verify-release.ts",
  },
  outdir: "dist-server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  legalComments: "none"
});
