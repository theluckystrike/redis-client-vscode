'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../src/html');
const pkg = require('../package.json');

test('webview CSP: default-src none, scripts by nonce, no remote origin', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 's.js', styleUri: 's.css', title: 't<', page: 'key', data: { a: '</script>' } });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[\w-]+'/);
  assert.match(csp, /img-src vscode-webview:\/\/x blob: data:/);
  assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(csp));
  assert.ok(!html.includes('</script>"'), 'data is escaped');
});

test('package.json: phrase-first name, engines, commands, no AI or USD 15', () => {
  assert.ok(pkg.displayName.startsWith('Redis Client & Redis GUI'));
  for (const p of ['Redis Client', 'Redis GUI', 'Redis Viewer']) assert.ok(pkg.displayName.includes(p), p);
  for (const k of ['redis', 'redis client', 'redis gui', 'redis viewer', 'valkey', 'keydb']) assert.ok(pkg.keywords.includes(k), k);
  assert.match(pkg.description, /Not affiliated with Redis Ltd/);
  assert.strictEqual(pkg.engines.vscode, '^1.90.0');
  assert.strictEqual(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length, 'everything is bundled');
  const ids = new Set(pkg.contributes.commands.map((c) => c.command));
  const src = fs.readdirSync(path.join(__dirname, '../src')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')).join('\n');
  for (const m of src.matchAll(/reg\('(redisClient\.\w+)'/g)) assert.ok(ids.has(m[1]), `${m[1]} in package.json`);
  for (const id of ['redisClient.enterLicenseKey', 'redisClient.getPro', 'redisClient.unlockWithSponsors', 'redisClient.payWithPayPal', 'redisClient.removeLicense', 'redisClient.supportDeveloper', 'redisClient.moreViewers']) assert.ok(ids.has(id), id);
  const all = JSON.stringify(pkg) + fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  assert.ok(!/USD 15|\$15/.test(all));
  assert.ok(!/Co-Authored-By|Generated with/i.test(all));
});

test('README first screen says free, no sign-in, and names the network rule', () => {
  const r = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const first = r.split('\n').slice(0, 8).join('\n');
  assert.match(first, /^# Redis Client & Redis GUI/);
  assert.match(first, /Free, no sign-in, no telemetry/);
  assert.match(first, /only to the Redis servers you add/);
  assert.match(r, /images\/screenshot-dark\.png/);
  assert.match(r, /not made by, affiliated with or endorsed by Redis Ltd/);
  assert.match(r, /Need your format supported\?/);
  assert.match(r, /tier_id=679995/);
});

test('nothing connects at activation: the session module loads lazily', () => {
  const ext = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  assert.ok(!/require\('\.\/redis\/session'\)/.test(ext.split('function activate')[0]));
  const conns = fs.readFileSync(path.join(__dirname, '../src/connections.js'), 'utf8');
  assert.match(conns, /const \{ RedisSession \} = require\('\.\/redis\/session'\); \/\/ loads ioredis only when a connection opens/);
});
