import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContent } from './lib/content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]));
  return nested.flat().filter(file => /\.(mjs|js)$/.test(file));
}
const source = (await Promise.all(['src', 'scripts', 'test'].map(directory => files(resolve(root, directory))))).flat();
for (const file of source) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const content = await loadContent(root);
console.log(`Syntax valid in ${source.length} JavaScript files; content and media valid for ${content.projects.length} projects.`);
