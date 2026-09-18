import { setTimeout as delay } from "node:timers/promises";
import { assertion } from "../native-evidence.js";
import { clickLabel, focusCanvas } from "./native.js";

/** Runs inside the browser and only reads the draft, visible panels and received rows. */
function chatObservation(text) {
  const input = document.querySelector('[aria-label="Chat message"]');
  const rows = Array.from(
    document.querySelectorAll(".maple-ui-chat-log > div"),
  );
  if (rows.length > 128) {
    throw new Error("Chat evidence exceeded its row bound");
  }
  const expected = `Playtester: ${text}`;
  const matchingText = [
    expected,
    `${expected} (sending…)`,
    `${expected} (not sent)`,
  ];
  const matching = rows
    .filter((row) => matchingText.includes(row.textContent))
    .map((row) => ({
      text: row.textContent,
      delivery: row.dataset.delivery,
      channel: row.dataset.chatChannel,
      source: row.dataset.chatSource,
    }));
  return {
    draft: input?.value,
    focused: document.activeElement === input,
    x: window.mapleOnline.observation().self.entity.position.x,
    windows: Array.from(document.querySelectorAll(".maple-ui-panel"))
      .filter((node) => node.getBoundingClientRect().width > 0)
      .map((node) => node.getAttribute("aria-label")),
    matching,
  };
}

async function typeChat(page, action, signal) {
  const before = await page.evaluate(chatObservation, action.text);
  assertion(before.draft === "", "Chat action requires an empty draft");
  await page.type('[aria-label="Chat message"]', action.text, { delay: 20 });
  // A nonempty editor must own arrow keys as well as character-window shortcuts.
  await page.keyboard.down("ArrowRight");
  try {
    await delay(200, null, { signal });
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  const typed = await page.evaluate(chatObservation, action.text);
  assertion(
    typed.focused && typed.draft === action.text,
    "Chat lost its typed draft",
  );
  assertion(
    Math.abs(typed.x - before.x) <= 1,
    "Chat editing moved the character",
  );
  assertion(
    JSON.stringify(typed.windows) === JSON.stringify(before.windows),
    "Chat typing triggered a character window",
  );
  return { before, typed };
}

async function sendChat(page, text, previousCount) {
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (text, count) => {
      const rows = document.querySelectorAll(
        '.maple-ui-chat-log > [data-chat-source="session"][data-chat-channel="7"][data-delivery="server"]',
      );
      return (
        Array.from(rows).filter(
          (row) => row.textContent === `Playtester: ${text}`,
        ).length > count
      );
    },
    {},
    text,
    previousCount,
  );
  await page.keyboard.press("Escape");
}

/** Type and send/cancel normal map chat; never call the chat mutation API directly. */
export async function drivePlaytestChat(page, action, signal) {
  await focusCanvas(page);
  const expanded = await page.$eval(
    '[aria-label="Expand chat"]',
    (node) => node.getBoundingClientRect().width > 0,
  );
  if (expanded) await clickLabel(page, "Expand chat");
  await page.click('[aria-label^="Chat channel:"]');
  await page.click('[role="option"][data-chat-channel="7"]');
  await page.click('[aria-label="Chat message"]');
  const result = await typeChat(page, action, signal);
  if (action.mode === "send") {
    await sendChat(page, action.text, result.before.matching.length);
  } else await page.keyboard.press("Escape");
  const after = await page.evaluate(chatObservation, action.text);
  assertion(
    after.draft === "" && !after.focused,
    "Chat did not release its draft and focus",
  );
  const expected =
    result.before.matching.length + (action.mode === "send" ? 1 : 0);
  assertion(
    after.matching.length === expected,
    "Chat sent an unexpected number of messages",
  );
  return { ...result, after };
}
