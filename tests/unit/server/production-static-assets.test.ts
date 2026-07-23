import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadFormalProductionClientAssets,
  type FormalProductionClientAssets,
} from "../../../scripts/production-release-verifier.js";
import { createProductionApplication } from "../../../src/server/production-app.js";
import type { SessionController } from "../../../src/server/sessions/session-controller.js";
import type { ExperimentConfig } from "../../../src/shared/schemas.js";

const temporaryDirectories: string[] = [];
const INDEX_BODY = "<!doctype html><html><body>verified-index</body></html>";
const SCRIPT_BODY = "globalThis.__verifiedAsset = true;";

function sha256(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function manifestSource(files: readonly {
  readonly path: string;
  readonly body: string;
  readonly bytes?: number;
  readonly digest?: string;
}[]): string {
  return `${JSON.stringify({
    schemaVersion: 4,
    appVersion: "1.1.0",
    protocolVersion: "R8-010-2x2-screen-v3",
    configHash: "1".repeat(64),
    configFileHash: "2".repeat(64),
    criticalConfigSha256: "3".repeat(64),
    goEvidenceSha256: "4".repeat(64),
    sourceCommit: "5".repeat(40),
    sourceTreeSha256: "6".repeat(64),
    sourceEvidenceBindingSha256: "7".repeat(64),
    createdAt: "2026-07-23T00:00:00.000Z",
    buildRuntime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    files: files.map((file) => ({
      path: file.path,
      bytes: file.bytes ?? Buffer.byteLength(file.body),
      sha256: file.digest ?? sha256(file.body),
    })),
  }, null, 2)}\n`;
}

async function createAssetRelease(options: {
  readonly scriptBytes?: number;
  readonly scriptDigest?: string;
  readonly scriptPath?: string;
} = {}): Promise<{ readonly root: string; readonly manifestSha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "sechack-production-assets-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await writeFile(join(root, "dist", "index.html"), INDEX_BODY, "utf8");
  await writeFile(join(root, "dist", "assets", "app.js"), SCRIPT_BODY, "utf8");
  const source = manifestSource([
    { path: "dist/index.html", body: INDEX_BODY },
    {
      path: options.scriptPath ?? "dist/assets/app.js",
      body: SCRIPT_BODY,
      ...(options.scriptBytes === undefined ? {} : { bytes: options.scriptBytes }),
      ...(options.scriptDigest === undefined ? {} : { digest: options.scriptDigest }),
    },
  ]);
  await writeFile(join(root, "DEPLOYMENT_MANIFEST.json"), source, "utf8");
  return { root, manifestSha256: sha256(source) };
}

const FORMAL_CONFIG = {
  schemaVersion: 1,
  protocolVersion: "R8-010-2x2-screen-v3",
  studyTitle: "formal static asset test",
  bindHost: "127.0.0.1",
  port: 4_173,
  researchIdPattern: "^SH26-[0-9]{3}$",
  orders: ["ABDC", "BCAD", "CDBA", "DACB"],
  fixedState: { score: 72, label: "高ストレス", pufferLevel: 0.6 },
  timingMs: {
    handling: 8_000,
    processing: 3_000,
    result: 15_000,
    reset: 7_000,
    inflateRamp: 6_000,
    deflateRamp: 6_000,
  },
  device: {
    mode: "screen",
    serialPath: "",
    baudRate: 115_200,
    ackTimeout: 1_000,
    allowMockInProduction: false,
  },
  formUrl: "",
  logging: { directory: "./data/sessions", includeAbortedInOrderBalancing: true },
  network: { allowLan: false, allowExternalRuntimeRequests: false },
} satisfies ExperimentConfig;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("formal production in-memory client assets", () => {
  it("loads only manifest-bound regular assets into bounded buffers", async () => {
    const fixture = await createAssetRelease();
    const loaded = await loadFormalProductionClientAssets(
      fixture.root,
      fixture.manifestSha256,
    );

    expect(loaded.index.requestPath).toBe("/index.html");
    expect(loaded.index.body.toString("utf8")).toBe(INDEX_BODY);
    expect(loaded.files.map((asset) => asset.requestPath)).toEqual([
      "/assets/app.js",
      "/index.html",
    ]);
    expect(loaded.totalBytes).toBe(Buffer.byteLength(INDEX_BODY) + Buffer.byteLength(SCRIPT_BODY));
  });

  it.each([
    ["size", { scriptBytes: Buffer.byteLength(SCRIPT_BODY) + 1 }, /size changed/iu],
    ["SHA-256", { scriptDigest: "8".repeat(64) }, /SHA-256 changed/iu],
    ["path", { scriptPath: "dist/../escape.js" }, /valid structure/iu],
    ["type", { scriptPath: "dist/assets/app.js.map" }, /unsupported formal client asset type/iu],
  ] as const)("rejects a post-verification %s mismatch", async (_name, options, pattern) => {
    const fixture = await createAssetRelease(options);
    await expect(
      loadFormalProductionClientAssets(fixture.root, fixture.manifestSha256),
    ).rejects.toThrow(pattern);
  });

  it("rejects hard-linked client files", async () => {
    const fixture = await createAssetRelease();
    const linkedPath = join(fixture.root, "data-copy.js");
    await link(join(fixture.root, "dist", "assets", "app.js"), linkedPath);

    await expect(
      loadFormalProductionClientAssets(fixture.root, fixture.manifestSha256),
    ).rejects.toThrow(/unique regular file/iu);
  });

  it("rejects a linked client parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sechack-production-linked-assets-"));
    temporaryDirectories.push(root);
    const realAssets = join(root, "real-assets");
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(realAssets);
    await writeFile(join(root, "dist", "index.html"), INDEX_BODY, "utf8");
    await writeFile(join(realAssets, "app.js"), SCRIPT_BODY, "utf8");
    await symlink(
      realAssets,
      join(root, "dist", "assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const source = manifestSource([
      { path: "dist/index.html", body: INDEX_BODY },
      { path: "dist/assets/app.js", body: SCRIPT_BODY },
    ]);
    await writeFile(join(root, "DEPLOYMENT_MANIFEST.json"), source, "utf8");

    await expect(
      loadFormalProductionClientAssets(root, sha256(source)),
    ).rejects.toThrow(/parent must be an ordinary directory/iu);
  });

  it("serves the startup buffers after on-disk assets are replaced", async () => {
    const fixture = await createAssetRelease();
    const clientAssets: FormalProductionClientAssets = await loadFormalProductionClientAssets(
      fixture.root,
      fixture.manifestSha256,
    );
    const application = await createProductionApplication({
      controller: { isRehearsal: false } as unknown as SessionController,
      config: FORMAL_CONFIG,
      configHash: "9".repeat(64),
      appVersion: "1.1.0",
      clientAssets,
    });
    const server = createServer(application.app);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test server did not bind.");
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;

    try {
      expect(await (await fetch(`${baseUrl}/operator`)).text()).toBe(INDEX_BODY);
      expect(await (await fetch(`${baseUrl}/assets/app.js`)).text()).toBe(SCRIPT_BODY);
      await writeFile(join(fixture.root, "dist", "index.html"), "replaced-index", "utf8");
      await writeFile(join(fixture.root, "dist", "assets", "app.js"), "replaced-script", "utf8");

      expect(await (await fetch(`${baseUrl}/operator`)).text()).toBe(INDEX_BODY);
      expect(await (await fetch(`${baseUrl}/assets/app.js`)).text()).toBe(SCRIPT_BODY);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await application.close();
    }
  });
});
