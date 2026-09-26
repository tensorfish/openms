import { MAX_TRANSITIONS } from "../physics/geometry.js";

const CONTACT_EPSILON = 0.001;

/** Resolve only connected supporting surfaces; never bridge a wall, gap or platform. */
function supportingFloor(start, x) {
  let floor = start;
  for (let count = 0; floor && count < MAX_TRANSITIONS; count++) {
    if (floor.tx <= 0) return null;
    if (x >= floor.x1 && x <= floor.x2) return floor;
    const before = x < floor.x1;
    const next = before ? floor.prev : floor.next;
    if (!next || next.tx <= 0) return null;
    if (!joinedFloors(floor, next, before)) return null;
    floor = next;
  }
  return null;
}

function joinedFloors(floor, next, before) {
  return before
    ? next.x2 === floor.x1 && next.y2 === floor.y1
    : next.x1 === floor.x2 && next.y1 === floor.y2;
}

function heightAt(floor, x) {
  return floor.y1 + ((x - floor.x1) * floor.dy) / floor.dx;
}

/** Keep the original landing interpolation, but never extend it with a visual offset. */
function landingGap(sim, x, y) {
  const previousFloor = supportingFloor(sim.foothold, sim.previousX);
  if (
    previousFloor &&
    Math.abs(sim.previousY - heightAt(previousFloor, sim.previousX)) <=
      CONTACT_EPSILON
  ) {
    return 0;
  }
  const floor = supportingFloor(sim.foothold, x);
  return floor ? Math.min(0, y - heightAt(floor, x)) : 0;
}

/** Project a corrected grounded pose onto its connected floor without changing physics.
 * Returns false when horizontal easing would draw the actor over an unsupported edge. */
export function constrainGroundPresentation(sim, pose, baseX, baseY) {
  let floor = supportingFloor(sim.foothold, pose.x);
  const supported = floor !== null;
  if (!floor) {
    pose.x = baseX;
    floor = supportingFloor(sim.foothold, baseX);
    if (!floor) {
      pose.x = sim.x;
      floor = sim.foothold;
    }
  }
  pose.y = heightAt(floor, pose.x) + landingGap(sim, baseX, baseY);
  return supported;
}
