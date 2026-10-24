import { expect, test } from "bun:test";
import {
  retainAttackInput,
  takeAttackInput,
  resetAttackInput,
} from "../src/attack-input.js";
import { createPlayerInput } from "../../client/src/input/player-input.js";

function actor() {
  return { field: { tick: 100 }, attackEdges: [], receivedAttack: false };
}
function sample(attack, inputSeq, targetTick = 80) {
  return { attack, inputSeq, targetTick };
}

function withNativeAttacks(run) {
  const previous = globalThis.window;
  const windowTarget = new EventTarget();
  globalThis.window = windowTarget;
  const canvas = new EventTarget();
  const input = createPlayerInput(canvas);
  const a = actor();
  let inputSeq = 0;
  const edge = (pressed) => {
    const event = new Event(pressed ? "keydown" : "keyup", {
      cancelable: true,
    });
    Object.assign(event, { code: "ControlLeft", repeat: false });
    (pressed ? canvas : windowTarget).dispatchEvent(event);
    const retained = retainAttackInput(
      a,
      sample(input.state.attack, ++inputSeq, a.field.tick),
    );
    input.afterTick();
    return retained;
  };
  try {
    run(a, edge);
  } finally {
    input.destroy();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("ordinary native taps discard expired attack intentions while async combat admission is held", () => {
  withNativeAttacks((a, edge) => {
    for (let press = 0; press < 9; press++) {
      expect(() => edge(true)).not.toThrow();
      edge(false);
      // A skill or durable incoming-hit task can hold combat consumption while
      // ordinary 30 ms movement continues. This is only 2.8 presses per second.
      a.field.tick += 12;
    }
    expect(a.attackEdges.length).toBeLessThanOrEqual(8);
    expect(
      a.attackEdges.every((entry) => entry.expires >= a.field.tick - 12),
    ).toBe(true);
    expect(takeAttackInput(a)).toBe(true);
  });
});

test("rapid native attack taps cannot disconnect movement when the bounded combat queue is full", () => {
  withNativeAttacks((a, edge) => {
    for (let press = 0; press < 8; press++) {
      edge(true);
      edge(false);
      a.field.tick += 4;
    }
    const original = a.attackEdges.map((entry) => entry.inputSeq);
    a.admission = "Existing command refusal";
    expect(edge(true)).toBe(false);
    expect(a.attackEdges.map((entry) => entry.inputSeq)).toEqual(original);
    expect(a.attackAdmission).toBe("COOLDOWN");
    expect(a.admission).toBe("Existing command refusal");
    a.field.tick++;
    expect(takeAttackInput(a)).toBe(true);
    expect(edge(true)).toBe(false);
    expect(a.attackEdges).toHaveLength(7);
    edge(false);
    expect(edge(true)).toBe(true);
    expect(a.attackAdmission).toBeNull();
    expect(a.attackEdges).toHaveLength(8);
  });
});

test("field replacement retires queued and held attack identities before new-field consumption", () => {
  const a = actor();
  a.hitReports = new Map([["old-attack", {}]]);
  expect(retainAttackInput(a, sample(true, 1, 100))).toBe(true);
  a.field = { tick: 0 };
  resetAttackInput(a);
  expect(a.attackEdges).toEqual([]);
  expect(a.receivedAttack).toBe(false);
  expect(a.combatInputSeq).toBeNull();
  expect(a.attackAdmission).toBeNull();
  expect(a.hitReports.size).toBe(0);
  expect(retainAttackInput(a, sample(true, 2, 0))).toBe(true);
  expect(takeAttackInput(a)).toBe(false);
  a.field.tick++;
  expect(takeAttackInput(a)).toBe(true);
  expect(a.combatInputSeq).toBe(2);
  expect(takeAttackInput(a)).toBe(false);
});

test("an expired movement sample preserves one attack through a bunched press/release", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1));
  retainAttackInput(a, sample(true, 2));
  retainAttackInput(a, sample(false, 3));
  expect(takeAttackInput(a)).toBe(false);
  a.field.tick++;
  expect(takeAttackInput(a)).toBe(true);
  expect(a.combatInputSeq).toBe(1);
  expect(takeAttackInput(a)).toBe(false);
});

test("future, ancient, overloaded and expired attack edges have explicit bounds", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1, 1000));
  retainAttackInput(a, sample(false, 2));
  retainAttackInput(a, sample(true, 3, 1));
  expect(a.attackEdges).toHaveLength(0);
  for (let i = 0; i < 8; i++) {
    retainAttackInput(a, sample(false, i * 2 + 4));
    retainAttackInput(a, sample(true, i * 2 + 5));
  }
  retainAttackInput(a, sample(false, 20));
  expect(retainAttackInput(a, sample(true, 21))).toBe(false);
  expect(a.attackEdges).toHaveLength(8);
  expect(a.attackAdmission).toBe("COOLDOWN");
  a.field.tick = 1000;
  expect(takeAttackInput(a)).toBe(false);
});

test("queued attacks survive an active animation but their age never resets", () => {
  const a = actor();
  retainAttackInput(a, sample(true, 1, 99));
  retainAttackInput(a, sample(false, 2, 100));
  retainAttackInput(a, sample(true, 3, 101));
  a.field.tick = 110;
  expect(takeAttackInput(a, false)).toBe(false);
  expect(a.attackEdges).toHaveLength(2);
  expect(takeAttackInput(a, true)).toBe(true);
  expect(a.combatInputSeq).toBe(1);
  a.field.tick = 169;
  expect(takeAttackInput(a, true)).toBe(false);
  expect(a.attackEdges).toHaveLength(0);
});
