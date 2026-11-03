import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/rate-limit.js";

test("allows up to the limit per window, per key, then resets", () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.allow("a")), [true, true, true, false]);
  assert.equal(limiter.allow("b"), true);
  now = 1000;
  assert.equal(limiter.allow("a"), true);
});
