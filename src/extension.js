'use strict';
// Redis Client & Redis GUI for VS Code (Zovo). Free, no sign-in, no telemetry: the extension talks only to the
// Redis, Valkey or KeyDB servers you add. Nothing connects at start-up.

const vscode = require('vscode');
const fs = require('fs');
const readline = require('readline');
const { ConnectionStore, SessionManager } = require('./connections');
const { KeyTreeProvider } = require('./tree');
const panels = require('./panels');
const B = require('./core/bytes');
const { folderPattern } = require('./core/keytree');
const { toUrl } = require('./core/config');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');
const pro = require('./pro');

const SECTION = 'redisClient';
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  const num = (k, d, min, max) => { const v = Number(c.get(k, d)); return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : d; };
  return {
    scanPageSize: num('scanPageSize', 10000, 100, 1000000),
    scanCount: num('scanCount', 1000, 10, 100000),
    pageSize: num('pageSize', 200, 10, 10000),
    maxValueSizeMB: num('maxValueSizeMB', 5, 1, 512),
    exportMaxValueMB: num('exportMaxValueMB', 64, 1, 1024),
    connectTimeoutSeconds: num('connectTimeoutSeconds', 10, 2, 120),
    commandTimeoutSeconds: num('commandTimeoutSeconds', 60, 5, 3600),
    historySize: num('historySize', 200, 10, 5000),
    showSupportLinks: c.get('showSupportLinks', true) !== false,
  };
}

