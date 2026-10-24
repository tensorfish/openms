import { expect, test } from "bun:test";
import { NativeTransitions } from "../src/online/native-transitions.js";
import { AtlasStore } from "../src/rendering/stream-atlas.js";

const catalog = await Bun.file(
  new URL("../public/generated/catalog.json", import.meta.url),
).json();
const hash = "a".repeat(64);

function message() {
  return {
    transitionId: "travel",
    sourceEpoch: "source",
    destination: {
      mapId: 922020300,
      fieldEpoch: "destination",
      spawn: { x: 0, y: 0 },
    },
    requiredContent: [hash],
    deadline: 1000,
    preparation: { parts: 1, part: 0, serverTick: 0, entities: [] },
  };
}

function transitionOwner() {
  const source = { fieldEpoch: "source" };
  const ready = [];
  const owner = {
    app: { screen: { width: 800, height: 600 } },
    catalog: {
      ...catalog,
      maps: { 922020300: { sha256: hash } },
    },
    state: { self: { entity: { id: "self" } } },
    hooks: { scene: () => source, loading: { includeMap() {} } },
    transport: { sendTransitionReady: (...args) => ready.push(args) },
    report(error) {
      throw error;
    },
  };
  const transitions = Object.assign(
    Object.create(NativeTransitions.prototype),
    {
      owner,
      active: null,
      sequence: 0,
      fade: {
        begin: () => ({ covered: Promise.resolve(true) }),
        cancel() {},
        fail() {},
      },
    },
  );
  return { transitions, owner, ready };
}

function atlasStore() {
  return Object.assign(Object.create(AtlasStore.prototype), {
    records: new Map(),
    cpuBytes: 0,
    gpuBytes: 0,
    evictions: 0,
    backpressure: 0,
    network: { load: async () => new Uint8Array(4) },
    decoder: {
      decode: async () => ({ width: 1, height: 1, close() {} }),
      gate: { active: 0, queue: [] },
    },
    uploads: { add: async () => {}, queue: [] },
  });
}

function pendingRegionManifest() {
  return {
    schemaVersion: 2,
    id: "922020300",
    camera: { x: 0, y: 0 },
    bounds: { left: 0, top: 0, right: 800, bottom: 600 },
    actors: [
      {
        id: "decorative-object",
        order: 0,
        kind: "map",
        x: 0,
        y: 0,
        z: 0,
        action: "stand",
        actions: {
          stand: [
            {
              delay: 100,
              parts: [{ texture: "pixel", x: 0, y: 0, z: 0 }],
            },
          ],
        },
      },
    ],
    textures: { pixel: { atlas: "tiny", x: 0, y: 0, width: 1, height: 1 } },
    atlases: {
      tiny: {
        url: `/generated/atlases/${hash}.png`,
        sha256: hash,
        bytes: 4,
        width: 1,
        height: 1,
      },
    },
    physics: { footholds: [] },
    regions: [
      {
        id: "pending-region",
        url: `/generated/regions/${hash}.json`,
        sha256: hash,
        bytes: 1,
        bounds: { left: 0, top: 0, right: 800, bottom: 600 },
        always: true,
        atlases: [],
      },
    ],
  };
}

test("canceling transition preparation aborts the candidate's pending region immediately", async () => {
  const { transitions, owner } = transitionOwner();
  const admitted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const controller = new AbortController();
  const store = atlasStore();
  owner.services = {
    atlases: store,
    network: {
      async json(descriptor, signal) {
        if (!descriptor.id) return pendingRegionManifest();
        admitted.resolve(signal);
        await finish.promise;
        throw new DOMException("Fixture region canceled", "AbortError");
      },
    },
  };
  const entity = { id: "self", kind: "player" };
  const preparation = transitions.loadScene(
    message(),
    controller.signal,
    { entities: [entity], serverTick: 0 },
    null,
  );
  try {
    const regionSignal = await admitted.promise;
    expect(store.snapshot().cpuDecodedBytes).toBe(4);
    controller.abort();
    expect(regionSignal.aborted).toBe(true);
    expect(store.snapshot().cpuDecodedBytes).toBe(0);
    expect(store.snapshot().atlases).toBe(0);
  } finally {
    finish.resolve();
    await expect(preparation).rejects.toMatchObject({ name: "AbortError" });
  }
});

test("a canceled transition destroys a candidate completed before its continuation resumes", async () => {
  const { transitions, ready } = transitionOwner();
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    const staged = Promise.withResolvers();
    transitions.stage = () => staged.promise;
    const preparation = transitions.prepare(message());
    await Promise.resolve();
    transitions.cancel();
    staged.resolve(candidate);
    await preparation;
    expect(candidate.destroyed).toBe(true);
  }
  expect(transitions.active).toBeNull();
  expect(ready).toEqual([]);
});

test("atlas failure before commit refuses transition readiness and leaves the source field installed", async () => {
  const { transitions, owner, ready } = transitionOwner();
  const source = owner.hooks.scene();
  const failures = [];
  owner.report = (error) => failures.push(error.message);
  transitions.stage = async () => {
    throw new Error("Atlas residency backpressure: current map retained");
  };
  await transitions.prepare(message());
  expect(owner.hooks.scene()).toBe(source);
  expect(transitions.active).toBeNull();
  expect(ready).toEqual([["travel", false, "source"]]);
  expect(failures).toEqual([
    "Atlas residency backpressure: current map retained",
  ]);
});
