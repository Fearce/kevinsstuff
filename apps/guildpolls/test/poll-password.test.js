import { test } from "node:test";
import assert from "node:assert/strict";
import { PollPassword } from "../src/poll-password.js";

test("accepts only the exact password", () => {
  const gate = new PollPassword("open sesame");
  assert.equal(gate.check("alice", "open sesame"), "ok");
  for (const attempt of ["Open sesame", "open sesame ", "", undefined, 123]) {
    assert.equal(new PollPassword("open sesame").check("bob", attempt), "wrong");
  }
});

test("locks a voter out after five wrong guesses for the window, even with the right password", () => {
  let now = 0;
  const gate = new PollPassword("open sesame", { now: () => now });
  for (let i = 0; i < 5; i += 1) assert.equal(gate.check("mallory", "guess"), "wrong");
  assert.equal(gate.check("mallory", "open sesame"), "locked");
  assert.equal(gate.check("alice", "open sesame"), "ok");
  now = 15 * 60_000;
  assert.equal(gate.check("mallory", "open sesame"), "ok");
});

test("refuses to start without a password", () => {
  assert.throws(() => new PollPassword(undefined));
  assert.throws(() => new PollPassword(""));
});
