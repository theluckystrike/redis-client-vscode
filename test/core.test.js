'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../src/core/bytes');
const cfg = require('../src/core/config');
const cmd = require('../src/core/commands');
const { explain } = require('../src/core/errors');
const { buildTree, children, folderPattern, escapeGlob } = require('../src/core/keytree');
const fmt = require('../src/core/exportfmt');
const { MemoryReport, patternOf, toMarkdown } = require('../src/core/memory');
const info = require('../src/core/info');

test('display and parseEscaped round-trip every byte', () => {
  const all = Buffer.from([...Array(256).keys()]);
  assert.ok(B.parseEscaped(B.display(all)).equals(all));
  const k1 = Buffer.from([0x75, 0x3a, 0xff, 0x01]);
  const k2 = Buffer.from([0x75, 0x3a, 0xfe, 0x01]);
  assert.notStrictEqual(B.display(k1), B.display(k2));
  assert.strictEqual(B.display(k1), 'u:\\xff\\x01');
  assert.ok(B.parseEscaped(B.display(k1)).equals(k1));
  assert.strictEqual(B.display(Buffer.from('user:1:ñame €')), 'user:1:ñame €');
  assert.strictEqual(B.display(Buffer.from('a\\b')), 'a\\\\b');
  assert.ok(B.parseEscaped(B.display(Buffer.from('a\\b\nc'))).equals(Buffer.from('a\\b\nc')));
  const mixed = Buffer.concat([Buffer.from('ключ:'), Buffer.from([0xc3]), Buffer.from('€')]);
  assert.ok(B.parseEscaped(B.display(mixed)).equals(mixed));
});

test('wire marks binary values and keeps exact bytes', () => {
  const w = B.wire(Buffer.from([0, 159, 146, 150]));
  assert.strictEqual(w.utf8, false);
  assert.ok(Buffer.from(w.b64, 'base64').equals(Buffer.from([0, 159, 146, 150])));
  assert.strictEqual(B.wire(Buffer.from('héllo')).text, 'héllo');
  assert.ok(B.parseHex('de ad BE ef').equals(Buffer.from('deadbeef', 'hex')));
  assert.throws(() => B.parseHex('abc'), /pairs/);
  assert.strictEqual(B.humanBytes(104857600), '100 MB');
});

test('parseUrl: redis, rediss, sentinel, cluster, valkey', () => {
  let r = cfg.parseUrl('redis://app:p%40ss@cache.local:6380/3');
  assert.deepStrictEqual([r.conn.mode, r.conn.host, r.conn.port, r.conn.db, r.conn.user, r.password, r.conn.tls], ['standalone', 'cache.local', 6380, 3, 'app', 'p@ss', false]);
  r = cfg.parseUrl('rediss://:secret@[::1]:6379');
  assert.deepStrictEqual([r.conn.host, r.conn.tls, r.password, r.conn.user], ['::1', true, 'secret', '']);
  r = cfg.parseUrl('redis+sentinel://s1:26379,s2:26380/mymaster/2');
  assert.deepStrictEqual([r.conn.mode, r.conn.sentinels.length, r.conn.sentinels[1].port, r.conn.sentinelName, r.conn.db], ['sentinel', 2, 26380, 'mymaster', 2]);
  r = cfg.parseUrl('redis://n1:7000,n2:7001');
  assert.strictEqual(r.conn.mode, 'cluster');
  assert.strictEqual(r.conn.nodes.length, 2);
  r = cfg.parseUrl('valkey://localhost');
  assert.deepStrictEqual([r.conn.host, r.conn.port], ['localhost', 6379]);
  assert.throws(() => cfg.parseUrl('http://x'), /Unknown scheme/);
  assert.throws(() => cfg.parseUrl('localhost:6379'), /starts with redis/);
  assert.throws(() => cfg.parseUrl('redis://h/abc'), /database number/);
});

test('validate and toUrl never include the password', () => {
  const c = cfg.validate({ mode: 'standalone', host: 'h', port: '6380', db: '2', user: 'u', password: 'x' });
  assert.strictEqual(cfg.toUrl(c), 'redis://u@h:6380/2');
  assert.throws(() => cfg.validate({ mode: 'cluster', nodes: '' }), /at least one/);
  assert.throws(() => cfg.validate({ mode: 'sentinel', sentinels: 'a:1', sentinelName: '' }), /primary/);
  assert.throws(() => cfg.validate({ mode: 'standalone', port: 70000 }), /port/);
  const o = cfg.ioredisOptions({ mode: 'sentinel', sentinels: [{ host: 'a', port: 1 }], sentinelName: 'm', db: 1, tls: true }, { password: 'p', sentinelPassword: 'sp' }, { caText: 'CA' });
  assert.deepStrictEqual([o.name, o.password, o.sentinelPassword, o.tls.ca, o.lazyConnect, o.db], ['m', 'p', 'sp', 'CA', true, 1]);
  const oc = cfg.ioredisOptions({ mode: 'cluster', nodes: [{ host: 'a', port: 7000 }] }, { password: 'p' });
  assert.strictEqual(oc.options.redisOptions.password, 'p');
  assert.strictEqual(oc.nodes[0].port, 7000);
});

