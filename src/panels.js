'use strict';
// Webview panels (host side): connection form, key editor, console, server info, pub/sub, memory report.
// Pages talk to the host by a small RPC: {rpc, method, params} -> {rpc, ok, result | error}.

const fs = require('fs');
const { buildHtml } = require('./html');
const { commandUris } = require('./support');
const B = require('./core/bytes');
const { parseLine, formatTop, dangerous, unsupported, names, readOnlyBlock } = require('./core/commands');
const { parseInfo, parseSlowlog, parseClients, parseClusterNodes, keyspace } = require('./core/info');
const { parseUrl, validate, nodesText } = require('./core/config');

const s = (x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x === null || x === undefined ? '' : String(x));
const friendly = (msg, extra = {}) => Object.assign(new Error(msg), { friendly: true, ...extra });

/** {enc: 'text'|'hex'|'b64'|'esc', v} from a page -> Buffer */
function decodeIn(x) {
  if (!x || typeof x !== 'object') throw friendly('Missing value.');
  const v = String(x.v ?? '');
  if (x.enc === 'hex') return B.parseHex(v);
  if (x.enc === 'b64') return Buffer.from(v, 'base64');
  if (x.enc === 'esc') return B.parseEscaped(v);
  return Buffer.from(v, 'utf8');
}

const CELL_MAX = 1 << 20; // a cell larger than 1 MB is shown cut and is not edited inline
function cell(buf) {
  buf = B.toBuf(buf);
  if (buf.length > CELL_MAX) return { len: buf.length, big: true, utf8: B.isUtf8(buf.subarray(0, 4096)), text: B.display(buf, 2048) };
  return B.wire(buf);
}

function createPanel(deps, { viewType, title, page, data, onRpc, onDispose, retain, column }) {
  const { vscode, context } = deps;
  const panel = vscode.window.createWebviewPanel(viewType, title, column || vscode.ViewColumn.Active, {
    enableScripts: true, retainContextWhenHidden: !!retain, enableCommandUris: commandUris('redisClient'),
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'redis.svg');
  panel.webview.html = buildHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
    title, page, data, showSupportLinks: deps.settings().showSupportLinks,
  });
  const post = (m) => panel.webview.postMessage(m).then(undefined, () => false);
  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || !m.rpc) return;
    try {
      const result = await onRpc(m.method, m.params || {});
      post({ rpc: m.rpc, ok: true, result });
    } catch (e) {
      post({ rpc: m.rpc, ok: false, error: e && e.message ? e.message : String(e), readOnly: !!(e && e.readOnly), cancelled: !!(e && e.cancelled) });
    }
  });
  panel.onDidDispose(() => { if (onDispose) onDispose(); });
  return { panel, post };
}

async function confirm(vscode, message, detail, button) {
  const r = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
  if (r !== button) throw friendly('Cancelled.', { cancelled: true });
}

// ---------- connection form ----------

