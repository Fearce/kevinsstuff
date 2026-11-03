import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TrustedProxies } from "../src/client-ip.js";
import { loadSalt } from "../src/identity.js";
import { PollPassword } from "../src/poll-password.js";
import { RateLimiter } from "../src/rate-limit.js";
import { createPollServer } from "../src/server.js";
import { FIRST_POLL, PollStore } from "../src/store.js";

const PASSWORD = "test-guild-password";
const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const P = FIRST_POLL.id;
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
let dir;
let store;
let server;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "guildpolls-http-"));
  store = new PollStore(join(dir, "poll.sqlite"));
  // The test client connects from loopback, so loopback plays the edge proxy and the forwarded address
  // stands in for distinct real clients.
  const trustedProxies = new TrustedProxies(["127.0.0.1", "::1"]);
  await trustedProxies.refresh();
  server = createPollServer({
    store,
    salt: loadSalt(join(dir, "salt")),
    trustedProxies,
    rateLimiter: new RateLimiter({ limit: 1000, windowMs: 10_000 }),
    pollPassword: new PollPassword(PASSWORD),
    publicDir,
    release: RELEASE,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the health check reports the deployed commit", async () => {
  const response = await fetch(base + "/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, release: RELEASE });
});

function as(ip) {
  const call = async (method, path, body, extraHeaders = {}) => {
    const headers = { "X-Forwarded-For": ip, ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return {
    polls: () => call("GET", "/api/polls"),
    createPoll: (title, password = PASSWORD, headers) => call("POST", "/api/polls", { title, password }, headers),
    state: (poll = P) => call("GET", `/api/polls/${poll}`),
    add: (name, headers, poll = P) => call("POST", `/api/polls/${poll}/options`, { name }, headers),
    vote: (id, headers, poll = P) => call("PUT", `/api/polls/${poll}/options/${id}/vote`, undefined, headers),
    unvote: (id, poll = P) => call("DELETE", `/api/polls/${poll}/options/${id}/vote`),
    reset: (poll = P) => call("DELETE", `/api/polls/${poll}/votes`),
    raw: call,
  };
}

const find = (state, name) => state.options.find((option) => option.name === name);

test("full flow: add, vote, unvote, reset, as seen by two different clients", async () => {
  const alice = as("198.51.100.10");
  const bob = as("198.51.100.20");

  const added = await alice.add("  Ember   Court ");
  assert.equal(added.status, 201);
  const id = find(added.body, "Ember Court").id;

  assert.equal((await alice.vote(id)).status, 200);
  assert.equal((await alice.vote(id)).status, 200);
  let seenByBob = (await bob.state()).body;
  assert.equal(find(seenByBob, "Ember Court").votes, 1);
  assert.equal(find(seenByBob, "Ember Court").mine, false);
  assert.equal(find(seenByBob, "Ember Court").addedByYou, false);

  await bob.vote(id);
  const seenByAlice = (await alice.state()).body;
  assert.equal(find(seenByAlice, "Ember Court").votes, 2);
  assert.equal(find(seenByAlice, "Ember Court").mine, true);
  assert.equal(find(seenByAlice, "Ember Court").addedByYou, true);

  const unvoted = await alice.unvote(id);
  assert.equal(find(unvoted.body, "Ember Court").votes, 1);
  assert.equal(find(unvoted.body, "Ember Court").mine, false);

  await alice.vote(id);
  const reset = await alice.reset();
  assert.equal(reset.status, 200);
  assert.ok(reset.body.options.every((option) => !option.mine));
  seenByBob = (await bob.state()).body;
  assert.equal(find(seenByBob, "Ember Court").votes, 1);
  assert.equal(find(seenByBob, "Ember Court").mine, true);
});

test("creating a poll needs the guild password", async () => {
  const kim = as("198.51.100.11");
  const wrong = await kim.createPoll("Raid night?", "letmein");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, "bad_password");
  assert.equal((await kim.raw("POST", "/api/polls", { title: "No password" })).status, 401);

  const created = await kim.createPoll("  Raid   night? ");
  assert.equal(created.status, 201);
  assert.equal(created.body.poll.title, "Raid night?");
  const listed = (await as("198.51.100.12").polls()).body.polls;
  assert.ok(listed.some((poll) => poll.id === created.body.poll.id && poll.title === "Raid night?"));
  assert.ok(!listed.some((poll) => poll.title === "No password"));
});

test("password guessing is locked out per client after five misses", async () => {
  const mallory = as("198.51.100.13");
  for (let i = 0; i < 5; i += 1) assert.equal((await mallory.createPoll("Spam", `guess-${i}`)).status, 401);
  const locked = await mallory.createPoll("Spam", PASSWORD);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, "password_locked");
  assert.equal((await as("198.51.100.14").createPoll("Fine poll")).status, 201);
});

test("each poll keeps its own options, votes and allowance", async () => {
  const lee = as("198.51.100.15");
  const raid = (await lee.createPoll("Which night?")).body.poll.id;
  const tuesday = find((await lee.add("Tuesday", undefined, raid)).body, "Tuesday").id;
  await lee.vote(tuesday, undefined, raid);
  assert.equal((await lee.vote(tuesday)).status, 404);
  assert.ok(!find((await lee.state()).body, "Tuesday"));
  await lee.reset();
  assert.equal(find((await lee.state(raid)).body, "Tuesday").mine, true);
  assert.equal((await lee.state("does-not-exist")).status, 404);
});

test("the ten-option cap is per client address and enforced by the server", async () => {
  const carol = as("198.51.100.30");
  for (let i = 1; i <= 10; i += 1) assert.equal((await carol.add(`Carol idea ${i}`)).status, 201);
  const eleventh = await carol.add("Carol idea 11");
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.body.error, "option_limit");
  await carol.reset();
  assert.equal((await carol.add("Carol idea 11")).status, 429);
  assert.equal((await as("198.51.100.31").add("Carol idea 11")).status, 201);
});

