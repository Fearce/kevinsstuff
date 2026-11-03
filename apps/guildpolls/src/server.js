import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { clientIp } from "./client-ip.js";
import { voterId } from "./identity.js";
import { NameError } from "./names.js";
import { PollError } from "./store.js";

const MAX_BODY_BYTES = 4096;
const POLL_PAGE = /^\/p\/[a-z0-9-]{3,40}\/?$/;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Builds the HTTP server. Every vote and option is keyed on the voter id derived from the real client
 * address (see client-ip.js), so the rules hold no matter what the browser sends.
 */
export function createPollServer({ store, salt, trustedProxies, rateLimiter, pollPassword, publicDir, release = null, log = () => {} }) {
  const assets = loadAssets(publicDir);
  const poll = "([a-z0-9-]{3,40})";
  const option = "(\\d{1,15})";
  const route = (method, pattern, handler) => [method, new RegExp(`^/api${pattern}$`), handler];

  const routes = [
    route("GET", "/health", () => json(200, { ok: true, release })),
    route("GET", "/polls", () => json(200, { polls: store.listPolls() })),
    route("POST", "/polls", ({ voter, body }) => {
      const verdict = pollPassword.check(voter, body?.password);
      if (verdict === "locked") throw new HttpError(429, "password_locked", "Too many wrong passwords. Try again in a while.");
      if (verdict !== "ok") throw new HttpError(401, "bad_password", "That's not the guild password.");
      const id = store.createPoll(voter, body?.title);
      return json(201, store.state(id, voter));
    }),
    route("GET", `/polls/${poll}`, ({ voter, params: [id] }) => json(200, store.state(id, voter))),
    route("POST", `/polls/${poll}/options`, ({ voter, body, params: [id] }) => {
      store.addOption(id, voter, body?.name);
      return json(201, store.state(id, voter));
    }),
    route("PUT", `/polls/${poll}/options/${option}/vote`, ({ voter, params: [id, optionId] }) => {
      store.vote(id, voter, Number(optionId));
      return json(200, store.state(id, voter));
    }),
    route("DELETE", `/polls/${poll}/options/${option}/vote`, ({ voter, params: [id, optionId] }) => {
      store.unvote(id, voter, Number(optionId));
      return json(200, store.state(id, voter));
    }),
    route("DELETE", `/polls/${poll}/votes`, ({ voter, params: [id] }) => {
      store.resetVotes(id, voter);
      return json(200, store.state(id, voter));
    }),
  ];

  return createServer(async (req, res) => {
    try {
      const response = await handle(req);
      send(req, res, response);
    } catch (error) {
      send(req, res, errorResponse(error, log));
    }
  });

  async function handle(req) {
    const path = new URL(req.url, "http://local").pathname;
    if (!path.startsWith("/api/")) return staticAsset(req.method, path);

    const match = findRoute(req.method, path);
    if (match === null) throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    if (!match) throw new HttpError(404, "not_found", "No such endpoint.");
    const ip = clientIp(req, trustedProxies);
    if (!ip) throw new HttpError(400, "no_address", "Couldn't tell where this request came from.");
    const voter = voterId(salt, ip);
    const mutating = req.method !== "GET";
    if (mutating) {
      assertSameOrigin(req);
      if (!rateLimiter.allow(voter)) throw new HttpError(429, "slow_down", "Too many clicks — give it a few seconds.");
    }
    const body = req.method === "POST" ? await readJson(req) : undefined;
    return match.handler({ voter, body, params: match.params });
  }

  function findRoute(method, path) {
    let pathKnown = false;
    for (const [routeMethod, pattern, handler] of routes) {
      const found = pattern.exec(path);
      if (!found) continue;
      pathKnown = true;
      if (routeMethod === method) return { handler, params: found.slice(1) };
    }
    return pathKnown ? null : undefined;
  }

  function staticAsset(method, path) {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    const isPage = path === "/" || POLL_PAGE.test(path);
    const asset = assets.get(isPage ? "/index.html" : path);
    if (!asset) throw new HttpError(404, "not_found", "Nothing here.");
    return { status: 200, body: asset.body, type: asset.type, cache: asset.cache };
  }
}

function json(status, value) {
  return { status, body: Buffer.from(JSON.stringify(value)), type: "application/json; charset=utf-8", cache: "no-store" };
}

function errorResponse(error, log) {
  if (error instanceof HttpError || error instanceof PollError) {
    return json(error.status, { error: error.code, message: error.message });
  }
  if (error instanceof NameError) return json(400, { error: error.code, message: error.message });
  log(error);
  return json(500, { error: "server_error", message: "Something went wrong on our side. Try again." });
}

function send(req, res, { status, body, type, cache }) {
  const etag = status === 200 ? `"${createHash("sha1").update(body).digest("base64url")}"` : null;
  const headers = { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": cache };
  if (etag) headers.ETag = etag;
  if (etag && req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  headers["Content-Length"] = body.length;
  res.writeHead(status, headers).end(req.method === "HEAD" ? undefined : body);
}

/**
 * Cross-site pages cannot send JSON here without a CORS preflight we never answer, but browsers that
 * report the origin are also checked directly so a stray form post can never count.
 */
function assertSameOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "cross_site", "Votes can only come from the poll page itself.");
  }
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost !== req.headers.host) {
    throw new HttpError(403, "cross_site", "Votes can only come from the poll page itself.");
  }
}

async function readJson(req) {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "json_required", "Send JSON.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "That's too much text.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "That request wasn't valid JSON.");
  }
}

function loadAssets(publicDir) {
  const assets = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const urlPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, urlPath);
        continue;
      }
      const type = CONTENT_TYPES[extname(entry.name)];
      if (!type) continue;
      const cache = extname(entry.name) === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache";
      assets.set(urlPath, { body: readFileSync(full), type, cache });
    }
  };
  walk(publicDir, "");
  return assets;
}
