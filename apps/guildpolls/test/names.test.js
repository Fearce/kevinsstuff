import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_MAX_LENGTH, cleanName, nameKey } from "../src/names.js";

test("trims and collapses whitespace for display", () => {
  assert.equal(cleanName("   Iron \t  Wolves  "), "Iron Wolves");
});

test("duplicate key ignores case and every whitespace character", () => {
  const keys = ["Iron Wolves", "iron wolves", "IRONWOLVES", " iron　 wolves ", "Iron​ Wolves"].map((name) =>
    nameKey(cleanName(name)),
  );
  assert.equal(new Set(keys).size, 1);
});

test("full-width and compatibility characters fold to the same key", () => {
  assert.equal(nameKey(cleanName("ＩＲＯＮ Wolves")), nameKey(cleanName("iron wolves")));
});

test("rejects empty, whitespace-only and invisible-only names", () => {
  for (const raw of ["", "     ", "​​", undefined, 42]) {
    assert.throws(() => cleanName(raw), { code: "name_required" });
  }
});

test("rejects names that are too short or too long", () => {
  assert.throws(() => cleanName("x"), { code: "name_too_short" });
  assert.equal(cleanName("x".repeat(NAME_MAX_LENGTH)).length, NAME_MAX_LENGTH);
  assert.throws(() => cleanName("x".repeat(NAME_MAX_LENGTH + 1)), { code: "name_too_long" });
});

test("counts length in characters, not UTF-16 units", () => {
  assert.equal([...cleanName("🐺".repeat(NAME_MAX_LENGTH))].length, NAME_MAX_LENGTH);
});

test("rejects control characters", () => {
  assert.throws(() => cleanName("Iron\u0007Wolves"), { code: "name_invalid" });
});

test("keeps markup characters verbatim; escaping is the renderer's job", () => {
  assert.equal(cleanName("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>");
});
