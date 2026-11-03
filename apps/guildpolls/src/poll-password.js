import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Guards poll creation with the shared guild password. Wrong guesses are counted per voter, and a voter
 * who keeps guessing is locked out for the rest of the window, so the password can't be brute-forced.
 */
export class PollPassword {
  #digest;
  #failures = new Map();
  #maxFailures;
  #windowMs;
  #now;

  constructor(password, { maxFailures = 5, windowMs = 15 * 60_000, now = Date.now } = {}) {
    if (typeof password !== "string" || password.length === 0) throw new Error("A poll password is required");
    this.#digest = digest(password);
    this.#maxFailures = maxFailures;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** @returns {"ok" | "wrong" | "locked"} */
  check(voter, attempt) {
    const record = this.#current(voter);
    if (record && record.count >= this.#maxFailures) return "locked";
    if (typeof attempt === "string" && timingSafeEqual(digest(attempt), this.#digest)) return "ok";
    this.#recordFailure(voter, record);
    return "wrong";
  }

  #current(voter) {
    const record = this.#failures.get(voter);
    if (record && this.#now() - record.start >= this.#windowMs) {
      this.#failures.delete(voter);
      return undefined;
    }
    return record;
  }

  #recordFailure(voter, record) {
    if (record) {
      record.count += 1;
      return;
    }
    if (this.#failures.size > 10_000) this.#prune();
    this.#failures.set(voter, { start: this.#now(), count: 1 });
  }

  #prune() {
    const now = this.#now();
    for (const [voter, record] of this.#failures) {
      if (now - record.start >= this.#windowMs) this.#failures.delete(voter);
    }
  }
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}