test('console parsing like redis-cli', () => {
  const a = cmd.parseLine('SET "a b" \'c d\' "\\xff\\x00z" plain');
  assert.deepStrictEqual(a.map((x) => x.toString('latin1')), ['SET', 'a b', 'c d', '\xff\x00z', 'plain']);
  assert.throws(() => cmd.parseLine('GET "x'), /not closed/);
  assert.strictEqual(cmd.formatReply([Buffer.from('a'), 3, null, [Buffer.from('x')]]), '1) "a"\n2) (integer) 3\n3) (nil)\n4) 1) "x"');
  assert.strictEqual(cmd.formatTop('set', Buffer.from('OK')), 'OK');
  assert.strictEqual(cmd.formatReply([]), '(empty array)');
});

test('read-only rule and dangerous commands', () => {
  assert.strictEqual(cmd.readOnlyBlock(['get', 'k']), null);
  assert.strictEqual(cmd.readOnlyBlock(['scan', '0']), null);
  assert.strictEqual(cmd.readOnlyBlock(['info']), null);
  assert.strictEqual(cmd.readOnlyBlock(['config', 'get', 'maxmemory']), null);
  assert.strictEqual(cmd.readOnlyBlock(['json.get', 'k']), null);
  for (const w of [['set', 'k', 'v'], ['del', 'k'], ['flushall'], ['config', 'set', 'x', 'y'], ['eval', 's', '0'], ['json.set', 'k', '$', '1'], ['shutdown'], ['client', 'kill', 'x']]) assert.ok(cmd.readOnlyBlock(w), w.join(' '));
  for (const d of [['flushall'], ['FLUSHDB'], ['keys', '*'], ['debug', 'sleep', '0'], ['shutdown']]) assert.ok(cmd.dangerous(d.map((x) => x.toLowerCase())), d.join(' '));
  assert.strictEqual(cmd.dangerous(['get', 'k']), null);
  assert.ok(cmd.unsupported(['subscribe']));
  assert.ok(cmd.complete('hs').includes('hset'));
  assert.ok(cmd.names().length > 200);
});

