import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PollStore } from "./store.js";

const KEEP = 10;

/** Snapshots the poll into DATA_DIR/backups and keeps the newest ten. Run before every redeploy. */
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const backupDir = join(dataDir, "backups");
mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(backupDir, `guildpolls-${stamp}.sqlite`);
const store = new PollStore(join(dataDir, "guildpolls.sqlite"));
try {
  store.backupTo(target);
} finally {
  store.close();
}

const backups = readdirSync(backupDir).filter((name) => /^guildpolls-.*\.sqlite$/.test(name)).sort();
for (const old of backups.slice(0, -KEEP)) rmSync(join(backupDir, old));
console.log(`backup written: ${target} (${Math.min(backups.length, KEEP)} kept)`);
