import { expect, test } from "bun:test";
import { OriginalContent, openOriginalContent } from "../src/original.js";
import { animationId, animationName } from "../../shared/motion-schema.js";

const original = await openOriginalContent();
const expandedActions = [
  ["103000105", "scavenger"],
  ["105100100", "gloomy"],
  ["106020000", "caugh"],
  ["261000000", "work"],
  ["261000001", "act3340"],
  ["261000002", "sword"],
  ["261000021", "prayer"],
  ["261010000", "experiment"],
  ["261020401", "hit"],
  ["300000010", "read"],
  ["300010200", "seek"],
  ["300010200", "wind"],
  ["300020200", "wheel"],
  ["600000000", "handup"],
  ["610010000", "die"],
  ["682000000", "weep"],
  ["682000100", "warring"],
  ["920020000", "ear"],
  ["922220000", "tear"],
  ["925020001", "leg"],
  ["925020001", "bong"],
  ["926120200", "potion"],
  ["926120200", "bubble"],
];

test("expanded original life actions are admitted and retain their authored wire names", async () => {
  for (const [mapId, name] of expandedActions) {
    const manifest = await original.map(mapId);
    expect(
      Object.values(manifest.life.templates).some((template) =>
        Object.hasOwn(template.actions, name),
      ),
    ).toBe(true);
    expect(animationName(animationId(name))).toBe(name);
  }
});

for (const boundary of ["default", "actions", "speech"]) {
  test(`map admission refuses an unsupported ${boundary} action before caching a field`, async () => {
    const manifest = structuredClone(await original.map("682000000"));
    const template = manifest.life.templates["npc:9201142"];
    const unsupported = "unregistered-authored-action";
    if (boundary === "default") template.defaultAction = unsupported;
    if (boundary === "actions") {
      template.actions[unsupported] = template.actions.stand;
    }
    if (boundary === "speech") template.speech.actions[0].action = unsupported;
    const isolated = new OriginalContent(original.root);
    isolated.catalog = original.catalog;
    isolated.json = async () => manifest;
    await expect(isolated.map("682000000")).rejects.toThrow(
      `Unsupported animation action: ${unsupported}`,
    );
    expect(isolated.maps.size).toBe(0);
    expect(isolated.pendingMaps.size).toBe(0);
  });
}

test("existing animation wire IDs remain stable and arbitrary names remain invalid", () => {
  expect(animationId("stand1")).toBe(0);
  expect(animationId("windshot")).toBe(250);
  expect(animationId("wink")).toBe(252);
  expect(() => animationId("unregistered-authored-action")).toThrow(
    "Unsupported animation action: unregistered-authored-action",
  );
});
