// Proves the public site serves this exact build: release.json names the commit, every built
// file comes back byte-identical over HTTPS, and www redirects to the apex.
//   node deploy/verify-live.mjs --origin https://kevinsstuff.com --commit <sha> --dist dist
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    origin: { type: 'string' },
    commit: { type: 'string' },
    dist: { type: 'string', default: 'dist' },
    www: { type: 'string' },
  },
});
if (!args.origin || !args.commit) {
  console.error('Usage: verify-live.mjs --origin <https://host> --commit <sha> [--dist dist] [--www <https://www.host>]');
  process.exit(2);
}
const origin = args.origin.replace(/\/$/, '');
const PARALLEL = 6;

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache', 'accept-encoding': 'gzip' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function waitForRelease() {
  for (let attempt = 1; ; attempt++) {
    try {
      const release = JSON.parse((await fetchBytes(`${origin}/release.json`)).toString('utf8'));
      if (release.commit === args.commit) return;
      if (attempt >= 12) throw new Error(`live release.json names ${release.commit}, expected ${args.commit}`);
    } catch (error) {
      if (attempt >= 12) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function builtFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function publicPath(file) {
  return '/' + relative(args.dist, file).split(sep).map(encodeURIComponent).join('/');
}

async function compare(file) {
  const path = publicPath(file);
  const [local, live] = await Promise.all([readFile(file), fetchBytes(origin + path)]);
  if (!local.equals(live)) throw new Error(`${path} differs: built ${local.length} bytes, served ${live.length}`);
  return local.length;
}

async function compareAll(files) {
  let bytes = 0;
  const queue = [...files];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let file; (file = queue.shift()); ) bytes += await compare(file);
  }));
  return bytes;
}

async function checkWwwRedirect() {
  const response = await fetch(`${args.www}/`, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (![301, 308].includes(response.status) || location !== `${origin}/`) {
    throw new Error(`${args.www}/ answered ${response.status} → ${location}, expected a permanent redirect to ${origin}/`);
  }
}

await waitForRelease();
const files = await builtFiles(args.dist);
const bytes = await compareAll(files);
if (args.www) await checkWwwRedirect();
console.log(`${origin} serves ${args.commit}: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB, byte-identical.`);
