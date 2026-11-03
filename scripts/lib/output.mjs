import path from 'node:path';

export function buildDirectory(root, requested, paths = path) {
  const output = paths.resolve(root, requested);
  const fromRoot = paths.relative(root, output);
  const toRoot = paths.relative(output, root);
  const insideRoot = fromRoot && !fromRoot.startsWith('..') && !paths.isAbsolute(fromRoot);
  const ancestor = toRoot && !toRoot.startsWith('..') && !paths.isAbsolute(toRoot);
  if (output === paths.parse(output).root || !fromRoot || ancestor || (insideRoot && fromRoot !== 'dist')) {
    throw new Error('Build output must be the repository dist directory or a dedicated directory outside the repository.');
  }
  return output;
}
