const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 180000;
const STABLE_INPUT_MS = 10000;
const INPUT_GAP_MS = 1000;
const RETRYABLE = new Set([
  "RESYNC_REQUIRED",
  "CONNECTION_LOST",
  "SOCKET_ERROR",
  "HEARTBEAT_TIMEOUT",
  "CONNECT_TIMEOUT",
  "SERVER_BUSY",
  "CHARACTER_BUSY",
]);

/** Recovery reuses authenticated entry; no skipped movement or new credential proof. */
export class TransportRecovery {
  constructor(transport) {
    this.transport = transport;
    this.pending = null;
    this.task = null;
    this.attempts = 0;
    this.inputSince = null;
    this.lastInputAt = null;
    this.failureCode = null;
  }
  cancel() {
    this.pending = null;
    this.attempts = 0;
    this.inputSince = this.lastInputAt = null;
    this.failureCode = null;
  }
  owns(pending) {
    const owner = this.transport;
    return (
      this.pending === pending &&
      !owner.closed &&
      !owner.revoking &&
      owner.characterId === pending.characterId
    );
  }
  lost(code) {
    const owner = this.transport;
    this.failureCode = null;
    if (
      !RETRYABLE.has(code) ||
      !owner.characterId ||
      !owner.playSession ||
      !owner.model ||
      !owner.config
    ) {
      this.pending = null;
      return false;
    }
    if (this.attempts >= MAX_ATTEMPTS) {
      this.pending = null;
      this.failureCode = "RECOVERY_EXHAUSTED";
      return false;
    }
    this.pending ??= {
      characterId: owner.characterId,
      deadline: null,
      nextAt: 0,
    };
    this.pending.nextAt =
      performance.now() + (this.attempts ? 1000 * this.attempts : 0);
    return true;
  }
  advance(now = performance.now()) {
    const pending = this.pending;
    if (!pending || !this.owns(pending) || globalThis.document?.hidden) return;
    pending.deadline ??= now + ATTEMPT_WINDOW_MS;
    if (now > pending.deadline) return this.finish("RECOVERY_TIMEOUT");
    if (this.task || now < pending.nextAt) return;
    if (this.attempts >= MAX_ATTEMPTS) return this.finish("RECOVERY_EXHAUSTED");
    this.attempts++;
    this.task = this.run(pending).finally(() => {
      this.task = null;
    });
  }
  async run(pending) {
    try {
      await this.transport.connect(
        { characterId: pending.characterId },
        pending,
      );
    } catch (error) {
      if (!this.owns(pending)) return;
      const code =
        error.httpStatus >= 500
          ? "SERVER_BUSY"
          : error instanceof TypeError
            ? "CONNECTION_LOST"
            : (error.code ?? error.message);
      if (!RETRYABLE.has(code)) return this.finish(code);
      pending.nextAt = performance.now() + 1000 * this.attempts;
      this.transport.setStatus("recovering", code);
    }
  }
  finish(code) {
    this.pending = null;
    this.transport.intentGeneration++;
    this.transport.disconnected(code);
  }
  ready() {
    this.pending = null;
    this.inputSince = this.lastInputAt = null;
  }
  /** Reset the incident budget only after sustained proved input, not just a welcome. */
  input(now = performance.now()) {
    if (this.lastInputAt === null || now - this.lastInputAt > INPUT_GAP_MS) {
      this.inputSince = now;
    }
    this.lastInputAt = now;
    if (now - this.inputSince >= STABLE_INPUT_MS) this.attempts = 0;
  }
}
