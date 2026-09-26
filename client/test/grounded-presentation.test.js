import { expect, spyOn, test } from "bun:test";
import { loadContent } from "../../server/src/content.js";
import { captureMotion } from "../../shared/motion.js";
import { OnlinePrediction } from "../src/online/prediction.js";
import { createSimulation } from "../src/physics/simulation.js";
import { attachGround, detachGround } from "../src/physics/geometry.js";

const content = await loadContent();
const globals = (await content.map(content.catalog.defaultMap)).physics.globals;

/** Synthetic connected flat/slope geometry isolates presentation from input timing. */
function fixture() {
  const physics = {
    schemaVersion: 1,
    globals,
    map: {},
    ladders: [],
    footholds: [
      {
        id: 1,
        layer: 1,
        group: 0,
        x1: -200,
        y1: 0,
        x2: 0,
        y2: 0,
        prev: 0,
        next: 2,
        properties: {},
      },
      {
        id: 2,
        layer: 1,
        group: 0,
        x1: 0,
        y1: 0,
        x2: 200,
        y2: 100,
        prev: 1,
        next: 0,
        properties: {},
      },
    ],
  };
  const sim = createSimulation(physics, { x: -100, y: 0 });
  attachGround(sim, sim.geometry.byId.get(1));
  const prediction = new OnlinePrediction();
  prediction.install(sim, 0);
  prediction.observe(checkpoint(sim));
  return { prediction, sim };
}

function checkpoint(sim) {
  return {
    connectionEpoch: "connection",
    fieldEpoch: "field",
    serverTick: 0,
    ackInputSeq: null,
    paused: false,
    motion: captureMotion(sim),
  };
}

test("a landed checkpoint cannot leave the drawn character hovering", () => {
  const { prediction, sim } = fixture();
  const landed = checkpoint(sim);
  detachGround(sim);
  sim.y = sim.previousY = -40;
  prediction.interpolate(performance.now(), {});
  prediction.observe(landed);
  const before = captureMotion(sim);
  expect(prediction.interpolate(performance.now(), {}).y).toBe(0);
  expect(captureMotion(sim)).toEqual(before);
});

test("horizontal correction follows connected slopes without hovering or sinking", () => {
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  try {
    const { prediction, sim } = fixture();
    sim.x = 50;
    sim.y = 25;
    attachGround(sim, sim.geometry.byId.get(2));
    sim.previousX = sim.x;
    sim.previousY = sim.y;
    prediction.drawnX = -10;
    prediction.drawnY = 0;
    prediction.seedCorrection(-10, 0);
    const before = captureMotion(sim);
    for (let elapsed = 0; elapsed <= 900; elapsed += 30) {
      const pose = prediction.interpolate(1000 + elapsed, {});
      expect(pose.y).toBeCloseTo(pose.x < 0 ? 0 : pose.x / 2, 8);
    }
    expect(captureMotion(sim)).toEqual(before);
  } finally {
    clock.mockRestore();
  }
});

test("a correction cannot keep a grounded sprite beyond an unconnected ledge", () => {
  const { prediction, sim } = fixture();
  prediction.drawnX = -210;
  prediction.drawnY = -30;
  prediction.seedCorrection(-210, -30);
  const pose = prediction.interpolate(performance.now(), {});
  expect(pose.x).toBeGreaterThanOrEqual(-200);
  expect(pose.y).toBe(0);
  expect(sim.x).toBe(-100);
});

test("landing retires vertical correction before the next jump", () => {
  const { prediction, sim } = fixture();
  prediction.correctionY = -30;
  prediction.correctionUntil = performance.now() + 1000;
  prediction.correctionSpan = 1000;
  prediction.interpolate(performance.now(), {});
  detachGround(sim);
  sim.y = sim.previousY = -10;
  expect(prediction.interpolate(performance.now(), {}).y).toBe(-10);
});

test("landing keeps its normal interpolation quantum without extra vertical easing", () => {
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  try {
    const { prediction, sim } = fixture();
    sim.previousY = -12;
    prediction.lastStepAt = 1000;
    prediction.correctionY = -30;
    prediction.correctionSpan = 1000;
    prediction.correctionUntil = 2000;
    expect(prediction.interpolate(1015, {}).y).toBe(-6);
    expect(prediction.interpolate(1030, {}).y).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

test("contact follows the visible recoil simulation and does not ground an airborne preview", () => {
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  try {
    const { prediction, sim } = fixture();
    const { sim: preview } = fixture();
    detachGround(preview);
    preview.y = preview.previousY = -30;
    prediction.hitPreview = { sourceId: "hit", simulation: preview };
    prediction.correctionY = -10;
    prediction.correctionSpan = 1000;
    prediction.correctionUntil = 2000;
    const before = captureMotion(sim);
    expect(prediction.interpolate(1000, {}).y).toBe(-40);
    attachGround(preview, preview.geometry.byId.get(1));
    preview.previousY = preview.y;
    expect(prediction.interpolate(1000, {}).y).toBe(0);
    expect(captureMotion(sim)).toEqual(before);
  } finally {
    clock.mockRestore();
  }
});

test("a malformed foothold cycle cannot hang presentation or bridge empty space", () => {
  const { prediction, sim } = fixture();
  // Geometry is normally immutable and validated; fail closed if a link cycles anyway.
  sim.foothold.prev = sim.foothold;
  prediction.drawnX = -210;
  prediction.drawnY = -20;
  prediction.seedCorrection(-210, -20);
  const pose = prediction.interpolate(performance.now(), {});
  expect(pose.x).toBe(sim.x);
  expect(pose.y).toBe(sim.y);
});