test("duplicate names are rejected with 409 whatever their case or spacing", async () => {
  assert.equal((await as("198.51.100.40").add("Stone Wardens")).status, 201);
  const duplicate = await as("198.51.100.41").add("stone   WARDENS");
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "duplicate");
  assert.equal((await as("198.51.100.41").add("stonewardens")).status, 409);
});

test("invalid names return 400 and do not use up the allowance", async () => {
  const erin = as("198.51.100.50");
  assert.equal((await erin.add("   ")).status, 400);
  assert.equal((await erin.add("y".repeat(41))).status, 400);
  assert.equal((await erin.raw("POST", `/api/polls/${P}/options`, { name: 7 })).status, 400);
  assert.equal((await erin.state()).body.you.created, 0);
});

test("forwarding headers other than X-Forwarded-For cannot change who you are", async () => {
  const frank = as("198.51.100.60");
  const id = find((await frank.add("Frank's Pick")).body, "Frank's Pick").id;
  await frank.vote(id);
  const spoofed = await frank.raw("GET", `/api/polls/${P}`, undefined, {
    "X-Real-IP": "203.0.113.200",
    "CF-Connecting-IP": "203.0.113.201",
    "True-Client-IP": "203.0.113.202",
  });
  assert.equal(find(spoofed.body, "Frank's Pick").mine, true);
});

test("a forged X-Forwarded-For prefix does not create a new identity", async () => {
  const gina = as("198.51.100.70");
  const id = find((await gina.add("Gina's Pick")).body, "Gina's Pick").id;
  await gina.vote(id);
  const forged = await as("203.0.113.99, 198.51.100.70").state();
  assert.equal(find(forged.body, "Gina's Pick").mine, true);
  assert.equal(forged.body.you.created, 1);
});

test("user text is returned as data, never rendered server-side", async () => {
  const payload = "<script>alert(1)</script>";
  const created = await as("198.51.100.80").add(payload);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(find(created.body, payload));
  const poll = await as("198.51.100.80").createPoll(`<img src=x onerror=alert(1)>`);
  assert.equal(poll.status, 201);
  for (const path of ["/", `/p/${P}`, `/p/${poll.body.poll.id}`]) {
    const page = await fetch(base + path);
    const html = await page.text();
    assert.ok(!html.includes(payload) && !html.includes("onerror"), path);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  }
});

test("the client never builds markup from user text", () => {
  const app = readFileSync(join(publicDir, "app.js"), "utf8");
  const htmlSinks = app.match(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/g) ?? [];
  assert.equal(htmlSinks.length, 1, "only the constant check-mark SVG may use innerHTML");
  assert.match(app, /\.innerHTML = CHECK_SVG;/);
});

test("cross-site requests are refused", async () => {
  const ivy = as("198.51.100.90");
  const id = find((await ivy.add("Ivy's Pick")).body, "Ivy's Pick").id;
  assert.equal((await ivy.vote(id, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await ivy.vote(id, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await ivy.add("Sneaky", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await ivy.createPoll("Sneaky poll", PASSWORD, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await ivy.vote(id, { Origin: base })).status, 200);
});

test("POST bodies must be JSON", async () => {
  const response = await fetch(`${base}/api/polls/${P}/options`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "198.51.100.91" },
    body: "name=Form+Post",
  });
  assert.equal(response.status, 415);
});

test("unknown options are 404 and unknown routes are 404/405", async () => {
  const jo = as("198.51.100.92");
  assert.equal((await jo.vote(987654)).status, 404);
  assert.equal((await jo.raw("GET", "/api/nope")).status, 404);
  assert.equal((await jo.raw("PATCH", `/api/polls/${P}/votes`)).status, 405);
});

test("poll state supports conditional requests", async () => {
  const headers = { "X-Forwarded-For": "198.51.100.93" };
  const first = await fetch(`${base}/api/polls/${P}`, { headers });
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const second = await fetch(`${base}/api/polls/${P}`, { headers: { ...headers, "If-None-Match": etag } });
  assert.equal(second.status, 304);
});

test("serves the app shell for the home and poll pages, its assets and security headers", async () => {
  const cases = [["/", "text/html"], [`/p/${P}`, "text/html"], ["/app.js", "text/javascript"], ["/app.css", "text/css"], ["/fonts/fraunces.woff2", "font/woff2"]];
  for (const [path, type] of cases) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), new RegExp(type), path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await fetch(`${base}/../src/store.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/src/store.js`)).status, 404);
  assert.equal((await fetch(`${base}/p/Bad_Id!`)).status, 404);
});
