'use strict';
// One open connection: a single node, a cluster or a sentinel set, through ioredis (pure JavaScript).
// Every key and value is a Buffer; writes address keys by their exact bytes. A read-only connection
// refuses writes here, before anything reaches the server.

const Redis = require('ioredis');
const { probe } = require('../core/probe');
const { explain } = require('../core/errors');
const { readOnlyBlock } = require('../core/commands');
const { parseInfo, keyspace, infoValue } = require('../core/info');
const { toBuf } = require('../core/bytes');
const { ioredisOptions } = require('../core/config');

const s = (x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x === null || x === undefined ? '' : String(x));

function friendly(msg, extra = {}) { return Object.assign(new Error(msg), { friendly: true, ...extra }); }

/** Turn any error into one with a plain message (step + hint). */
function plain(err, cfg) {
  if (err && err.friendly) return err;
  const x = explain(err, cfg);
  return friendly(x.message + (x.hint ? ` ${x.hint}` : ''), { step: x.step, cause: err });
}

const LUA_LSET = "if redis.call('LINDEX', KEYS[1], ARGV[1]) == ARGV[2] then return redis.call('LSET', KEYS[1], ARGV[1], ARGV[3]) else return redis.error_reply('CHANGED the item at this index changed since it was loaded') end";
const LUA_LDEL = "if redis.call('LINDEX', KEYS[1], ARGV[1]) == ARGV[2] then redis.call('LSET', KEYS[1], ARGV[1], ARGV[3]); return redis.call('LREM', KEYS[1], 1, ARGV[3]) else return redis.error_reply('CHANGED the item at this index changed since it was loaded') end";

class RedisSession {
  /**
   * conn: saved connection; secrets: {password, sentinelPassword}
   * opts: {caText, connectTimeoutMs, onStatus(status, err), RedisImpl}
   */
  constructor(conn, secrets, opts = {}) {
    this.conn = conn;
    this.secrets = secrets || {};
    this.opts = opts;
    this.readOnly = !!conn.readOnly;
    this.mode = conn.mode || 'standalone';
    this.clients = new Map(); // db -> Redis (standalone, sentinel)
    this.main = null;
    this.status = 'idle';
    this.lastError = null;
    this.server = {};
    this.closed = false;
    this.R = opts.RedisImpl || Redis;
  }

  get label() { return this.conn.name; }

  setStatus(st, err) {
    if (this.status === st && !err) return;
    this.status = st;
    if (err) this.lastError = err;
    if (this.opts.onStatus) try { this.opts.onStatus(st, err); } catch { /* ignore */ }
  }

  endpoints() {
    const c = this.conn;
    if (this.mode === 'cluster') return c.nodes;
    if (this.mode === 'sentinel') return c.sentinels;
    return [{ host: c.host, port: c.port }];
  }

  /** DNS, TCP and TLS checks on the first endpoint that answers; throws the first failure if none does. */
  async preflight() {
    const ms = this.opts.connectTimeoutMs || 10000;
    let first = null;
    const tlsOn = !!this.conn.tls && !(this.mode === 'sentinel' && this.conn.sentinelTls === false);
    for (const ep of this.endpoints()) {
      try {
        const r = await probe({ host: ep.host, port: ep.port, tls: tlsOn, ca: this.opts.caText, rejectUnauthorized: this.conn.tlsInsecure !== true, servername: this.conn.tlsServername, timeoutMs: ms });
        if (this.mode === 'sentinel') await this.askSentinel(ep, tlsOn, ms);
        return r.steps;
      } catch (e) { if (!first) first = e; }
    }
    if (first && first.friendly) throw first;
    const x = explain(first, this.conn);
    throw friendly(x.message + (x.hint ? ` ${x.hint}` : ''), { step: x.step, cause: first });
  }

