import { expect, test } from "bun:test";
import { OnlineWorld } from "../src/world.js";
import { protocolError } from "../../shared/schema.js";
import { retainAttackInput } from "../src/attack-input.js";

function worldWithLog() {
  const published = [];
  const logged = [];
  const world = new OnlineWorld({
    content: {},
    database: {},
    publish(actor, record) {
      published.push({ actor: actor.id, record });
    },
  });
  world.log = (event, fields) => logged.push({ event, fields });
  return { world, published, logged };
}

function actor(id) {
  const closes = [];
  return {
    id,
    field: { mapId: 100000000, tick: 100 },
    attackEdges: [],
    receivedAttack: false,
    connection: { close: (code, reason) => closes.push({ code, reason }) },
    closes,
  };
}

test("a full basic-attack queue preserves movement and the other actors", () => {
  const { world, published, logged } = worldWithLog();
  const spammer = actor("spammer");
  const walker = actor("walker");
  // Normal native presses during a long cast can exceed the combat buffer.
  world.moveActor = (target) => {
    if (target !== spammer) {
      target.moved = true;
      return;
    }
    for (let i = 0; i < 9; i++) {
      retainAttackInput(target, {
        attack: false,
        inputSeq: i * 2,
        targetTick: 100,
      });
      retainAttackInput(target, {
        attack: true,
        inputSeq: i * 2 + 1,
        targetTick: 100,
      });
    }
    target.moved = true;
  };
  world.neutralize = (target) => (target.neutralized = true);

  for (const target of [spammer, walker]) world.moveActorIsolated(target);

  expect(walker.moved).toBe(true);
  expect(walker.closes).toEqual([]);
  expect(spammer.moved).toBe(true);
  expect(spammer.attackEdges).toHaveLength(8);
  expect(spammer.attackAdmission).toBe("COOLDOWN");
  expect(spammer.closes).toEqual([]);
  expect(published).toEqual([]);
  expect(logged).toEqual([]);
});

test("server faults without a protocol code still reach the lifecycle", () => {
  const { world } = worldWithLog();
  world.moveActor = () => {
    throw new TypeError("server bug");
  };
  expect(() => world.moveActorIsolated(actor("anyone"))).toThrow("server bug");
  world.moveActor = () => {
    throw protocolError("INVALID_MESSAGE");
  };
  world.neutralize = () => {};
  const faulty = actor("faulty");
  world.moveActorIsolated(faulty);
  expect(faulty.closes).toEqual([{ code: 1008, reason: "INVALID_MESSAGE" }]);
});