test('errors name the step', () => {
  assert.strictEqual(explain({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' }, { host: 'x', port: 1 }).step, 'DNS');
  assert.strictEqual(explain({ code: 'ECONNREFUSED', message: '' }, { host: 'h', port: 1 }).step, 'TCP');
  assert.strictEqual(explain(new Error('WRONGPASS invalid username-password pair'), { host: 'h', port: 1 }).step, 'AUTH');
  assert.strictEqual(explain(new Error('NOAUTH Authentication required.'), { host: 'h', port: 1 }).step, 'AUTH');
  assert.strictEqual(explain({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed certificate in certificate chain' }, { host: 'h', port: 1 }).step, 'TLS');
  assert.match(explain({ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed' }, null, { host: 'h', port: 1, caGiven: true }).message, /not signed by the CA file/);
  assert.strictEqual(explain(new Error('All sentinels are unreachable. Retrying'), { mode: 'sentinel', sentinels: [{ host: 'a', port: 1 }] }).step, 'SENTINEL');
  assert.strictEqual(explain(new Error('Failed to refresh slots cache.'), { mode: 'cluster' }).step, 'CLUSTER');
  for (const m of ['WRONGTYPE Operation', 'ERR unknown command', 'OOM command not allowed', 'READONLY You can']) assert.notStrictEqual(explain(new Error(m), {}).message, '');
  assert.ok(!/Something was wrong/i.test(JSON.stringify(explain(new Error('weird'), {}))));
});

test('key tree groups by separator and keeps bytes', () => {
  const keys = ['user:1:name', 'user:1:mail', 'user:2:name', 'session:abc', 'plain', 'user:10:name'].map((x) => Buffer.from(x));
  keys.push(Buffer.from([0x75, 0x73, 0x65, 0x72, 0x3a, 0xff]));
  const root = buildTree(keys, ':');
  assert.strictEqual(root.count, 7);
  const c = children(root);
  assert.deepStrictEqual(c.folders.map((f) => f.name), ['session', 'user']);
  assert.deepStrictEqual(c.keys.map((k) => k.label), ['plain']);
  const user = root.folders.get('user');
  assert.strictEqual(user.count, 5);
  assert.deepStrictEqual(children(user).folders.map((f) => f.name), ['1', '2', '10']);
  assert.ok(children(user).keys[0].buf.equals(Buffer.from([0x75, 0x73, 0x65, 0x72, 0x3a, 0xff])));
  assert.strictEqual(folderPattern('a*b:'), 'a\\*b:*');
  assert.ok(escapeGlob(Buffer.from('a?[x]')).equals(Buffer.from('a\\?\\[x\\]')));
  const flat = buildTree(keys, '');
  assert.strictEqual(children(flat).keys.length, 7);
});

test('export format is binary safe and streams', async () => {
  const entries = [
    { key: Buffer.from([1, 2, 0xff]), type: 'string', ttl: 5000, value: Buffer.from([0, 0xfe]) },
    { key: Buffer.from('h'), type: 'hash', ttl: -1, value: [[Buffer.from('f'), Buffer.from('v')]] },
    { key: Buffer.from('z'), type: 'zset', ttl: -1, value: [[Buffer.from('m'), '1.5']] },
    { key: Buffer.from('s'), type: 'stream', ttl: -1, value: [['1-0', [[Buffer.from('a'), Buffer.from('b')]]]] },
    { key: Buffer.from('l'), type: 'list', ttl: -1, value: [Buffer.from('x'), Buffer.from([0x80])] },
  ];
  const text = fmt.header({ source: 't' }) + entries.map(fmt.entryLine).join(',\n') + fmt.FOOTER;
  JSON.parse(text);
  async function* lines() { for (const l of text.split('\n')) yield l; }
  const back = [];
  for await (const e of fmt.readEntries(lines())) back.push(e);
  assert.strictEqual(back.length, 5);
  assert.ok(back[0].key.equals(entries[0].key));
  assert.ok(back[0].value.equals(entries[0].value));
  assert.strictEqual(back[0].ttl, 5000);
  assert.strictEqual(back[2].value[0][1], 1.5);
  assert.ok(back[4].value[1].equals(Buffer.from([0x80])));
  async function* other() { yield '{"keys": ['; yield '{"key":"a","type":"string","value":"b"}'; yield ']}'; }
  const o = []; for await (const e of fmt.readEntries(other())) o.push(e);
  assert.strictEqual(o[0].value.toString(), 'b');
});

test('memory report: patterns, biggest keys, extrapolation', () => {
  assert.strictEqual(patternOf('user:12345:profile'), 'user:*:profile');
  assert.strictEqual(patternOf('sess:3f2a9c1e-1b2c-4d3e-8f9a-0b1c2d3e4f5a'), 'sess:*');
  assert.strictEqual(patternOf('cache:home'), 'cache:home');
  const r = new MemoryReport(':', 3);
  for (let i = 0; i < 10; i++) r.add(Buffer.from(`user:${i}`), 'hash', 100 + i);
  r.add(Buffer.from('big'), 'string', 5000);
  r.add(Buffer.from('gone'), 'string', null);
  const out = r.result(24);
  assert.strictEqual(out.sampled, 11);
  assert.strictEqual(out.missing, 1);
  assert.strictEqual(out.biggest[0].text, 'big');
  assert.strictEqual(out.biggest.length, 3);
  assert.strictEqual(out.patterns.find((p) => p.pattern === 'user:*').count, 10);
  assert.ok(out.estimatedBytes > out.bytes);
  assert.match(toMarkdown(out, 't', B.humanBytes), /user:\*/);
});

test('INFO, slowlog, client list and cluster nodes parsers', () => {
  const s = info.parseInfo('# Server\r\nredis_version:7.2.4\r\n\r\n# Keyspace\r\ndb0:keys=10,expires=2,avg_ttl=0\r\ndb3:keys=1,expires=0,avg_ttl=0\r\n');
  assert.strictEqual(info.infoValue(s, 'redis_version'), '7.2.4');
  assert.deepStrictEqual(info.keyspace(s).map((d) => [d.db, d.keys]), [[0, 10], [3, 1]]);
  const sl = info.parseSlowlog([[Buffer.from('1'), Buffer.from('1700000000'), Buffer.from('15000'), [Buffer.from('KEYS'), Buffer.from('*')], Buffer.from('127.0.0.1:5'), Buffer.from('')]]);
  assert.strictEqual(sl[0].args.join(' '), 'KEYS *');
  assert.strictEqual(info.parseClients('id=3 addr=127.0.0.1:5 name= age=10 idle=0 db=0 cmd=client|list\n')[0].cmd, 'client|list');
  const n = info.parseClusterNodes('abc 127.0.0.1:7000@17000 myself,master - 0 0 1 connected 0-5460\n');
  assert.deepStrictEqual([n[0].port, n[0].slots, n[0].flags.includes('master')], [7000, '0-5460', true]);
});