function openForm(deps, existing) {
  const { vscode, store, sessions, tree } = deps;
  const title = existing ? `Edit ${existing.name}` : 'New Redis Connection';
  const { panel } = createPanel(deps, {
    viewType: 'redisClient.form', title, page: 'form', retain: true,
    data: { conn: existing || null, hasPassword: false },
    onRpc: async (method, p) => {
      if (method === 'init') {
        const sec = existing ? await store.secrets(existing.id) : { password: '', sentinelPassword: '' };
        return { conn: existing ? { ...existing, nodes: nodesText(existing.nodes), sentinels: nodesText(existing.sentinels) } : null, hasPassword: !!sec.password, hasSentinelPassword: !!sec.sentinelPassword };
      }
      if (method === 'parseUrl') {
        const r = parseUrl(p.url);
        return { conn: { ...r.conn, nodes: nodesText(r.conn.nodes), sentinels: nodesText(r.conn.sentinels) }, password: r.password };
      }
      if (method === 'browseCa') {
        const f = await vscode.window.showOpenDialog({ title: 'CA certificate (PEM)', canSelectMany: false, filters: { 'Certificates': ['pem', 'crt', 'cer', 'ca'], 'All files': ['*'] } });
        return f && f[0] ? f[0].fsPath : '';
      }
      const conn = validate(p.conn || {});
      const secrets = existing ? await store.secrets(existing.id) : { password: '', sentinelPassword: '' };
      const pw = p.password === undefined || p.password === null ? secrets.password : p.password;
      const spw = p.sentinelPassword === undefined || p.sentinelPassword === null ? secrets.sentinelPassword : p.sentinelPassword;
      if (method === 'test') {
        let caText;
        if (conn.tls && conn.caFile) { try { caText = fs.readFileSync(conn.caFile, 'utf8'); } catch (e) { throw friendly(`TLS: the CA file could not be read: ${e.message}`); } }
        const { RedisSession } = require('./redis/session');
        const st = deps.settings();
        const t0 = Date.now();
        const sess = new RedisSession(conn, { password: pw, sentinelPassword: spw }, { caText, connectTimeoutMs: st.connectTimeoutSeconds * 1000, maxReconnects: 0 });
        try {
          await sess.connect();
          const dbs = await sess.databases().catch(() => []);
          const total = dbs.reduce((a, d) => a + d.keys, 0);
          const what = `${sess.server.valkey ? 'Valkey' : 'Redis'} ${sess.server.version || ''}`.trim();
          const extra = conn.mode === 'cluster' ? `, ${sess.main.nodes('master').length} primaries` : conn.mode === 'sentinel' ? `, primary ${sess.sentinelPrimary || ''}` : '';
          return { ok: true, message: `Connected to ${what}${extra} in ${Date.now() - t0} ms. ${total.toLocaleString('en-US')} keys.`, steps: sess.steps || [] };
        } finally { await sess.close().catch(() => {}); }
      }
      if (method === 'save') {
        const saved = await store.save({ ...(existing || {}), ...conn, id: existing ? existing.id : undefined }, p.password === undefined || p.password === null ? undefined : p.password, p.sentinelPassword === undefined || p.sentinelPassword === null ? undefined : p.sentinelPassword);
        await sessions.close(saved.id);
        tree.resetConn(saved.id);
        tree.errors.delete(saved.id);
        tree.refresh();
        setTimeout(() => panel.dispose(), 50);
        return { id: saved.id };
      }
      if (method === 'cancel') { setTimeout(() => panel.dispose(), 10); return true; }
      throw friendly(`unknown ${method}`);
    },
  });
  return panel;
}

// ---------- key editor ----------

const keyPanels = new Map(); // `${connId}/${db}/${b64}` -> panel

