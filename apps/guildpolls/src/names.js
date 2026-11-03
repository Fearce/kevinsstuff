export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 40;
export const TITLE_MIN_LENGTH = 3;
export const TITLE_MAX_LENGTH = 80;

const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
const CONTROL = /\p{Cc}/u;

export class NameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** An option name as it will be shown: NFKC, invisible characters removed, whitespace collapsed and trimmed. */
export function cleanName(raw) {
  return cleanText(raw, { min: NAME_MIN_LENGTH, max: NAME_MAX_LENGTH, empty: "Type a name first." });
}

/** A poll question, cleaned the same way as option names with a longer limit. */
export function cleanTitle(raw) {
  return cleanText(raw, { min: TITLE_MIN_LENGTH, max: TITLE_MAX_LENGTH, empty: "Give the poll a question first." });
}

/** The duplicate key: case-folded with every whitespace character removed, so "Iron  Wolves" and "ironwolves" collide. */
export function nameKey(cleaned) {
  return cleaned.toLowerCase().replace(/\s+/gu, "");
}

function cleanText(raw, { min, max, empty }) {
  if (typeof raw !== "string") throw new NameError("name_required", empty);
  const cleaned = raw.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
  if (CONTROL.test(cleaned)) throw new NameError("name_invalid", "That contains characters we can't show.");
  const length = [...cleaned].length;
  if (length === 0) throw new NameError("name_required", empty);
  if (length < min) throw new NameError("name_too_short", `Use at least ${min} characters.`);
  if (length > max) throw new NameError("name_too_long", `Keep it to ${max} characters or fewer.`);
  return cleaned;
}
