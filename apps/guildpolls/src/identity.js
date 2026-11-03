import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { voterAddress } from "./client-ip.js";

/**
 * Reads the server-side salt from `path`, creating it on first start. It lives beside the database in
 * the persistent volume, because a new salt would orphan every existing vote and creation count.
 */
export function loadSalt(path) {
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const salt = readFileSync(path, "utf8").trim();
  if (salt.length < 32) throw new Error(`Salt file ${path} is too short; delete it only if the poll is empty.`);
  return salt;
}

/** Salted HMAC of the voter's address, so the database never holds an IP in plain text. */
export function voterId(salt, ip) {
  return createHmac("sha256", salt).update(voterAddress(ip)).digest("base64url");
}