function activate(context) {
  const store = new ConnectionStore(vscode, context);
  const sessions = new SessionManager(vscode, store, settings);
  const tree = new KeyTreeProvider(vscode, store, sessions, settings);
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.zovo-redis-client', section: SECTION, name: 'Redis Client' });
  registerSupport({ vscode, context, prefix: SECTION, selfId: 'zovo.zovo-redis-client' });
  const proApi = pro.createPro(vscode, context);
  const deps = { vscode, context, store, sessions, tree, settings, rating, pro: proApi };

  const view = vscode.window.createTreeView('redisClient.explorer', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view, { dispose: () => { sessions.close().catch(() => {}); } });

  sessions.onStatus = (id, status, err) => {
    if (status === 'failed') { rating.failure(); return; }
    if (status === 'reconnecting' || status === 'closed') {
      const c = store.get(id);
      if (err) tree.errors.set(id, require('./core/errors').explain(err, c).message);
      tree.refreshConn(id);
      if (status === 'closed' && c) {
        vscode.window.showWarningMessage(`Redis: lost the connection to ${c.name}. ${tree.errors.get(id) || ''}`, 'Reconnect').then((b) => { if (b) vscode.commands.executeCommand('redisClient.reconnect', tree.connNode(id)); });
      }
    }
    if (status === 'ready') { tree.errors.delete(id); tree.refreshConn(id); }
  };

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) {
      if (e && e.cancelled) return undefined;
      vscode.window.showErrorMessage(e && e.message ? e.message : String(e));
      return undefined;
    }
  }));

  const connOf = async (n) => {
    if (n && (n.id || n.connId)) return n.id || n.connId;
    const list = store.list();
    if (!list.length) { await vscode.commands.executeCommand('redisClient.addConnection'); return null; }
    if (list.length === 1) return list[0].id;
    const p = await vscode.window.showQuickPick(list.map((c) => ({ label: c.name, description: toUrl(c), id: c.id })), { placeHolder: 'Pick a connection' });
    return p ? p.id : null;
  };
  const dbOf = (n) => (n && n.db !== undefined ? n.db : (store.get(n && (n.connId || n.id)) || {}).db || 0);

  reg('redisClient.addConnection', () => panels.openForm(deps, null));
  reg('redisClient.editConnection', async (n) => { const id = await connOf(n); if (id) panels.openForm(deps, store.get(id)); });
  reg('redisClient.deleteConnection', async (n) => {
    const id = await connOf(n); const c = id && store.get(id); if (!c) return;
    const b = await vscode.window.showWarningMessage(`Delete the connection "${c.name}"?`, { modal: true, detail: 'Only the saved connection and its password on this computer are removed. No data on the server changes.' }, 'Delete');
    if (b !== 'Delete') return;
    await sessions.close(id); tree.resetConn(id); await store.remove(id); tree.refresh();
  });
  reg('redisClient.disconnect', async (n) => { const id = await connOf(n); if (!id) return; await sessions.close(id); tree.resetConn(id); tree.errors.delete(id); tree.refresh(); });
  reg('redisClient.reconnect', async (n) => {
    const id = await connOf(n); if (!id) return;
    await sessions.close(id); tree.resetConn(id); tree.errors.delete(id); tree.refresh();
    try { await sessions.get(id); vscode.window.setStatusBarMessage(`Redis: connected to ${store.get(id).name}.`, 4000); } catch (e) { tree.errors.set(id, e.message); tree.refresh(); throw e; }
    tree.refresh();
  });
  reg('redisClient.refresh', async (n) => {
    if (!n) { tree.refresh(); return; }
    if (n.kind === 'conn') { tree.resetConn(n.id); if (sessions.peek(n.id) && sessions.peek(n.id).status === 'closed') await sessions.close(n.id); tree.errors.delete(n.id); tree.refreshConn(n.id); return; }
    if (n.kind === 'db') { tree.resetDb(n.connId, n.db); tree.refreshDb(n.connId, n.db); return; }
    if (n.kind === 'folder' || n.kind === 'key') { tree.resetDb(n.connId, n.db); tree.refreshDb(n.connId, n.db); return; }
    tree.refresh();
  });
  reg('redisClient.toggleReadOnly', async (n) => {
    const id = await connOf(n); const c = id && store.get(id); if (!c) return;
    await store.setReadOnly(id, !c.readOnly);
    const s = sessions.peek(id); if (s) s.readOnly = !c.readOnly;
    tree.refreshConn(id);
    vscode.window.setStatusBarMessage(`Redis: ${c.name} is ${!c.readOnly ? 'read-only now. Writes are refused before they reach the server.' : 'writable now.'}`, 5000);
  });
  reg('redisClient.copyUrl', async (n) => { const id = await connOf(n); if (id) { await vscode.env.clipboard.writeText(toUrl(store.get(id))); vscode.window.setStatusBarMessage('Copied the URL (without the password).', 3000); } });

  reg('redisClient.filterKeys', async (n) => {
    if (!n || n.kind !== 'db') {
      const id = await connOf(n); if (!id) return;
      n = tree.dbNode(id, dbOf(n));
    }
    const st = tree.dbState(n.connId, n.db);
    const pattern = await vscode.window.showInputBox({ title: 'Filter keys (SCAN MATCH)', prompt: 'A glob pattern: * any text, ? one character, [abc] a set. Example: user:*:session', value: st.pattern === '*' ? '' : st.pattern, placeHolder: '*' });
    if (pattern === undefined) return;
    const types = [{ label: 'All types', t: '' }, ...['string', 'hash', 'list', 'set', 'zset', 'stream'].map((t) => ({ label: t === 'zset' ? 'sorted set' : t, t }))];
    const tp = await vscode.window.showQuickPick(types, { placeHolder: 'Only keys of one type? (SCAN TYPE, Redis 6+)' });
    if (!tp) return;
    tree.resetDb(n.connId, n.db);
    st.pattern = pattern.trim() || '*';
    st.type = tp.t;
    tree.refreshDb(n.connId, n.db);
    view.reveal(n, { expand: true }).then(undefined, () => {});
  });
  reg('redisClient.clearFilter', async (n) => { if (!n || n.kind !== 'db') return; tree.resetDb(n.connId, n.db, false); tree.refreshDb(n.connId, n.db); });
  reg('redisClient.loadMore', async (n) => { if (!n) return; await tree.loadMore(n.connId, n.db); tree.refreshDb(n.connId, n.db); });
  reg('redisClient.openKey', async (n) => { if (n && n.item) panels.openKey(deps, n.connId, n.db, n.item.buf, n.item.type); });
  reg('redisClient.copyKeyName', async (n) => {
    if (!n) return;
    const text = n.kind === 'folder' ? n.folder.prefix : B.display(n.item.buf);
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`Copied ${text.length > 60 ? text.slice(0, 60) + '…' : text}`, 3000);
  });
  reg('redisClient.deleteKey', async (n) => {
    if (!n || !n.item) return;
    const s = await sessions.get(n.connId);
    const c = store.get(n.connId);
    const b = await vscode.window.showWarningMessage(`Delete the key "${B.display(n.item.buf, 80)}"?`, { modal: true, detail: `Database ${n.db} on ${c.name}. This cannot be undone.` }, 'Delete Key');
    if (b !== 'Delete Key') return;
    await s.del(n.db, n.item.buf);
    tree.forgetKey(n.connId, n.db, n.item.buf);
    tree.refreshDb(n.connId, n.db);
  });
  reg('redisClient.renameKey', async (n) => {
    if (!n || !n.item) return;
    const s = await sessions.get(n.connId);
    const v = await vscode.window.showInputBox({ title: 'Rename key', value: B.display(n.item.buf), prompt: 'Bytes that are not text can be typed as \\xNN.' });
    if (v === undefined) return;
    const nk = B.parseEscaped(v);
    if (!nk.length || nk.equals(n.item.buf)) return;
    let ok = await s.rename(n.db, n.item.buf, nk, false);
    if (!ok) {
      const b = await vscode.window.showWarningMessage(`A key named "${B.display(nk, 80)}" exists already. Replace it?`, { modal: true }, 'Replace');
      if (b !== 'Replace') return;
      ok = await s.rename(n.db, n.item.buf, nk, true);
    }
    tree.forgetKey(n.connId, n.db, n.item.buf);
    tree.addLoadedKey(n.connId, n.db, nk, n.item.type);
    tree.refreshDb(n.connId, n.db);
  });
  reg('redisClient.addKey', async (n) => {
    const id = await connOf(n); if (!id) return;
    const db = dbOf(n);
    const s = await sessions.get(id);
    const types = [['string', 'String'], ['hash', 'Hash'], ['list', 'List'], ['set', 'Set'], ['zset', 'Sorted set'], ['stream', 'Stream']];
    if (s.hasJson()) types.push(['json', 'JSON (RedisJSON)']);
    const t = await vscode.window.showQuickPick(types.map(([v, label]) => ({ label, v })), { placeHolder: 'Type of the new key' });
    if (!t) return;
    const prefix = n && n.kind === 'folder' ? n.folder.prefix : '';
    const name = await vscode.window.showInputBox({ title: `New ${t.label.toLowerCase()} key`, value: prefix, valueSelection: [prefix.length, prefix.length], prompt: 'Key name. Bytes that are not text can be typed as \\xNN.' });
    if (!name) return;
    const key = B.parseEscaped(name);
    let a; let b;
    const ask = (title, value = '') => vscode.window.showInputBox({ title, value });
    if (t.v === 'string') a = await ask('Value');
    else if (t.v === 'hash') { a = await ask('First field'); if (a !== undefined) b = await ask('Its value'); }
    else if (t.v === 'list' || t.v === 'set') a = await ask('First item');
    else if (t.v === 'zset') { a = await ask('First member'); if (a !== undefined) b = await ask('Its score', '0'); }
    else if (t.v === 'stream') { a = await ask('First field', 'field'); if (a !== undefined) b = await ask('Its value'); }
    else if (t.v === 'json') a = await ask('JSON value', '{}');
    if (a === undefined || ((t.v === 'hash' || t.v === 'zset' || t.v === 'stream') && b === undefined)) return;
    await s.create(db, t.v, key, Buffer.from(a, 'utf8'), b === undefined ? undefined : t.v === 'zset' ? b : Buffer.from(b, 'utf8'));
    const realType = t.v === 'json' ? 'ReJSON-RL' : t.v;
    tree.addLoadedKey(id, db, key, realType);
    tree.refreshDb(id, db);
    panels.openKey(deps, id, db, key, realType);
  });

  reg('redisClient.openConsole', async (n) => { const id = await connOf(n); if (id) await panels.openConsole(deps, id, n && n.db !== undefined ? n.db : undefined); });
  reg('redisClient.serverInfo', async (n) => { const id = await connOf(n); if (id) await panels.openServer(deps, id); });
  reg('redisClient.pubsub', async (n) => { const id = await connOf(n); if (id) await panels.openPubSub(deps, id); });
  reg('redisClient.exportKeys', (n) => exportKeys(deps, n, connOf, dbOf));
  reg('redisClient.importKeys', (n) => importKeys(deps, n, connOf, dbOf));

  reg('redisClient.memoryAnalysis', async (n) => {
    const id = await connOf(n); if (!id) return;
    const db = dbOf(n);
    const s = await sessions.get(id);
    const c = store.get(id);
    const pattern = n && n.kind === 'folder' ? folderPattern(n.folder.prefix) : tree.dbState(id, db).pattern || '*';
    const size = await vscode.window.showQuickPick([
      { label: 'Sample 10,000 keys', n: 10000, description: 'a few seconds' },
      { label: 'Sample 100,000 keys', n: 100000 },
      { label: 'Every key', n: Number.MAX_SAFE_INTEGER, description: 'can take minutes on big databases' },
      { label: 'Sample 1,000 keys', n: 1000 },
    ], { placeHolder: `Memory Analysis (Zovo Pro) of ${c.name} db${db}${pattern !== '*' ? `, keys matching ${pattern}` : ''}. MEMORY USAGE runs on each sampled key.` });
    if (!size) return;
    if (!(await proApi.allow('Memory Analysis', 'Memory Analysis finds the biggest keys and the key patterns that use the most memory.'))) return;
    let stop = false;
    const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Memory Analysis', cancellable: true }, async (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      return pro.analyzeMemory(s, db, { pattern, limit: size.n, separator: c.separator ?? ':', shouldStop: () => stop, onProgress: (seen, total) => progress.report({ message: `${seen.toLocaleString('en-US')} of ${Number(total || 0).toLocaleString('en-US')} keys` }) });
    });
    panels.openMemoryReport(deps, id, db, `${c.name} db${db}${pattern !== '*' ? ` ${pattern}` : ''}`, report);
    rating.success();
  });

  reg('redisClient.bulkByPattern', async (n) => {
    const id = await connOf(n); if (!id) return;
    const db = dbOf(n);
    const s = await sessions.get(id);
    const c = store.get(id);
    if (c.readOnly) throw Object.assign(new Error(`${c.name} is read-only. Turn read-only off to change keys in bulk.`), { friendly: true });
    const value = n && n.kind === 'folder' ? folderPattern(n.folder.prefix) : '';
    const pattern = await vscode.window.showInputBox({ title: 'Bulk TTL / Delete by Pattern (Zovo Pro)', prompt: 'Keys matching this glob pattern. A dry run shows them first; nothing changes until you confirm.', value, placeHolder: 'session:*' });
    if (!pattern) return;
    const act = await vscode.window.showQuickPick([
      { label: 'Delete the keys', v: 'delete', description: 'UNLINK' },
      { label: 'Set a TTL', v: 'expire', description: 'EXPIRE' },
      { label: 'Remove the TTL', v: 'persist', description: 'PERSIST' },
    ], { placeHolder: `What to do with keys matching ${pattern}` });
    if (!act) return;
    let seconds = 0;
    if (act.v === 'expire') {
      const t = await vscode.window.showInputBox({ title: 'TTL in seconds', value: '3600', validateInput: (x) => (/^\d+$/.test(x) && Number(x) > 0 ? null : 'A whole number of seconds, 1 or more') });
      if (!t) return;
      seconds = Number(t);
    }
    if (!(await proApi.allow('Bulk TTL and Delete', 'Bulk TTL and Delete changes every key that matches a pattern, with a dry run first.'))) return;
    let stop = false;
    const dry = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Dry run: ${pattern}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      return pro.bulkDryRun(s, db, pattern, { shouldStop: () => stop, onProgress: (k) => progress.report({ message: `${k.toLocaleString('en-US')} keys match` }) });
    });
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: pro.dryRunMarkdown(c.name, db, pattern, act.v, seconds, dry) });
    await vscode.window.showTextDocument(doc, { preview: true });
    if (!dry.count) { vscode.window.showInformationMessage(`No key matches ${pattern}. Nothing to do.`); return; }
    const verb = act.v === 'delete' ? 'Delete' : act.v === 'expire' ? `Set a ${seconds} s TTL on` : 'Remove the TTL of';
    const go = await vscode.window.showWarningMessage(`${verb} ${dry.complete ? '' : 'at least '}${dry.count.toLocaleString('en-US')} keys matching "${pattern}"?`, { modal: true, detail: `Database ${db} on ${c.name}. The dry run list is open in the editor.${act.v === 'delete' ? ' Deleted keys cannot be brought back.' : ''}` }, verb);
    if (go !== verb) return;
    stop = false;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${verb} keys matching ${pattern}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      return pro.bulkApply(s, db, pattern, act.v, seconds, { shouldStop: () => stop, onProgress: (m, ch) => progress.report({ message: `${ch.toLocaleString('en-US')} changed` }) });
    });
    tree.resetDb(id, db); tree.refreshDb(id, db);
    vscode.window.showInformationMessage(`${verb.replace(/^Set a/, 'Set the')}: ${r.changed.toLocaleString('en-US')} keys changed${stop ? ' (stopped)' : ''}.`);
  });

  reg('redisClient.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.zovo-redis-client#redisClient.start', false));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(SECTION)) tree.refresh(); }));
  context.subscriptions.push(store.onDidChange(() => tree.refresh()));
}