  /** Ask one sentinel for the primary, so a wrong name or sentinel password gets its own message. */
  async askSentinel(ep, tlsOn, ms) {
    const o = ioredisOptions(this.conn, this.secrets, { caText: this.opts.caText, connectTimeoutMs: ms });
    const c = new this.R({ host: ep.host, port: ep.port, username: this.conn.sentinelUser || undefined, password: this.secrets.sentinelPassword || undefined, tls: tlsOn ? o.sentinelTLS : undefined, lazyConnect: true, connectTimeout: ms, maxRetriesPerRequest: 0, retryStrategy: () => null, enableReadyCheck: false });
    c.on('error', () => {});
    try {
      await c.connect();
      const r = await c.call('SENTINEL', 'GET-MASTER-ADDR-BY-NAME', this.conn.sentinelName);
      if (!r) throw friendly(`Sentinel: ${ep.host}:${ep.port} answered, but it does not watch a primary named "${this.conn.sentinelName}". Check the name in sentinel.conf (sentinel monitor <name> ...).`, { step: 'SENTINEL' });
      this.sentinelPrimary = `${r[0]}:${r[1]}`;
    } catch (e) {
      if (e.friendly) throw e;
      if (/unknown command/i.test(e.message)) throw friendly(`Sentinel: ${ep.host}:${ep.port} is a Redis server, not a sentinel. Pick Single node, or use the sentinel port (often 26379).`, { step: 'SENTINEL' });
      if (/WRONGPASS|NOAUTH|invalid password/i.test(e.message)) throw friendly(`Sentinel AUTH: ${ep.host}:${ep.port} refused the sentinel password. The sentinel password can differ from the Redis password.`, { step: 'AUTH' });
      throw e;
    } finally { c.disconnect(); }
  }

  attach(client, isMain) {
    client.on('error', (e) => { if (isMain) this.setStatus(this.status === 'ready' ? 'reconnecting' : this.status, e); });
    client.on('reconnecting', () => { if (isMain) this.setStatus('reconnecting'); });
    client.on('ready', () => { if (isMain) { this.lastError = null; this.setStatus('ready'); } });
    client.on('end', () => { if (isMain && !this.closed) this.setStatus('closed', this.lastError || new Error('Connection is closed.')); });
    if (this.mode === 'cluster') client.on('node error', (e, addr) => { this.lastNodeError = { e, addr }; });
  }

  makeClient(db) {
    const extra = { caText: this.opts.caText, connectTimeoutMs: this.opts.connectTimeoutMs, maxReconnects: this.opts.maxReconnects };
    const o = ioredisOptions(this.conn, this.secrets, extra);
    if (this.mode === 'cluster') return new this.R.Cluster(o.nodes, { ...o.options, redisOptions: { ...o.options.redisOptions, commandTimeout: this.opts.commandTimeoutMs || 60000 } });
    return new this.R({ ...o, db: db === undefined ? o.db : db, commandTimeout: this.opts.commandTimeoutMs || 60000 });
  }

