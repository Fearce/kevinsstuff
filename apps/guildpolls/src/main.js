import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TrustedProxies } from "./client-ip.js";
import { loadSalt } from "./identity.js";
import { PollPassword } from "./poll-password.js";
import { RateLimiter } from "./rate-limit.js";
import { createPollServer } from "./server.js";
import { PollStore } from "./store.js";

const dataDir = resolve(process.env.DATA_DIR ?? "data");
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const release = readRelease(fileURLToPath(new URL("../release.json", import.meta.url)));

mkdirSync(dataDir, { recursive: true });
const store = new PollStore(join(dataDir, "guildpolls.sqlite"));
const salt = loadSalt(join(dataDir, "voter-salt"));
const trustedProxies = new TrustedProxies((process.env.TRUSTED_PROXIES ?? "").split(","));
await trustedProxies.refresh();
trustedProxies.startRefreshing(30_000);

const server = createPollServer({
  store,
  salt,
  trustedProxies,
  rateLimiter: new RateLimiter({ limit: 40, windowMs: 10_000 }),
  pollPassword: new PollPassword(process.env.GUILDPOLLS_POLL_PASSWORD),
  publicDir,
  release,
  log: (error) => console.error(error),
});

server.listen(port, host, () => {
  const proxies = trustedProxies.configured ? process.env.TRUSTED_PROXIES : "none (direct connections only)";
  console.log(`guildpolls listening on ${host}:${port}, data in ${dataDir}, trusted proxies: ${proxies}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    trustedProxies.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
}

// CI stamps release.json into each deployed build; a local checkout has none.
function readRelease(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).commit ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
