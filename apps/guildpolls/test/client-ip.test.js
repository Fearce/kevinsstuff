import { test } from "node:test";
import assert from "node:assert/strict";
import { TrustedProxies, clientIp, normalizeIp, voterAddress } from "../src/client-ip.js";

function request(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

async function proxies(entries, resolve) {
  const trusted = new TrustedProxies(entries, resolve ? { resolve } : undefined);
  await trusted.refresh();
  return trusted;
}

test("without trusted proxies the TCP peer is the client and every forwarding header is ignored", async () => {
  const trusted = await proxies([]);
  const req = request("203.0.113.9", {
    "x-forwarded-for": "198.51.100.1",
    "x-real-ip": "198.51.100.2",
    "cf-connecting-ip": "198.51.100.3",
  });
  assert.equal(clientIp(req, trusted), "203.0.113.9");
});

test("an untrusted peer cannot claim another address through X-Forwarded-For", async () => {
  const trusted = await proxies(["172.18.0.4"]);
  const req = request("172.18.0.99", { "x-forwarded-for": "198.51.100.1" });
  assert.equal(clientIp(req, trusted), "172.18.0.99");
});

test("behind the trusted proxy, the address it appended (the rightmost) wins over forged entries", async () => {
  const trusted = await proxies(["172.18.0.4"]);
  const req = request("::ffff:172.18.0.4", { "x-forwarded-for": "6.6.6.6, 1.2.3.4, 203.0.113.50" });
  assert.equal(clientIp(req, trusted), "203.0.113.50");
});

test("X-Real-IP and CF-Connecting-IP are never trusted, even from the proxy", async () => {
  const trusted = await proxies(["172.18.0.4"]);
  const req = request("172.18.0.4", {
    "x-forwarded-for": "203.0.113.50",
    "x-real-ip": "6.6.6.6",
    "cf-connecting-ip": "7.7.7.7",
  });
  assert.equal(clientIp(req, trusted), "203.0.113.50");
});

test("a trusted proxy without X-Forwarded-For, or with garbage in it, is treated as the client", async () => {
  const trusted = await proxies(["172.18.0.4"]);
  assert.equal(clientIp(request("172.18.0.4"), trusted), "172.18.0.4");
  assert.equal(clientIp(request("172.18.0.4", { "x-forwarded-for": "not-an-ip" }), trusted), "172.18.0.4");
});

test("chained trusted proxies are skipped from the right", async () => {
  const trusted = await proxies(["10.0.0.0/8"]);
  const req = request("10.0.0.2", { "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.1" });
  assert.equal(clientIp(req, trusted), "203.0.113.7");
});

test("hostnames are resolved and re-resolved, keeping the last answer when a lookup fails", async () => {
  let answer = ["172.18.0.4"];
  const trusted = await proxies(["sprogbroen-caddy"], async () => {
    if (answer === null) throw new Error("ENOTFOUND");
    return answer;
  });
  assert.ok(trusted.has("172.18.0.4"));
  answer = ["172.18.0.9"];
  await trusted.refresh();
  assert.ok(trusted.has("172.18.0.9"));
  assert.ok(!trusted.has("172.18.0.4"));
  answer = null;
  await trusted.refresh();
  assert.ok(trusted.has("172.18.0.9"));
});

test("normalizes IPv4-mapped and bracketed addresses", () => {
  assert.equal(normalizeIp("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(normalizeIp("[2001:DB8::1]"), "2001:db8::1");
  assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
  assert.equal(normalizeIp("nope"), null);
});

test("IPv6 voters are grouped by /64, IPv4 voters by full address", () => {
  assert.equal(voterAddress("203.0.113.5"), "203.0.113.5");
  assert.equal(voterAddress("2001:db8:aa:bb::1"), "2001:db8:aa:bb::/64");
  assert.equal(voterAddress("2001:db8:aa:bb:ffff:1:2:3"), "2001:db8:aa:bb::/64");
  assert.equal(voterAddress("2001:db8::1"), "2001:db8:0:0::/64");
  assert.notEqual(voterAddress("2001:db8:aa:bc::1"), voterAddress("2001:db8:aa:bb::1"));
});
