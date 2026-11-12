// Run: node --test test/imports.test.mjs
// Cache-busting hygiene: every module must be imported with ONE consistent ?v= tag everywhere, so a phone can never
// mix an old cached copy of a module with a new one. (This is what bit us once with Bluefy's cache.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../site', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/%20/g, ' '));
const walk = (d) => readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(ROOT);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) out.push(m[1]);
  return out;
}

test('IMPORTS: every relative import points at a file that exists', () => {
  let n = 0;
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    for (const spec of importsOf(f)) {
      const target = path.resolve(path.dirname(f), spec.replace(/\?.*$/, ''));
      assert.ok(existsSync(target), `${rel(f)} imports ${spec}, which does not exist`);
      n += 1;
    }
  }
  assert.ok(n > 40, `checked ${n} imports`);
});

test('IMPORTS: each module is imported with the same version tag by every importer', () => {
  const tags = new Map(); // target -> Map(tag -> [importers])
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    for (const spec of importsOf(f)) {
      const [file, query = ''] = spec.split('?');
      const target = rel(path.resolve(path.dirname(f), file));
      if (!tags.has(target)) tags.set(target, new Map());
      const m = tags.get(target);
      m.set(query, [...(m.get(query) ?? []), rel(f)]);
    }
  }
  for (const [target, variants] of tags) {
    assert.equal(variants.size, 1, `${target} is imported with different tags: ${JSON.stringify([...variants].map(([q, who]) => [q || '(none)', who]))}`);
  }
});

test('IMPORTS: the shared control and workout modules the pages rely on all carry a version tag', () => {
  const must = ['control/controller.js', 'control/protocol.js', 'control/bridge.js', 'control/confirm.js', 'workout/engine.js', 'workout/limits.js', 'ftms.js'];
  const seen = new Map();
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    for (const spec of importsOf(f)) {
      const [file, query = ''] = spec.split('?');
      seen.set(rel(path.resolve(path.dirname(f), file)), query);
    }
  }
  for (const m of must) assert.match(seen.get(m) ?? '', /^v=\w+$/, `${m} must be imported with a ?v= tag`);
});

test('IMPORTS: every page loads its entry script with a version tag, and the app stylesheet too', () => {
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) assert.match(m[1], /\?v=\w+$/, `${rel(f)}: ${m[1]}`);
    for (const m of html.matchAll(/<link[^>]+href="(\.\/[^"]+\.css[^"]*)"/g)) assert.match(m[1], /\?v=\w+$/, `${rel(f)}: ${m[1]}`);
  }
});