function openKey(deps, connId, db, keyBuf, type) {
  const { vscode, sessions, store, tree, rating } = deps;
  const id = `${connId}/${db}/${keyBuf.toString('base64')}`;
  if (keyPanels.has(id)) { keyPanels.get(id).reveal(); return keyPanels.get(id); }
  let key = keyBuf;
  const conn = store.get(connId);
  const label = () => `${B.display(key, 60)}`;
  const st = () => deps.settings();
  const S = () => sessions.get(connId);
  let reported = false;
  const { panel } = createPanel(deps, {
    viewType: 'redisClient.key', title: label(), page: 'key', column: vscode.ViewColumn.Active,
    data: { key: B.wire(key), db, conn: conn ? conn.name : '', readOnly: !!(conn && conn.readOnly), type: type || '' },
    onDispose: () => keyPanels.delete(id),
    onRpc: async (method, p) => {
      const sess = await S();
      const c = store.get(connId) || {};
      switch (method) {
        case 'load': {
          const info = await sess.keyInfo(db, key);
          const out = { key: B.wire(key), info, readOnly: !!c.readOnly, json: sess.hasJson(), conn: c.name, db, mode: sess.mode, maxValueMB: st().maxValueSizeMB };
          if (info.exists) out.page = await firstPage(sess, info.type, p);
          if (!reported && info.exists) { reported = true; rating.success(); }
          return out;
        }
        case 'page': return firstPage(sess, p.type, p);
        case 'memory': return sess.memoryUsage(db, key);
        case 'head': {
          const v = await sess.getRange(db, key, 0, (p.bytes || 65536) - 1);
          return B.wire(v);
        }
        case 'saveToFile': return saveValueToFile(deps, sess, db, key);
        case 'copy': {
          const buf = Buffer.from(String(p.b64 || ''), 'base64');
          await vscode.env.clipboard.writeText(B.isUtf8(buf) ? buf.toString('utf8') : B.display(buf));
          vscode.window.setStatusBarMessage(`Copied ${B.humanBytes(buf.length)}${B.isUtf8(buf) ? '' : ' (binary, as escaped text)'}.`, 3000);
          return true;
        }
        case 'saveString': await sess.setString(db, key, decodeIn(p.value)); return true;
        case 'hset': {
          const field = decodeIn(p.field); const value = decodeIn(p.value);
          if (p.oldField) await sess.hrename(db, key, Buffer.from(p.oldField, 'base64'), field, value);
          else {
            if (p.isNew && Number(s(await sess.call(db, ['HEXISTS', key, field])))) throw friendly('A field with this name exists already. Edit it in the table instead.');
            await sess.hset(db, key, field, value);
          }
          return true;
        }
        case 'hdel': {
          const f = Buffer.from(p.field, 'base64');
          await confirm(vscode, `Delete the field "${B.display(f, 80)}"?`, `From the hash ${B.display(key, 120)}. This cannot be undone.`, 'Delete Field');
          return sess.hdel(db, key, f);
        }
        case 'lset': return sess.lset(db, key, p.index, Buffer.from(p.old, 'base64'), decodeIn(p.value));
        case 'ldel': {
          await confirm(vscode, `Delete item ${p.index} from the list?`, `${B.display(key, 120)}. This cannot be undone.`, 'Delete Item');
          return sess.ldel(db, key, p.index, Buffer.from(p.old, 'base64'));
        }
        case 'lpush': return sess.lpush(db, key, decodeIn(p.value), p.tail !== false);
        case 'sadd': return sess.sadd(db, key, decodeIn(p.member));
        case 'srem': {
          const m = Buffer.from(p.member, 'base64');
          await confirm(vscode, `Remove "${B.display(m, 80)}" from the set?`, `${B.display(key, 120)}. This cannot be undone.`, 'Remove');
          return sess.srem(db, key, m);
        }
        case 'sreplace': return sess.sreplace(db, key, Buffer.from(p.old, 'base64'), decodeIn(p.member));
        case 'zadd': {
          const sc = Number(p.score);
          if (!Number.isFinite(sc) && !/^[+-]?inf$/i.test(String(p.score))) throw friendly('The score must be a number.');
          if (p.old) return sess.zreplace(db, key, Buffer.from(p.old, 'base64'), decodeIn(p.member), String(p.score));
          return sess.zadd(db, key, String(p.score), decodeIn(p.member));
        }
        case 'zrem': {
          const m = Buffer.from(p.member, 'base64');
          await confirm(vscode, `Remove "${B.display(m, 80)}" from the sorted set?`, `${B.display(key, 120)}. This cannot be undone.`, 'Remove');
          return sess.zrem(db, key, m);
        }
        case 'xadd': return sess.xadd(db, key, (p.fields || []).map(([f, v]) => [decodeIn(f), decodeIn(v)]), p.id || '*');
        case 'xdel': {
          await confirm(vscode, `Delete the stream entry ${p.id}?`, `${B.display(key, 120)}. This cannot be undone.`, 'Delete Entry');
          return sess.xdel(db, key, p.id);
        }
        case 'groups': return (await sess.streamGroups(db, key)).map((g) => ({ ...g, consumersList: g.consumersList.map((x) => ({ name: s(x.name), pending: s(x.pending), idle: s(x.idle) })), 'last-delivered-id': s(g['last-delivered-id']) }));
        case 'jsonSet': await sess.jsonSet(db, key, Buffer.from(String(p.text), 'utf8')); return true;
        case 'ttl': {
          if (p.seconds === -1 || p.seconds === '-1') return sess.persist(db, key);
          const n = Number(p.seconds);
          if (!Number.isInteger(n) || n < 1) throw friendly('TTL is a whole number of seconds, 1 or more. Use Remove TTL to keep the key forever.');
          return sess.expire(db, key, n);
        }
        case 'rename': {
          const nk = decodeIn(p.newKey);
          if (!nk.length) throw friendly('The new name is empty.');
          if (nk.equals(key)) return { key: B.wire(key) };
          let ok = await sess.rename(db, key, nk, false);
          if (!ok) {
            await confirm(vscode, `A key named "${B.display(nk, 80)}" exists already. Replace it?`, 'Its value is deleted and this key takes the name.', 'Replace');
            ok = await sess.rename(db, key, nk, true);
          }
          const t = (await sess.keyInfo(db, nk)).type;
          tree.forgetKey(connId, db, key);
          tree.addLoadedKey(connId, db, nk, t);
          keyPanels.delete(id);
          key = nk;
          keyPanels.set(`${connId}/${db}/${key.toString('base64')}`, panel);
          panel.title = label();
          tree.refreshDb(connId, db);
          return { key: B.wire(key) };
        }
        case 'delete': {
          await confirm(vscode, `Delete the key "${B.display(key, 80)}"?`, `Database ${db} on ${c.name}. This cannot be undone.`, 'Delete Key');
          await sess.del(db, key);
          tree.forgetKey(connId, db, key);
          tree.refreshDb(connId, db);
          setTimeout(() => panel.dispose(), 10);
          return true;
        }
        default: throw friendly(`unknown ${method}`);
      }
    },
  });
  keyPanels.set(id, panel);
  return panel;

  async function firstPage(sess, type, p) {
    const n = st().pageSize;
    switch (type) {
      case 'string': {
        const r = await sess.getString(db, key, st().maxValueSizeMB * 1024 * 1024);
        return r.tooLarge ? { tooLarge: true, len: r.len } : { value: B.wire(r.value, 4 << 20) };
      }
      case 'hash': { const r = await scanPage((c) => sess.hashPage(db, key, c, p.match ? Math.max(n, 1000) : n, p.match || ''), p, n); return { cursor: r.cursor, rows: r.rows.map(([f, v]) => [cell(f), cell(v)]) }; }
      case 'set': { const r = await scanPage((c) => sess.setPage(db, key, c, p.match ? Math.max(n, 1000) : n, p.match || ''), p, n); return { cursor: r.cursor, rows: r.rows.map((m) => cell(m)) }; }
      case 'list': { const start = Number(p.start || 0); const r = await sess.listPage(db, key, start, n); return { start, rows: r.map(cell), more: r.length === n }; }
      case 'zset': { const start = Number(p.start || 0); const r = await sess.zsetPage(db, key, start, n, !!p.desc); return { start, rows: r.map(([m, sc]) => [cell(m), sc]), more: r.length === n }; }
      case 'stream': { const r = await sess.streamPage(db, key, p.before || '+', Math.min(n, 200)); return { rows: r.map(([eid, f]) => [eid, f.map(([a, b]) => [cell(a), cell(b)])]) }; }
      case 'ReJSON-RL': { const v = await sess.jsonGet(db, key); return { json: v === null ? 'null' : s(v) }; }
      default: return { unsupported: type };
    }
  }
}

