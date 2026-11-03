import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Strips the IPv4-mapped prefix and zone id so the same client always produces the same string. */
export function normalizeIp(address) {
  if (typeof address !== "string") return null;
  let ip = address.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return isIP(ip) ? ip.toLowerCase() : null;
}

/**
 * The identity a vote is keyed on. IPv4 is the full address; IPv6 is its /64 network, because one
 * home connection is handed a whole /64 and could otherwise rotate addresses to vote again.
 */
export function voterAddress(ip) {
  if (isIP(ip) !== 6) return ip;
  return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
}

function expandIpv6(ip) {
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (right.length && right.at(-1).includes(".")) right.splice(-1, 1, ...ipv4ToHextets(right.at(-1)));
  if (left.length && left.at(-1).includes(".")) left.splice(-1, 1, ...ipv4ToHextets(left.at(-1)));
  const fill = ip.includes("::") ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...fill, ...right].map((part) => parseInt(part, 16).toString(16));
}

function ipv4ToHextets(v4) {
  const [a, b, c, d] = v4.split(".").map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/**
 * Decides which addresses may speak for a client through X-Forwarded-For. Entries are IP addresses,
 * CIDR ranges or hostnames; hostnames (a proxy's container name) are re-resolved periodically because
 * a container's address changes when it is recreated.
 */
export class TrustedProxies {
  #entries;
  #resolve;
  #list = new BlockList();
  #lastResolved = new Map();
  #timer = null;

  constructor(entries, { resolve = defaultResolve } = {}) {
    this.#entries = entries.map((entry) => entry.trim()).filter(Boolean);
    this.#resolve = resolve;
  }

  get configured() {
    return this.#entries.length > 0;
  }

  async refresh() {
    const list = new BlockList();
    for (const entry of this.#entries) await this.#add(list, entry);
    this.#list = list;
  }

  startRefreshing(intervalMs) {
    this.#timer = setInterval(() => this.refresh().catch(() => {}), intervalMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  has(ip) {
    const family = isIP(ip);
    if (!family) return false;
    return this.#list.check(ip, family === 6 ? "ipv6" : "ipv4");
  }

  async #add(list, entry) {
    const slash = entry.indexOf("/");
    if (slash !== -1) {
      const network = normalizeIp(entry.slice(0, slash));
      const prefix = Number(entry.slice(slash + 1));
      if (!network || !Number.isInteger(prefix)) throw new Error(`Invalid trusted proxy range: ${entry}`);
      list.addSubnet(network, prefix, isIP(network) === 6 ? "ipv6" : "ipv4");
      return;
    }
    const literal = normalizeIp(entry);
    const addresses = literal ? [literal] : await this.#lookupOrKeep(entry);
    for (const address of addresses) list.addAddress(address, isIP(address) === 6 ? "ipv6" : "ipv4");
  }

  async #lookupOrKeep(hostname) {
    try {
      const found = await this.#resolve(hostname);
      const addresses = found.map(normalizeIp).filter(Boolean);
      this.#lastResolved.set(hostname, addresses);
      return addresses;
    } catch {
      return this.#lastResolved.get(hostname) ?? [];
    }
  }
}

async function defaultResolve(hostname) {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * The real client address. X-Forwarded-For is read only when the TCP peer is a trusted proxy, and
 * only from the right: the rightmost entry is the one our proxy appended; anything left of it came
 * from the client and may be forged. X-Real-IP and CF-Connecting-IP are never read, because the edge
 * Caddy forwards them from the client untouched and no Cloudflare hop sits in front of it.
 */
export function clientIp(req, trustedProxies) {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!peer || !trustedProxies.has(peer)) return peer;
  const forwarded = forwardedChain(req.headers["x-forwarded-for"]);
  for (let i = forwarded.length - 1; i >= 0; i -= 1) {
    const hop = normalizeIp(forwarded[i]);
    if (!hop) return peer;
    if (!trustedProxies.has(hop)) return hop;
  }
  return peer;
}

function forwardedChain(header) {
  if (!header) return [];
  const joined = Array.isArray(header) ? header.join(",") : header;
  return joined.split(",").map((part) => part.trim()).filter(Boolean);
}
