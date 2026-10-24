import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitOnlineDeployment } from "../tools/online-deployment.js";

let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openms-online-deployment-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function build(outputs = [], shell = new Map()) {
  return {
    sourceBuildId: "source",
    content: { rulesHash: "rules", assetBuildId: "assets" },
    catalog: {},
    startupPack: {},
    shell,
    outputs: outputs.map((path) => ({
      path,
      arrayBuffer: async () => new TextEncoder().encode(path).buffer,
    })),
  };
}

test("deployment normalizes Windows and POSIX bundle paths to site URLs", async () => {
  const paths = [
    String.raw`D:\openms\client\dist\online\main.js`,
    "/tmp/openms/client/dist/online/chunk.js",
    String.raw`D:\openms\client\dist\online\atlas-worker.js`,
    "/tmp/openms/client/dist/online/audio-capture-worklet.js",
  ];
  const { directory, manifest } = await emitOnlineDeployment(
    root,
    build(paths),
  );
  expect(manifest.resources.map(({ url }) => url)).toEqual([
    "/dist/online/main.js",
    "/dist/online/chunk.js",
    "/dist/online/atlas-worker.js",
    "/dist/atlas-worker.js",
    "/dist/online/audio-capture-worklet.js",
    "/dist/audio-capture-worklet.js",
  ]);
  expect(await Bun.file(join(directory, "dist/online/main.js")).text()).toBe(
    paths[0],
  );
  expect(await Bun.file(join(directory, "dist/atlas-worker.js")).text()).toBe(
    paths[2],
  );
});

test.each([
  "/../../../outside.txt",
  "/dist/../outside.txt",
  String.raw`/dist\..\outside.txt`,
  "//server/share",
  "/C:/outside.txt",
  "/dist/%2e%2e/outside.txt",
  "/dist/main.js?query",
])(
  "deployment rejects noncanonical or escaping resource URL %s",
  async (url) => {
    const shell = new Map([[url, new TextEncoder().encode("outside")]]);
    await expect(emitOnlineDeployment(root, build([], shell))).rejects.toThrow(
      "Invalid deployment resource URL",
    );
  },
);