  /** Connect once: wait for ready, or stop at the first error with a message that names the step. */
  async open(client) {
    const ms = (this.opts.connectTimeoutMs || 10000) + (this.mode === 'sentinel' ? 5000 : 2000);
    let firstErr = null;
    const onErr = (e) => { if (!firstErr) firstErr = e; };
    client.on('error', onErr);
    try {
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(firstErr || Object.assign(new Error(`no answer within ${Math.round(ms / 1000)} s`), { code: 'ETIMEDOUT' })), ms);
        client.once('ready', () => { clearTimeout(t); res(); });
        client.connect().catch((e) => { clearTimeout(t); rej(firstErr && /Connection is closed|ClusterAllFailed|None of startup/.test(e.message) ? firstErr : e); });
        // AUTH and similar fail in an 'error' event while connect() waits for a retry: stop at once.
        client.on('error', (e) => { if (/WRONGPASS|NOAUTH|NOPERM|invalid password|sentinel|certificate|SSL|self-signed/i.test(e.message) || e.code && /CERT|TLS|SSL/.test(e.code)) { clearTimeout(t); rej(e); } });
      });
    } catch (e) {
      client.disconnect();
      throw plain(e, this.conn);
    } finally {
      client.removeListener('error', onErr);
    }
  }

  async connect() {
    this.setStatus('connecting');
    try {
      this.steps = await this.preflight();
      const c = this.makeClient();
      this.attach(c, true);
      await this.open(c);
      this.main = c;
      if (this.mode !== 'cluster') this.clients.set(this.conn.db || 0, c);
      await this.loadServerInfo().catch(() => {});
      this.setStatus('ready');
      return this;
    } catch (e) {
      this.setStatus('failed', e);
      throw e;
    }
  }

  async loadServerInfo() {
    const node = this.mode === 'cluster' ? this.main.nodes('master')[0] : this.main;
    const info = parseInfo(s(await node.callBuffer('INFO', ['server'])));
    this.server.version = infoValue(info, 'redis_version') || infoValue(info, 'valkey_version') || '';
    this.server.valkey = !!infoValue(info, 'valkey_version') || /valkey/i.test(infoValue(info, 'server_name') || '');
    this.server.mode = infoValue(info, 'redis_mode') || '';
    const major = Number((this.server.version || '0').split('.')[0]);
    this.server.major = major;
    try {
      const mods = await node.callBuffer('MODULE', ['LIST']);
      this.server.modules = (mods || []).map((m) => { for (let i = 0; i < m.length; i += 2) if (s(m[i]) === 'name') return s(m[i + 1]); return ''; }).filter(Boolean);
    } catch { this.server.modules = []; }
  }

  hasJson() { return (this.server.modules || []).some((m) => /^(rejson|ReJSON|json)$/i.test(m)); }

  /** The client of a database (standalone and sentinel get one client per database; a cluster has only db 0). */
  async db(db) {
    if (this.closed) throw friendly('This connection is closed. Refresh the connection to open it again.');
    if (!this.main) throw friendly('Not connected.');
    if (this.mode === 'cluster') {
      if (db) throw friendly('A cluster has only database 0.');
      return this.main;
    }
    const n = db === undefined || db === null ? (this.conn.db || 0) : Number(db);
    if (this.clients.has(n)) return this.clients.get(n);
    const c = this.makeClient(n);
    this.attach(c, false);
    await this.open(c);
    this.clients.set(n, c);
    return c;
  }

  /** Run a command; writes are refused on a read-only connection. argv: [name, ...args] (strings or Buffers). */
  async call(db, argv, opts = {}) {
    const name = s(argv[0]);
    if (this.readOnly && (opts.write || readOnlyBlock([name, ...argv.slice(1).map(s)]))) {
      throw friendly(`This connection is read-only, so ${name.toUpperCase()} did not run. Turn read-only off on the connection to change data.`, { readOnly: true });
    }
    const c = opts.client || (await this.db(db));
    try {
      return await c.callBuffer(name, argv.slice(1));
    } catch (e) {
      if (opts.raw) throw e;
      throw plain(e, this.conn);
    }
  }

  write(db, argv) { return this.call(db, argv, { write: true }); }

  // ---------- keys ----------

  /** Databases with keys (from INFO keyspace), plus the connection's own database. */
  async databases() {
    if (this.mode === 'cluster') {
      let keys = 0;
      for (const n of this.main.nodes('master')) {
        try { keys += Number(s(await n.callBuffer('DBSIZE', []))) || 0; } catch { /* node down */ }
      }
      return [{ db: 0, keys }];
    }
    const ks = keyspace(parseInfo(s(await this.call(undefined, ['INFO', 'keyspace']))));
    const mine = this.conn.db || 0;
    if (!ks.some((d) => d.db === mine)) ks.push({ db: mine, keys: 0, expires: 0 });
    return ks.sort((a, b) => a.db - b.db);
  }

  async dbsize(db) {
    if (this.mode === 'cluster') return (await this.databases())[0].keys;
    return Number(s(await this.call(db, ['DBSIZE'])));
  }

  /**
   * One page of SCAN. state: null to start, or the returned state to continue. Returns {keys, state, done, warnings}.
   * A cluster scans each primary in turn; a node that does not answer is reported and skipped.
   */
  async scan(db, state, { pattern = '*', type = '', count = 1000, limit = 10000, shouldStop } = {}) {
    const keys = [];
    const warnings = [];
    const args = (cursor) => {
      const a = [cursor, 'MATCH', toBuf(pattern), 'COUNT', String(count)];
      if (type && (this.server.major || 6) >= 6) a.push('TYPE', type);
      return a;
    };
    if (this.mode === 'cluster') {
      const st = state || { nodes: this.main.nodes('master').map((n) => `${n.options.host}:${n.options.port}`), idx: 0, cursor: '0' };
      while (st.idx < st.nodes.length && keys.length < limit) {
        const addr = st.nodes[st.idx];
        const node = this.main.nodes('master').find((n) => `${n.options.host}:${n.options.port}` === addr);
        if (!node) { warnings.push(`Node ${addr} is no longer a primary; its keys may show under another node after a refresh.`); st.idx++; st.cursor = '0'; continue; }
        try {
          const [next, batch] = await node.callBuffer('SCAN', args(st.cursor));
          for (const k of batch) keys.push(k);
          st.cursor = s(next);
          if (st.cursor === '0') { st.idx++; }
        } catch (e) {
          const x = explain(e, this.conn, { host: addr.split(':')[0], port: addr.split(':')[1] });
          warnings.push(`Node ${addr} did not answer during the scan (${x.message}). Its keys are missing from this list; Refresh scans again.`);
          st.idx++; st.cursor = '0';
        }
        if (shouldStop && shouldStop()) break;
      }
      return { keys, state: st, done: st.idx >= st.nodes.length, warnings };
    }
    const st = state || { cursor: '0', started: false };
    do {
      const [next, batch] = await this.call(db, ['SCAN', ...args(st.cursor)]);
      for (const k of batch) keys.push(k);
      st.cursor = s(next); st.started = true;
      if (shouldStop && shouldStop()) break;
    } while (st.cursor !== '0' && keys.length < limit);
    return { keys, state: st, done: st.cursor === '0', warnings };
  }

  /** TYPE for many keys at once (pipelined), as an array of type names ('none' for keys that are gone). */
  async types(db, keys) {
    if (!keys.length) return [];
    if (this.mode === 'cluster') {
      const out = [];
      for (let i = 0; i < keys.length; i += 200) {
        const part = await Promise.all(keys.slice(i, i + 200).map((k) => this.main.callBuffer('TYPE', [k]).then(s, () => '?')));
        out.push(...part);
      }
      return out;
    }
    const c = await this.db(db);
    const out = [];
    for (let i = 0; i < keys.length; i += 1000) {
      const p = c.pipeline();
      for (const k of keys.slice(i, i + 1000)) p.callBuffer('TYPE', [k]);
      const res = await p.exec();
      for (const [err, v] of res) out.push(err ? '?' : s(v));
    }
    return out;
  }

  async keyInfo(db, key) {
    const type = s(await this.call(db, ['TYPE', key]));
    if (type === 'none') return { type, exists: false };
    const pttl = Number(s(await this.call(db, ['PTTL', key])));
    const lenCmd = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' }[type];
    let size = null;
    if (lenCmd) size = Number(s(await this.call(db, [lenCmd, key])));
    else if (type === 'ReJSON-RL') { try { size = Number(s(await this.call(db, ['JSON.DEBUG', 'MEMORY', key]))); } catch { size = null; } }
    let encoding = '';
    try { encoding = s(await this.call(db, ['OBJECT', 'ENCODING', key])); } catch { /* ACL may deny */ }
    return { type, exists: true, pttl, size, encoding };
  }

  async memoryUsage(db, key, samples = 5) {
    const r = await this.call(db, ['MEMORY', 'USAGE', key, 'SAMPLES', String(samples)]);
    return r === null ? null : Number(s(r));
  }

  // ---------- values (read) ----------

  async getString(db, key, maxBytes) {
    const len = Number(s(await this.call(db, ['STRLEN', key])));
    if (len > maxBytes) return { tooLarge: true, len };
    const v = await this.call(db, ['GET', key]);
    return { value: v === null ? Buffer.alloc(0) : v, len };
  }

  async getRange(db, key, start, end) { return this.call(db, ['GETRANGE', key, String(start), String(end)]); }

  async hashPage(db, key, cursor = '0', count = 500, match = '') {
    const a = ['HSCAN', key, cursor];
    if (match) a.push('MATCH', toBuf(match));
    a.push('COUNT', String(count));
    const [next, flat] = await this.call(db, a);
    const rows = [];
    for (let i = 0; i < flat.length; i += 2) rows.push([flat[i], flat[i + 1]]);
    return { cursor: s(next), rows };
  }

  async setPage(db, key, cursor = '0', count = 500, match = '') {
    const a = ['SSCAN', key, cursor];
    if (match) a.push('MATCH', toBuf(match));
    a.push('COUNT', String(count));
    const [next, members] = await this.call(db, a);
    return { cursor: s(next), rows: members };
  }

  async listPage(db, key, start = 0, count = 200) {
    return this.call(db, ['LRANGE', key, String(start), String(start + count - 1)]);
  }

  async zsetPage(db, key, start = 0, count = 200, desc = false) {
    const flat = await this.call(db, [desc ? 'ZREVRANGE' : 'ZRANGE', key, String(start), String(start + count - 1), 'WITHSCORES']);
    const rows = [];
    for (let i = 0; i < flat.length; i += 2) rows.push([flat[i], s(flat[i + 1])]);
    return rows;
  }

  /** Stream entries, newest first. before: an id to continue below (exclusive), or '+' for the newest. */
  async streamPage(db, key, before = '+', count = 100) {
    const end = before === '+' ? '+' : `(${before}`;
    let res;
    try { res = await this.call(db, ['XREVRANGE', key, end, '-', 'COUNT', String(count)]); } catch (e) {
      if (before !== '+' && /Invalid stream ID/i.test(e.message)) res = (await this.call(db, ['XREVRANGE', key, before, '-', 'COUNT', String(count + 1)])).slice(1);
      else throw e;
    }
    return res.map(([id, flat]) => { const f = []; for (let i = 0; i < (flat || []).length; i += 2) f.push([flat[i], flat[i + 1]]); return [s(id), f]; });
  }

  async streamGroups(db, key) {
    const toObj = (arr) => { const o = {}; for (let i = 0; i < arr.length; i += 2) o[s(arr[i])] = Array.isArray(arr[i + 1]) ? arr[i + 1] : s(arr[i + 1]); return o; };
    const groups = (await this.call(db, ['XINFO', 'GROUPS', key])).map(toObj);
    for (const g of groups) {
      try { g.consumersList = (await this.call(db, ['XINFO', 'CONSUMERS', key, g.name])).map(toObj); } catch { g.consumersList = []; }
      try {
        const p = await this.call(db, ['XPENDING', key, g.name, '-', '+', '50']);
        g.pendingList = p.map(([id, consumer, idle, deliveries]) => ({ id: s(id), consumer: s(consumer), idle: Number(s(idle)), deliveries: Number(s(deliveries)) }));
      } catch { g.pendingList = []; }
    }
    return groups;
  }

  async jsonGet(db, key) { return this.call(db, ['JSON.GET', key]); }

  /** Whole value of a key for export: {type, ttl, value}. Collections are read in pages. */
  async readFull(db, key, maxBytes = 512 * 1024 * 1024) {
    const type = s(await this.call(db, ['TYPE', key]));
    if (type === 'none') return null;
    const pttl = Number(s(await this.call(db, ['PTTL', key])));
    const ttl = pttl > 0 ? pttl : -1;
    let value;
    if (type === 'string') {
      const r = await this.getString(db, key, maxBytes);
      if (r.tooLarge) throw friendly(`skipped: ${r.len} bytes is over the export limit`);
      value = r.value;
    } else if (type === 'hash') {
      const seen = new Map(); let cur = '0';
      do { const p = await this.hashPage(db, key, cur, 1000); for (const [f, v] of p.rows) seen.set(f.toString('base64'), [f, v]); cur = p.cursor; } while (cur !== '0');
      value = [...seen.values()];
    } else if (type === 'set') {
      const seen = new Map(); let cur = '0';
      do { const p = await this.setPage(db, key, cur, 1000); for (const m of p.rows) seen.set(m.toString('base64'), m); cur = p.cursor; } while (cur !== '0');
      value = [...seen.values()];
    } else if (type === 'list') {
      value = []; let i = 0;
      for (;;) { const p = await this.listPage(db, key, i, 1000); value.push(...p); i += p.length; if (p.length < 1000) break; }
    } else if (type === 'zset') {
      value = []; let i = 0;
      for (;;) { const p = await this.zsetPage(db, key, i, 1000); value.push(...p); i += p.length; if (p.length < 1000) break; }
    } else if (type === 'stream') {
      value = []; let start = '-';
      for (;;) {
        const res = await this.call(db, ['XRANGE', key, start, '+', 'COUNT', '1000']);
        const page = res.map(([id, flat]) => { const f = []; for (let i = 0; i < (flat || []).length; i += 2) f.push([flat[i], flat[i + 1]]); return [s(id), f]; });
        if (start !== '-' && page.length && page[0][0] === start) page.shift();
        value.push(...page);
        if (res.length < 1000) break;
        start = page.length ? page[page.length - 1][0] : res[res.length - 1][0].toString();
      }
    } else if (type === 'ReJSON-RL') {
      value = await this.jsonGet(db, key);
    } else throw friendly(`skipped: type ${type} cannot be exported`);
    return { key, type, ttl, value };
  }

  // ---------- values (write) ----------

  async setString(db, key, value) {
    try { return await this.write(db, ['SET', key, value, 'KEEPTTL']); } catch (e) {
      if (!/syntax error/i.test(e.message)) throw e;
      const pttl = Number(s(await this.call(db, ['PTTL', key])));
      await this.write(db, ['SET', key, value]);
      if (pttl > 0) await this.write(db, ['PEXPIRE', key, String(pttl)]);
      return 'OK';
    }
  }

  async hset(db, key, field, value) { return this.write(db, ['HSET', key, field, value]); }
  async hdel(db, key, field) { return this.write(db, ['HDEL', key, field]); }
  async hrename(db, key, oldField, newField, value) {
    const exists = Number(s(await this.call(db, ['HEXISTS', key, newField])));
    if (exists && !oldField.equals(newField)) throw friendly('A field with the new name exists already.');
    await this.write(db, ['HSET', key, newField, value]);
    if (!oldField.equals(newField)) await this.write(db, ['HDEL', key, oldField]);
  }

  async lset(db, key, index, oldValue, value) { return this.write(db, ['EVAL', LUA_LSET, '1', key, String(index), oldValue, value]); }
  async ldel(db, key, index, oldValue) {
    const tomb = Buffer.concat([Buffer.from('__zovo_deleted__'), require('crypto').randomBytes(12)]);
    return this.write(db, ['EVAL', LUA_LDEL, '1', key, String(index), oldValue, tomb]);
  }
  async lpush(db, key, value, tail = true) { return this.write(db, [tail ? 'RPUSH' : 'LPUSH', key, value]); }

  async sadd(db, key, member) { return this.write(db, ['SADD', key, member]); }
  async srem(db, key, member) { return this.write(db, ['SREM', key, member]); }
  async sreplace(db, key, oldM, newM) {
    if (oldM.equals(newM)) return 0;
    if (Number(s(await this.call(db, ['SISMEMBER', key, newM])))) throw friendly('The set has this member already.');
    await this.write(db, ['SADD', key, newM]);
    return this.write(db, ['SREM', key, oldM]);
  }

  async zadd(db, key, score, member) { return this.write(db, ['ZADD', key, String(score), member]); }
  async zrem(db, key, member) { return this.write(db, ['ZREM', key, member]); }
  async zreplace(db, key, oldM, newM, score) {
    if (!oldM.equals(newM) && s(await this.call(db, ['ZSCORE', key, newM]))) throw friendly('The sorted set has this member already.');
    await this.write(db, ['ZADD', key, String(score), newM]);
    if (!oldM.equals(newM)) await this.write(db, ['ZREM', key, oldM]);
  }

  async xadd(db, key, fields, id = '*') { return s(await this.write(db, ['XADD', key, id, ...fields.flat()])); }
  async xdel(db, key, id) { return this.write(db, ['XDEL', key, id]); }

  async jsonSet(db, key, text) {
    try { JSON.parse(text.toString('utf8')); } catch (e) { throw friendly(`The JSON is not valid: ${e.message}`); }
    return this.write(db, ['JSON.SET', key, '$', text]);
  }

  async del(db, key) {
    try { return Number(s(await this.write(db, ['UNLINK', key]))); } catch (e) {
      if (/unknown command/i.test(e.message)) return Number(s(await this.write(db, ['DEL', key])));
      throw e;
    }
  }

  async exists(db, key) { return Number(s(await this.call(db, ['EXISTS', key]))) > 0; }

  async rename(db, key, newKey, overwrite = false) {
    const r = await this.write(db, [overwrite ? 'RENAME' : 'RENAMENX', key, newKey]);
    return overwrite ? true : Number(s(r)) === 1;
  }

  async expire(db, key, seconds) { return Number(s(await this.write(db, ['EXPIRE', key, String(seconds)]))); }
  async persist(db, key) { return Number(s(await this.write(db, ['PERSIST', key]))); }

  /** Create a key of a type with a first value. fails when the key exists. */
  async create(db, type, key, a, b) {
    if (await this.exists(db, key)) throw friendly('A key with this name exists already.');
    switch (type) {
      case 'string': return this.write(db, ['SET', key, a, 'NX']);
      case 'hash': return this.write(db, ['HSET', key, a, b]);
      case 'list': return this.write(db, ['RPUSH', key, a]);
      case 'set': return this.write(db, ['SADD', key, a]);
      case 'zset': return this.write(db, ['ZADD', key, String(Number(b) || 0), a]);
      case 'stream': return this.write(db, ['XADD', key, '*', a, b]);
      case 'json': return this.jsonSet(db, key, a);
      default: throw friendly(`Unknown type ${type}.`);
    }
  }

  /** Write one imported entry. policy: 'skip' keeps an existing key, 'replace' overwrites it. Returns 'written' or 'skipped'. */
  async importEntry(db, e, policy = 'skip') {
    if (await this.exists(db, e.key)) {
      if (policy === 'skip') return 'skipped';
      await this.del(db, e.key);
    }
    const k = e.key;
    const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
    switch (e.type) {
      case 'string': await this.write(db, ['SET', k, e.value]); break;
      case 'hash': for (const c of chunk(e.value, 500)) await this.write(db, ['HSET', k, ...c.flat()]); break;
      case 'list': for (const c of chunk(e.value, 500)) await this.write(db, ['RPUSH', k, ...c]); break;
      case 'set': for (const c of chunk(e.value, 500)) await this.write(db, ['SADD', k, ...c]); break;
      case 'zset': for (const c of chunk(e.value, 500)) await this.write(db, ['ZADD', k, ...c.flatMap(([m, sc]) => [String(sc), m])]); break;
      case 'stream': for (const [id, fields] of e.value) await this.write(db, ['XADD', k, id, ...fields.flat()]); break;
      case 'json': await this.jsonSet(db, k, e.value); break;
      default: throw friendly(`Unknown type ${e.type}.`);
    }
    if (e.ttl > 0) await this.write(db, ['PEXPIRE', k, String(Math.round(e.ttl))]);
    return 'written';
  }

  // ---------- server ----------

  /** The nodes a server panel can pick from: the client itself, or every node of a cluster. */
  nodeList() {
    if (this.mode !== 'cluster') return [{ id: 'main', label: this.mode === 'sentinel' ? `primary of ${this.conn.sentinelName}` : `${this.conn.host}:${this.conn.port}` }];
    return this.main.nodes('all').map((n) => ({ id: `${n.options.host}:${n.options.port}`, label: `${n.options.host}:${n.options.port}` }));
  }

  nodeClient(id) {
    if (this.mode !== 'cluster' || !id || id === 'main') return this.mode === 'cluster' ? this.main.nodes('master')[0] : this.main;
    const n = this.main.nodes('all').find((x) => `${x.options.host}:${x.options.port}` === id);
    if (!n) throw friendly(`Node ${id} is not in the cluster any more.`);
    return n;
  }

  async serverSnapshot(nodeId) {
    const c = this.nodeClient(nodeId);
    const run = async (argv) => { try { return await c.callBuffer(argv[0], argv.slice(1)); } catch (e) { return e; } };
    const [info, slowlog, clients, cluster] = await Promise.all([
      run(['INFO', 'everything']).then((r) => (r instanceof Error ? run(['INFO']) : r)),
      run(['SLOWLOG', 'GET', '50']),
      run(['CLIENT', 'LIST']),
      this.mode === 'cluster' ? run(['CLUSTER', 'NODES']) : Promise.resolve(null),
    ]);
    let primary = null;
    if (this.mode === 'sentinel') {
      const st = this.main.stream;
      if (st && st.remoteAddress) primary = `${st.remoteAddress}:${st.remotePort}`;
    }
    return { info, slowlog, clients, cluster, primary };
  }

  /** A second connection for Pub/Sub or the console (its own SELECT, its own subscriptions). */
  async duplicate(db) {
    const c = this.mode === 'cluster' ? this.main.duplicate() : this.makeClient(db === undefined ? (this.conn.db || 0) : db);
    await this.open(c);
    c.on('error', () => {}); // reconnects on its own; commands report their own errors
    return c;
  }

  async close() {
    this.closed = true;
    const all = new Set([this.main, ...this.clients.values()].filter(Boolean));
    this.clients.clear();
    this.main = null;
    // quit() leaves the sentinel failover detector's sockets open (ioredis 5.11): disconnect() after it closes them
    await Promise.all([...all].map((c) => c.quit().catch(() => {}).then(() => c.disconnect())));
    this.status = 'closed'; // closed by the user: no "lost the connection" message
  }
}

module.exports = { RedisSession, plain, LUA_LSET, LUA_LDEL };