/**
 * HSCAN / SSCAN with a MATCH filter can return nothing for many calls on a big key: keep scanning until a page is
 * full, the scan ends, or 3 seconds pass (the page then offers Load more from where it stopped).
 */
async function scanPage(step, p, n) {
  let cursor = p.cursor || '0';
  const rows = [];
  const t0 = Date.now();
  do {
    const r = await step(cursor);
    rows.push(...r.rows);
    cursor = r.cursor;
  } while (p.match && cursor !== '0' && rows.length < n && Date.now() - t0 < 3000);
  return { cursor, rows };
}

async function saveValueToFile(deps, sess, db, key) {
  const { vscode } = deps;
  const len = Number(s(await sess.call(db, ['STRLEN', key])));
  const target = await vscode.window.showSaveDialog({ title: `Save ${B.humanBytes(len)} to a file`, saveLabel: 'Save' });
  if (!target) return false;
  const chunk = 1 << 20;
  const fd = fs.openSync(target.fsPath, 'w');
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Saving ${B.humanBytes(len)}`, cancellable: true }, async (progress, token) => {
      for (let off = 0; off < len; off += chunk) {
        if (token.isCancellationRequested) throw friendly('Cancelled.', { cancelled: true });
        const part = await sess.getRange(db, key, off, Math.min(off + chunk, len) - 1);
        fs.writeSync(fd, part);
        progress.report({ increment: (chunk / len) * 100 });
      }
    });
  } finally { fs.closeSync(fd); }
  vscode.window.showInformationMessage(`Saved ${B.humanBytes(len)} to ${target.fsPath}.`);
  return true;
}

// ---------- console ----------

const HISTORY = (id) => `redisClient.history.${id}`;

async function openConsole(deps, connId, db) {
  const { vscode, sessions, store, context } = deps;
  const sess = await sessions.get(connId);
  const conn = store.get(connId) || {};
  let client = null;
  let curDb = db ?? (conn.db || 0);
  const getClient = async () => {
    if (!client || client.status === 'end') client = await sess.duplicate(curDb);
    return client;
  };
  createPanel(deps, {
    viewType: 'redisClient.console', title: `Console: ${conn.name}`, page: 'console', retain: true,
    data: { conn: conn.name, db: curDb, cluster: sess.mode === 'cluster', readOnly: !!conn.readOnly, names: names(), history: context.globalState.get(HISTORY(connId), []) },
    onDispose: () => { if (client) client.quit().catch(() => {}).then(() => client.disconnect()); },
    onRpc: async (method, p) => {
      if (method !== 'run') throw friendly(`unknown ${method}`);
      const line = String(p.line || '').trim();
      if (!line) return { out: '' };
      const hist = context.globalState.get(HISTORY(connId), []).filter((x) => x !== line);
      hist.push(line);
      await context.globalState.update(HISTORY(connId), hist.slice(-deps.settings().historySize));
      const argv = parseLine(line);
      if (!argv.length) return { out: '' };
      const name = argv[0].toString('utf8').toLowerCase();
      const why = unsupported([name]);
      if (why) throw friendly(why);
      const c = store.get(connId) || {};
      if (c.readOnly) {
        const ro = readOnlyBlock([name, ...argv.slice(1).map((x) => x.toString('utf8'))]);
        if (ro) throw friendly(`Read-only connection: ${ro}, so it did not run.`, { readOnly: true });
      }
      const danger = dangerous([name, argv[1] ? argv[1].toString('utf8') : '']);
      if (danger) {
        await confirm(vscode, `Run ${argv.slice(0, 2).map((x) => x.toString('utf8').toUpperCase()).join(' ')} on ${c.name}?`, `This command ${danger}.`, 'Run');
      }
      const cl = await getClient();
      const t0 = Date.now();
      let r;
      try { r = await cl.callBuffer(argv[0].toString('utf8'), argv.slice(1)); } catch (e) {
        const { explain } = require('./core/errors');
        if (e && /^[A-Z]+ /.test(e.message || '') && !/WRONGPASS|NOAUTH/.test(e.message)) return { error: e.message, ms: Date.now() - t0 };
        const x = explain(e, c);
        return { error: x.message + (x.hint ? ` ${x.hint}` : ''), ms: Date.now() - t0 };
      }
      if (name === 'select' && sess.mode !== 'cluster') curDb = Number(argv[1].toString('utf8'));
      return { out: formatTop(name, r), ms: Date.now() - t0, db: curDb };
    },
  });
}

// ---------- server info ----------

async function openServer(deps, connId) {
  const { sessions, store } = deps;
  const sess = await sessions.get(connId);
  const conn = store.get(connId) || {};
  createPanel(deps, {
    viewType: 'redisClient.server', title: `Server: ${conn.name}`, page: 'server', retain: true,
    data: { conn: conn.name, mode: sess.mode, nodes: sess.nodeList() },
    onRpc: async (method, p) => {
      if (method === 'nodes') return sess.nodeList();
      if (method !== 'snapshot') throw friendly(`unknown ${method}`);
      const r = await sess.serverSnapshot(p.node);
      const err = (x) => (x instanceof Error ? x.message : null);
      const info = err(r.info) ? [] : parseInfo(s(r.info));
      return {
        info, infoError: err(r.info), keyspace: keyspace(info),
        slowlog: err(r.slowlog) ? null : parseSlowlog(r.slowlog), slowlogError: err(r.slowlog),
        clients: err(r.clients) ? null : parseClients(s(r.clients)).slice(0, 1000), clientsError: err(r.clients),
        cluster: r.cluster && !err(r.cluster) ? parseClusterNodes(s(r.cluster)) : null,
        primary: r.primary, at: new Date().toISOString(),
      };
    },
  });
}

// ---------- pub/sub ----------

async function openPubSub(deps, connId) {
  const { vscode, sessions, store } = deps;
  const sess = await sessions.get(connId);
  const conn = store.get(connId) || {};
  let sub = null;
  let queue = [];
  let timer = null;
  let ref = null;
  const flush = () => { timer = null; if (queue.length && ref) { ref.post({ type: 'messages', list: queue.splice(0) }); } };
  const push = (m) => { queue.push(m); if (queue.length > 5000) queue.splice(0, queue.length - 5000); if (!timer) timer = setTimeout(flush, 100); };
  const ensure = async () => {
    if (sub) return sub;
    sub = await sess.duplicate();
    sub.on('messageBuffer', (ch, msg) => push({ channel: B.display(ch, 300), message: cell(msg), at: Date.now() }));
    sub.on('pmessageBuffer', (pat, ch, msg) => push({ pattern: B.display(pat, 300), channel: B.display(ch, 300), message: cell(msg), at: Date.now() }));
    sub.on('error', () => {});
    return sub;
  };
  ref = createPanel(deps, {
    viewType: 'redisClient.pubsub', title: `Pub/Sub: ${conn.name}`, page: 'pubsub', retain: true,
    data: { conn: conn.name, readOnly: !!conn.readOnly },
    onDispose: () => { if (timer) clearTimeout(timer); if (sub) sub.quit().catch(() => {}).then(() => sub.disconnect()); },
    onRpc: async (method, p) => {
      const target = decodeIn({ enc: 'esc', v: p.channel || '' });
      if (method === 'subscribe') {
        if (!target.length) throw friendly('Type a channel name or a pattern such as news.*');
        const c = await ensure();
        if (p.pattern) await c.psubscribe(target); else await c.subscribe(target);
        return true;
      }
      if (method === 'unsubscribe') {
        if (!sub) return true;
        if (p.pattern) await sub.punsubscribe(target); else await sub.unsubscribe(target);
        return true;
      }
      if (method === 'publish') {
        if (!target.length) throw friendly('Type the channel to publish to.');
        const n = await sess.call(undefined, ['PUBLISH', target, decodeIn({ enc: 'text', v: p.message || '' })], { write: true });
        return Number(s(n));
      }
      throw friendly(`unknown ${method}`);
    },
  });
  void vscode;
}

// ---------- memory report (Zovo Pro) ----------

function openMemoryReport(deps, connId, db, title, report) {
  const { vscode } = deps;
  const ser = { ...report, biggest: report.biggest.map((b) => ({ id: b.key.toString('base64'), text: b.text, type: b.type, bytes: b.bytes })) };
  createPanel(deps, {
    viewType: 'redisClient.memory', title: `Memory: ${title}`, page: 'memory', retain: true,
    data: { title, report: ser },
    onRpc: async (method, p) => {
      if (method === 'open') { openKey(deps, connId, db, Buffer.from(p.id, 'base64')); return true; }
      if (method === 'markdown') {
        const { toMarkdown } = require('./core/memory');
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: toMarkdown(report, title, B.humanBytes) });
        await vscode.window.showTextDocument(doc, { preview: false });
        return true;
      }
      throw friendly(`unknown ${method}`);
    },
  });
}

module.exports = { openForm, openKey, openConsole, openServer, openPubSub, openMemoryReport, decodeIn, cell, keyPanels };
