'use strict';
// Integration tests against real servers. Run with ZOVO_REDIS_IT=1 after ~/redis-client-work/start.sh
// (single node 56379, ACL node 56380, TLS 56443, cluster 47001-47006, sentinel 56391-56393 for mymaster).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RedisSession } = require('../src/redis/session');
const pro = require('../src/pro');
const fmt = require('../src/core/exportfmt');

const IT = process.env.ZOVO_REDIS_IT === '1';
const W = path.join(os.homedir(), 'redis-client-work');
const cli = (port, ...args) => execFileSync('redis-cli', ['-p', String(port), ...args], { encoding: 'latin1' }).trim();
const single = (extra = {}) => new RedisSession({ name: 't', mode: 'standalone', host: '127.0.0.1', port: 56379, db: 9, ...extra }, {}, { connectTimeoutMs: 4000, maxReconnects: 3 });

test('integration', { skip: !IT && 'set ZOVO_REDIS_IT=1' }, async (t) => {
  cli(56379, '-n', '9', 'FLUSHDB');

  await t.test('precision gate: two keys that differ in one non-UTF-8 byte; editing one leaves the other', async () => {
    const s = single(); await s.connect();
    const k1 = Buffer.from([0x62, 0x69, 0x6e, 0x3a, 0xff, 0x01]);
    const k2 = Buffer.from([0x62, 0x69, 0x6e, 0x3a, 0xfe, 0x01]);
    await s.write(9, ['SET', k1, 'one']); await s.write(9, ['SET', k2, 'two']);
    const r = await s.scan(9, null, { pattern: 'bin:*' });
    assert.strictEqual(r.keys.length, 2);
    const mine = r.keys.find((k) => k.equals(k1));
    await s.setString(9, mine, Buffer.from([0x00, 0xc3, 0x28]));
    // check with redis-cli, outside the extension
    assert.strictEqual(execFileSync('sh', ['-c', `printf 'GET "bin:\\\\xff\\\\x01"\\n' | redis-cli -p 56379 -n 9 --no-raw`], { encoding: 'latin1' }).trim(), '"\\x00\\xc3("');
    assert.strictEqual(execFileSync('sh', ['-c', `printf 'GET "bin:\\\\xfe\\\\x01"\\n' | redis-cli -p 56379 -n 9 --no-raw`], { encoding: 'latin1' }).trim(), '"two"');
    // hash field with a binary name: only that field changes
    await s.write(9, ['HSET', 'h', Buffer.from([0xff]), 'a', Buffer.from([0xfe]), 'b']);
    await s.hset(9, Buffer.from('h'), Buffer.from([0xff]), Buffer.from('A'));
    const all = await s.call(9, ['HGETALL', 'h']);
    const m = new Map(); for (let i = 0; i < all.length; i += 2) m.set(all[i].toString('hex'), all[i + 1].toString());
    assert.deepStrictEqual(Object.fromEntries(m), { ff: 'A', fe: 'b' });
    await s.close();
  });

  await t.test('editors: hash, list (index check), set, zset, stream, TTL, rename', async () => {
    const s = single(); await s.connect();
    const K = (x) => Buffer.from(x);
    await s.write(9, ['RPUSH', 'l', 'a', 'b', 'c']);
    await s.lset(9, K('l'), 1, K('b'), K('B'));
    await assert.rejects(s.lset(9, K('l'), 1, K('b'), K('X')), /CHANGED/);
    await s.ldel(9, K('l'), 0, K('a'));
    assert.deepStrictEqual((await s.listPage(9, K('l'), 0, 10)).map(String), ['B', 'c']);
    await s.sadd(9, K('s'), K('m1')); await s.sreplace(9, K('s'), K('m1'), K('m2'));
    assert.deepStrictEqual((await s.setPage(9, K('s'))).rows.map(String), ['m2']);
    await s.zadd(9, K('z'), 2, K('x')); await s.zreplace(9, K('z'), K('x'), K('y'), 3);
    assert.deepStrictEqual((await s.zsetPage(9, K('z'))).map(([m, sc]) => `${m}=${sc}`), ['y=3']);
    const id = await s.xadd(9, K('st'), [[K('f'), K('v')]]);
    await s.write(9, ['XGROUP', 'CREATE', 'st', 'g1', '0']);
    await s.call(9, ['XREADGROUP', 'GROUP', 'g1', 'c1', 'COUNT', '1', 'STREAMS', 'st', '>'], { write: true });
    const g = await s.streamGroups(9, K('st'));
    assert.strictEqual(g[0].name, 'g1');
    assert.strictEqual(g[0].pendingList[0].id, id);
    assert.strictEqual((await s.streamPage(9, K('st')))[0][0], id);
    await s.expire(9, K('st'), 100);
    assert.ok((await s.keyInfo(9, K('st'))).pttl > 90000);
    await s.persist(9, K('st'));
    assert.strictEqual((await s.keyInfo(9, K('st'))).pttl, -1);
    await s.write(9, ['SET', 'other', '1']);
    assert.strictEqual(await s.rename(9, K('st'), K('other'), false), false);
    assert.strictEqual(await s.rename(9, K('st'), K('st2'), false), true);
    await s.setString(9, K('ttlkeep'), K('a')); await s.expire(9, K('ttlkeep'), 500);
    await s.setString(9, K('ttlkeep'), K('b'));
    assert.ok((await s.keyInfo(9, K('ttlkeep'))).pttl > 400000, 'SET keeps the TTL');
    await s.close();
  });

  await t.test('read-only connection refuses writes before the server', async () => {
    const s = single({ readOnly: true }); await s.connect();
    await assert.rejects(s.setString(9, Buffer.from('x'), Buffer.from('y')), /read-only/);
    await assert.rejects(s.call(9, ['FLUSHDB']), /read-only/);
    await assert.rejects(pro.bulkApply(s, 9, '*', 'delete'), /read-only/);
    assert.ok(Array.isArray(await s.call(9, ['SCAN', '0'])));
    await s.close();
  });

  await t.test('export then import gives the same bytes and TTLs', async () => {
    const s = single(); await s.connect();
    const out = [];
    let state = null;
    do { const r = await s.scan(9, state, {}); state = r.state; for (const k of r.keys) { const e = await s.readFull(9, k); if (e) out.push(fmt.entryLine(e)); } if (r.done) break; } while (true);
    const file = path.join(W, 'export-test.json');
    fs.writeFileSync(file, fmt.header({}) + out.join(',\n') + fmt.FOOTER);
    cli(56379, '-n', '10', 'FLUSHDB');
    const rl = require('readline').createInterface({ input: fs.createReadStream(file, 'utf8') });
    let n = 0;
    for await (const e of fmt.readEntries(rl)) { await s.importEntry(10, e, 'skip'); n++; }
    assert.strictEqual(n, out.length);
    assert.strictEqual(cli(56379, '-n', '10', 'DBSIZE'), cli(56379, '-n', '9', 'DBSIZE'));
    assert.strictEqual(execFileSync('sh', ['-c', `printf 'GET "bin:\\\\xff\\\\x01"\\n' | redis-cli -p 56379 -n 10 --no-raw`], { encoding: 'latin1' }).trim(), '"\\x00\\xc3("');
    assert.ok(Number(cli(56379, '-n', '10', 'TTL', 'ttlkeep')) > 400);
    assert.strictEqual(cli(56379, '-n', '10', 'XLEN', 'st2'), '1');
    fs.unlinkSync(file);
    cli(56379, '-n', '10', 'FLUSHDB');
    await s.close();
  });

  await t.test('Pro: memory analysis and bulk TTL / delete with dry run', async () => {
    const s = single(); await s.connect();
    for (let i = 0; i < 300; i++) await s.write(9, ['SET', `sess:${i}`, 'x'.repeat(100 + i)]);
    await s.write(9, ['SET', 'huge', 'y'.repeat(200000)]);
    const rep = await pro.analyzeMemory(s, 9, { limit: 100000 });
    assert.strictEqual(rep.biggest[0].text, 'huge');
    assert.strictEqual(rep.patterns.find((p) => p.pattern === 'sess:*').count, 300);
    const dry = await pro.bulkDryRun(s, 9, 'sess:*');
    assert.strictEqual(dry.count, 300);
    assert.strictEqual(cli(56379, '-n', '9', 'EXISTS', 'sess:1'), '1', 'dry run changes nothing');
    const ex = await pro.bulkApply(s, 9, 'sess:1*', 'expire', 1000);
    assert.ok(ex.changed >= 111);
    assert.ok(Number(cli(56379, '-n', '9', 'TTL', 'sess:150')) > 900);
    assert.strictEqual(cli(56379, '-n', '9', 'TTL', 'sess:20'), '-1');
    const del = await pro.bulkApply(s, 9, 'sess:*', 'delete');
    assert.strictEqual(del.changed, 300);
    assert.strictEqual(cli(56379, '-n', '9', 'EXISTS', 'sess:1'), '0');
    await s.close();
  });

  await t.test('cluster: scan all primaries, read and write routed keys', async () => {
    const s = new RedisSession({ name: 'c', mode: 'cluster', nodes: [{ host: '127.0.0.1', port: 47001 }] }, {}, { connectTimeoutMs: 4000 });
    await s.connect();
    for (let i = 0; i < 500; i++) await s.write(0, ['SET', `ck:${i}`, String(i)]);
    let keys = []; let state = null;
    do { const r = await s.scan(0, state, { pattern: 'ck:*', limit: 10000 }); keys = keys.concat(r.keys); state = r.state; if (r.done) break; } while (true);
    assert.strictEqual(new Set(keys.map(String)).size, 500);
    assert.strictEqual(String(await s.call(0, ['GET', 'ck:77'])), '77');
    const types = await s.types(0, keys.slice(0, 50));
    assert.ok(types.every((x) => x === 'string'));
    const rep = await pro.analyzeMemory(s, 0, { pattern: 'ck:*', limit: 1000 });
    assert.strictEqual(rep.sampled, 500);
    const del = await pro.bulkApply(s, 0, 'ck:*', 'delete');
    assert.strictEqual(del.changed, 500);
    assert.ok(s.nodeList().length === 6);
    await s.close();
  });

  await t.test('sentinel: connects to the primary named by the sentinels', async () => {
    const s = new RedisSession({ name: 's', mode: 'sentinel', sentinels: [{ host: '127.0.0.1', port: 56391 }, { host: '127.0.0.1', port: 56392 }], sentinelName: 'mymaster', db: 0 }, {}, { connectTimeoutMs: 4000 });
    await s.connect();
    await s.write(0, ['SET', 'sent:k', 'v']);
    assert.strictEqual(String(await s.call(0, ['GET', 'sent:k'])), 'v');
    assert.match(s.sentinelPrimary, /^127\.0\.0\.1:5638[12]$/);
    await s.close();
  });

  await t.test('hostile: wrong password, bad certificate, refused port, wrong sentinel name', async () => {
    const bad = new RedisSession({ name: 'b', mode: 'standalone', host: '127.0.0.1', port: 56380, user: 'app', db: 0 }, { password: 'wrong' }, { connectTimeoutMs: 3000 });
    await assert.rejects(bad.connect(), (e) => e.step === 'AUTH');
    const tlsBad = new RedisSession({ name: 'x', mode: 'standalone', host: '127.0.0.1', port: 56443, db: 0, tls: true, tlsServername: 'localhost' }, {}, { connectTimeoutMs: 3000, caText: fs.readFileSync(path.join(W, 'tls/other.crt'), 'utf8') });
    await assert.rejects(tlsBad.connect(), (e) => e.step === 'TLS' && /not signed by the CA file/.test(e.message));
    const tlsOk = new RedisSession({ name: 'x', mode: 'standalone', host: '127.0.0.1', port: 56443, db: 0, tls: true, tlsServername: 'localhost' }, {}, { connectTimeoutMs: 3000, caText: fs.readFileSync(path.join(W, 'tls/ca.crt'), 'utf8') });
    await tlsOk.connect(); await tlsOk.close();
    const refused = new RedisSession({ name: 'r', mode: 'standalone', host: '127.0.0.1', port: 56999, db: 0 }, {}, { connectTimeoutMs: 3000 });
    await assert.rejects(refused.connect(), (e) => e.step === 'TCP');
    const sn = new RedisSession({ name: 's', mode: 'sentinel', sentinels: [{ host: '127.0.0.1', port: 56391 }], sentinelName: 'nope', db: 0 }, {}, { connectTimeoutMs: 3000 });
    await assert.rejects(sn.connect(), (e) => e.step === 'SENTINEL' && /nope/.test(e.message));
    const notSentinel = new RedisSession({ name: 's', mode: 'sentinel', sentinels: [{ host: '127.0.0.1', port: 56379 }], sentinelName: 'mymaster', db: 0 }, {}, { connectTimeoutMs: 3000 });
    await assert.rejects(notSentinel.connect(), (e) => e.step === 'SENTINEL' && /not a sentinel/.test(e.message));
  });

  cli(56379, '-n', '9', 'FLUSHDB');
});
