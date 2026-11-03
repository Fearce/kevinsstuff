/**
 * A fixed-window counter per voter. It only stops a script from hammering the small shared host; the
 * poll rules themselves never depend on it.
 */
export class RateLimiter {
  #limit;
  #windowMs;
  #now;
  #windows = new Map();

  constructor({ limit, windowMs, now = Date.now }) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  allow(key) {
    const now = this.#now();
    const current = this.#windows.get(key);
    if (!current || now - current.start >= this.#windowMs) {
      if (this.#windows.size > 10_000) this.#prune(now);
      this.#windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.#limit;
  }

  #prune(now) {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
