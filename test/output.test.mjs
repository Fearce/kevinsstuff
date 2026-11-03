import test from 'node:test';
import assert from 'node:assert/strict';
import { win32, posix } from 'node:path';
import { buildDirectory } from '../scripts/lib/output.mjs';

test('output accepts the default dist and dedicated scratch on another Windows drive', () => {
  assert.equal(buildDirectory('C:\\repos\\kevinsstuff', 'dist', win32), 'C:\\repos\\kevinsstuff\\dist');
  assert.equal(buildDirectory('C:\\repos\\kevinsstuff', 'D:/agent-data/kevinsstuff/gui/dist', win32), 'D:\\agent-data\\kevinsstuff\\gui\\dist');
  assert.equal(buildDirectory('/srv/portfolio', '/var/tmp/portfolio-build', posix), '/var/tmp/portfolio-build');
});

test('output rejects source directories, repository roots, ancestors and drive roots', () => {
  for (const target of ['.', 'src', 'public', 'content', 'scripts', 'dist/nested', '..', 'C:/', 'D:/']) {
    assert.throws(() => buildDirectory('C:\\repos\\kevinsstuff', target, win32), /Build output/);
  }
  for (const target of ['.', 'src', '..', '/']) {
    assert.throws(() => buildDirectory('/srv/portfolio', target, posix), /Build output/);
  }
});
