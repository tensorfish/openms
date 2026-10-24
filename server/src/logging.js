import { createDevelopmentLog } from "../../shared/development-log.js";

const PRODUCTION_EVENTS = new Set([
  "socket.open",
  "socket.attached",
  "socket.closing",
  "socket.closed",
  "watchdog.fault",
  "motion.fault",
  "movement.expired",
  "actor.rejected",
  "checkpoint.failed",
  "simulation.suspended",
]);

/** Production retains connection diagnostics; development also logs routine work. */
export function createServerLog(development, options = {}) {
  const log = createDevelopmentLog("server", options);
  return (event, fields) => {
    if (development || PRODUCTION_EVENTS.has(event)) log(event, fields);
  };
}
