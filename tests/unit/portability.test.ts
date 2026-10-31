import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../..', import.meta.url).pathname;

function files(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, extensions);
    return extensions.some((ext) => path.endsWith(ext)) ? [path] : [];
  });
}

// Browsers and React Native have no Node built-ins; one stray import breaks Metro bundling.
const forbidden: [string, RegExp][] = [
  ['node: import', /from\s+['"]node:|import\(\s*['"]node:/],
  ['bare built-in import', /from\s+['"](fs|path|http|https|crypto|stream|buffer|url|util|os|net|tls|zlib|events)['"]/],
  ['require()', /\brequire\s*\(/],
  ['process', /\bprocess\./],
  ['Buffer', /\bBuffer\b/],
  ['React import', /from\s+['"]react(-native)?['"]/],
];

describe('portability', () => {
  const sources = [...files(join(root, 'src'), ['.ts']), ...files(join(root, 'dist'), ['.js'])];

  it('finds the sources', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it.each(forbidden)('has no %s in src or dist', (_label, pattern) => {
    const offenders = sources.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
  });
});
