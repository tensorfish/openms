# Map chat and input focus

A player types into map chat, sends a message or discards a draft, and returns to the game controls.

## Sub-features

- `chat-focus` keeps shortcut letters and a held arrow key in the text editor.
- `chat-send` displays one server-confirmed message in the To All channel.
- `chat-cancel` discards the draft with Escape without adding a matching message.
- `chat-return` releases editor focus so the next window or movement input reaches the game.

## How to get to it (user POV)

Expand chat from the HUD, select To All, click the message field, and type. Press Enter to send or Escape to cancel. After sending, Escape leaves the editor. Use the normal game shortcuts again.

## Driving it with playtest

Preconditions: the runner's ordinary player is active in Henesys, with an empty chat draft and no open blocking window.

- Run [chat-focus.json](../plans/chat-focus.json) using the parent skill's launch command and platform browser path.
- A custom action uses `type: chat`, `text`, and `mode: send` or `cancel`. The runner selects To All and refuses slash commands, surrounding spaces, non-ASCII text and text longer than 70 characters.
- During typing, the draft must match, focus must remain in the editor, the visible window list must stay unchanged, and authoritative horizontal displacement must stay within one pixel while ArrowRight is held for 200 ms. Vertical settling is not checked.
- Sending must add exactly one matching row marked `session`, channel `7`, delivery `server`. A pending local echo alone does not pass. Cancelling must clear the draft without adding a matching row. Both paths must release editor focus.
- Inspect the trace's `during.before`, `during.typed` and `during.after` observations. The plan then opens Item and sends movement inputs to exercise control recovery.

## Gotchas

- This observes the sender's server acknowledgement. Delivery to another player, whispers, parties and guilds require a second-player scenario.
- Repeated or rapid messages can hit the game's chat limits. The runner preserves those refusals and timeouts as candidates; it does not bypass rate limits.
- The draft is recorded as evidence, so use fixture text rather than personal information.
- History recall, IME input, sanitization and persisted chat preferences are outside this case.