async function exportKeys(deps, n, connOf, dbOf) {
  const { store, sessions, tree, settings: st } = deps;
  const id = await connOf(n); if (!id) return;
  const db = dbOf(n);
  const s = await sessions.get(id);
  const c = store.get(id);
  const def = n && n.kind === 'folder' ? folderPattern(n.folder.prefix) : tree.dbState(id, db).pattern || '*';
  const pattern = await vscode.window.showInputBox({ title: 'Export keys to JSON', prompt: 'Keys matching this glob pattern (* = all keys of the database).', value: def });
  if (!pattern) return;
  const safe = `${c.name}-db${db}`.replace(/[^\w.-]+/g, '_');
  const base = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : undefined;
  const target = await vscode.window.showSaveDialog({ title: 'Export keys', defaultUri: base ? vscode.Uri.joinPath(base, `redis-${safe}.json`) : undefined, filters: { JSON: ['json'] } });
  if (!target) return;
  const { header, FOOTER, entryLine } = require('./core/exportfmt');
  const out = fs.createWriteStream(target.fsPath);
  const write = (t) => new Promise((res, rej) => { if (out.write(t)) res(); else out.once('drain', res); out.once('error', rej); });
  let n2 = 0; const skipped = [];
  let stop = false;
  const max = st().exportMaxValueMB * 1024 * 1024;
  try {
    await write(header({ source: `${c.name} db${db}`, pattern }));
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting ${pattern}`, cancellable: true }, async (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      let state = null;
      for (;;) {
        const r = await s.scan(db, state, { pattern, count: 1000, limit: 1000 });
        state = r.state;
        const seen = new Set();
        for (const k of r.keys) {
          const kid = k.toString('base64'); if (seen.has(kid)) continue; seen.add(kid);
          let e;
          try { e = await s.readFull(db, k, max); } catch (err) { skipped.push(`${B.display(k, 80)}: ${err.message}`); continue; }
          if (!e) continue;
          await write((n2 ? ',\n' : '') + entryLine(e));
          n2++;
        }
        progress.report({ message: `${n2.toLocaleString('en-US')} keys` });
        if (r.done || stop) break;
      }
    });
    await write(FOOTER);
  } finally { await new Promise((res) => out.end(res)); }
  const msg = `Exported ${n2.toLocaleString('en-US')} keys to ${target.fsPath}${stop ? ' (stopped early)' : ''}.${skipped.length ? ` ${skipped.length} skipped: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''}` : ''}`;
  if (skipped.length) vscode.window.showWarningMessage(msg); else vscode.window.showInformationMessage(msg);
}

async function importKeys(deps, n, connOf, dbOf) {
  const { store, sessions, tree } = deps;
  const id = await connOf(n); if (!id) return;
  const db = dbOf(n);
  const c = store.get(id);
  if (c.readOnly) throw Object.assign(new Error(`${c.name} is read-only. Turn read-only off to import keys.`), { friendly: true });
  const s = await sessions.get(id);
  const files = await vscode.window.showOpenDialog({ title: 'Import keys from a JSON export', canSelectMany: false, filters: { JSON: ['json'], 'All files': ['*'] } });
  if (!files || !files[0]) return;
  const pol = await vscode.window.showQuickPick([
    { label: 'Skip keys that exist', v: 'skip', description: 'existing keys stay as they are' },
    { label: 'Replace keys that exist', v: 'replace', description: 'the key is deleted and written again' },
  ], { placeHolder: `Import into ${c.name} db${db}` });
  if (!pol) return;
  const { readEntries } = require('./core/exportfmt');
  let written = 0; let skippedN = 0; const failed = [];
  let stop = false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Importing keys', cancellable: true }, async (progress, token) => {
    token.onCancellationRequested(() => { stop = true; });
    const rl = readline.createInterface({ input: fs.createReadStream(files[0].fsPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const e of readEntries(rl)) {
        try { const r = await s.importEntry(db, e, pol.v); if (r === 'written') written++; else skippedN++; } catch (err) { failed.push(`${B.display(e.key, 60)}: ${err.message}`); }
        if ((written + skippedN) % 200 === 0) progress.report({ message: `${written.toLocaleString('en-US')} written` });
        if (stop) break;
      }
    } finally { rl.close(); }
  });
  tree.resetDb(id, db); tree.refreshDb(id, db);
  const msg = `Imported ${written.toLocaleString('en-US')} keys, ${skippedN.toLocaleString('en-US')} skipped${failed.length ? `, ${failed.length} failed: ${failed.slice(0, 3).join('; ')}` : ''}${stop ? ' (stopped early)' : ''}.`;
  if (failed.length) vscode.window.showWarningMessage(msg); else vscode.window.showInformationMessage(msg);
}

function deactivate() {}

module.exports = { activate, deactivate };
