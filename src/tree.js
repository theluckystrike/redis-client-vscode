'use strict';
// The Redis Explorer tree: connections, databases, key folders (split by the separator) and keys.
// Keys come from SCAN in pages (never KEYS *). Types are read for the keys of a folder when it opens.

const { buildTree, addKey, children } = require('./core/keytree');
const { display, toId, humanBytes } = require('./core/bytes');
const { toUrl } = require('./core/config');

const TYPE_ICON = { string: 'symbol-string', hash: 'symbol-object', list: 'list-ordered', set: 'symbol-array', zset: 'list-filter', stream: 'pulse', 'ReJSON-RL': 'json', none: 'circle-slash', '?': 'key' };
const TYPE_LABEL = { string: 'string', hash: 'hash', list: 'list', set: 'set', zset: 'sorted set', stream: 'stream', 'ReJSON-RL': 'JSON' };

class KeyTreeProvider {
  constructor(vscode, store, sessions, settings) {
    this.vscode = vscode;
    this.store = store;
    this.sessions = sessions;
    this.settings = settings;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.dbs = new Map(); // `${connId}/${db}` -> state
    this.errors = new Map(); // connId -> message
    this.nodes = new Map(); // stable node objects for connections and databases (refresh needs the same object)
  }

  connNode(id) {
    const k = `c/${id}`;
    if (!this.nodes.has(k)) this.nodes.set(k, { kind: 'conn', id });
    return this.nodes.get(k);
  }

  dbNode(connId, db, keys) {
    const k = `d/${connId}/${db}`;
    if (!this.nodes.has(k)) this.nodes.set(k, { kind: 'db', connId, db, keys });
    const n = this.nodes.get(k);
    if (keys !== undefined) n.keys = keys;
    return n;
  }

  refreshConn(id) { this.emitter.fire(this.connNode(id)); }
  refreshDb(connId, db) { const n = this.nodes.get(`d/${connId}/${db}`); this.emitter.fire(n || this.connNode(connId)); }

  refresh(node) { this.emitter.fire(node); }

  dbKey(connId, db) { return `${connId}/${db}`; }

  dbState(connId, db) {
    const k = this.dbKey(connId, db);
    if (!this.dbs.has(k)) this.dbs.set(k, { connId, db, pattern: '*', type: '', root: null, scan: null, done: false, loaded: 0, total: null, warnings: [], loading: null });
    return this.dbs.get(k);
  }

  resetConn(connId) { for (const k of [...this.dbs.keys()]) if (k.startsWith(`${connId}/`)) this.dbs.delete(k); }

  resetDb(connId, db, keepFilter = true) {
    const st = this.dbState(connId, db);
    Object.assign(st, { root: null, scan: null, done: false, loaded: 0, total: null, warnings: [], loading: null });
    if (!keepFilter) { st.pattern = '*'; st.type = ''; }
  }

  /** Load the next page of keys of a database (SCAN with the filter). */
  async loadMore(connId, db) {
    const st = this.dbState(connId, db);
    if (st.loading) return st.loading;
    const s = this.settings();
    const sep = (this.store.get(connId) || {}).separator ?? ':';
    st.loading = (async () => {
      const session = await this.sessions.get(connId);
      const root = st.root || buildTree([], sep);
      let stop = false;
      await this.vscode.window.withProgress({ location: { viewId: 'redisClient.explorer' }, title: 'Scanning keys' }, async () => {
        const r = await session.scan(db, st.scan, { pattern: st.pattern, type: st.type, count: s.scanCount, limit: s.scanPageSize, shouldStop: () => stop });
        for (const k of r.keys) addKey(root, k, sep);
        st.root = root;
        st.loaded += r.keys.length;
        st.scan = r.state;
        st.done = r.done;
        st.warnings = r.warnings;
        if (st.total === null) try { st.total = await session.dbsize(db); } catch { st.total = null; }
      });
      if (st.warnings.length) this.vscode.window.showWarningMessage(st.warnings.join(' '));
    })().finally(() => { st.loading = null; });
    return st.loading;
  }

  getTreeItem(n) {
    const vs = this.vscode;
    const T = vs.TreeItemCollapsibleState;
    if (n.kind === 'conn') {
      const c = this.store.get(n.id) || n.conn;
      const open = this.sessions.isOpen(n.id);
      const sess = this.sessions.peek(n.id);
      const it = new vs.TreeItem(c.name, T.Collapsed);
      it.id = `conn:${n.id}`;
      const err = this.errors.get(n.id);
      const st = sess && sess.status;
      const mode = c.mode === 'cluster' ? 'cluster' : c.mode === 'sentinel' ? 'sentinel' : '';
      it.description = [mode, c.readOnly ? 'read-only' : '', st === 'reconnecting' ? 'reconnecting…' : st === 'closed' && err ? 'disconnected' : err && !open ? 'failed' : ''].filter(Boolean).join(' · ');
      it.iconPath = new vs.ThemeIcon(err && !open ? 'error' : st === 'reconnecting' ? 'sync~spin' : open ? 'database' : 'plug', err && !open ? new vs.ThemeColor('errorForeground') : undefined);
      it.contextValue = `connection${open ? '-open' : ''}${c.readOnly ? '-ro' : ''}`;
      const md = new vs.MarkdownString(`**${c.name}**\n\n\`${toUrl(c)}\`${c.readOnly ? '\n\nRead-only: writes are refused before they reach the server.' : ''}${sess && sess.server.version ? `\n\n${sess.server.valkey ? 'Valkey' : 'Redis'} ${sess.server.version}${(sess.server.modules || []).length ? ` · modules: ${sess.server.modules.join(', ')}` : ''}` : ''}${err ? `\n\n$(error) ${err}` : ''}`, true);
      it.tooltip = md;
      return it;
    }
    if (n.kind === 'db') {
      const st = this.dbState(n.connId, n.db);
      const c = this.store.get(n.connId) || {};
      const it = new vs.TreeItem(c.mode === 'cluster' ? 'keys' : `db${n.db}`, T.Collapsed);
      it.id = `db:${n.connId}/${n.db}`;
      const total = st.total ?? n.keys;
      const filter = st.pattern !== '*' || st.type ? ` · filter ${st.pattern}${st.type ? ` (${TYPE_LABEL[st.type] || st.type})` : ''}` : '';
      it.description = `${Number(total || 0).toLocaleString('en-US')} keys${st.root ? ` · ${st.loaded.toLocaleString('en-US')} loaded` : ''}${filter}`;
      it.iconPath = new vs.ThemeIcon(filter ? 'filter' : 'database');
      it.contextValue = filter ? 'db-filtered' : 'db';
      return it;
    }
    if (n.kind === 'folder') {
      const it = new vs.TreeItem(n.folder.name === '' ? '(empty)' : n.folder.name, T.Collapsed);
      it.id = `folder:${n.connId}/${n.db}/${n.folder.prefix}`;
      it.description = `${n.folder.count.toLocaleString('en-US')}`;
      it.iconPath = new vs.ThemeIcon('folder');
      it.contextValue = 'folder';
      it.tooltip = `${n.folder.prefix}*  ·  ${n.folder.count.toLocaleString('en-US')} loaded keys`;
      return it;
    }
    if (n.kind === 'key') {
      const it = new vs.TreeItem(n.item.label === '' ? '(empty)' : n.item.label, T.None);
      it.id = `key:${n.connId}/${n.db}/${toId(n.item.buf)}`;
      const type = n.item.type;
      it.description = type && type !== '?' ? (TYPE_LABEL[type] || type) : '';
      it.iconPath = new vs.ThemeIcon(TYPE_ICON[type] || 'key');
      it.contextValue = 'key';
      it.tooltip = `${n.item.text}${type ? `\n${TYPE_LABEL[type] || type}` : ''}${n.item.buf.length > 200 ? `\n${humanBytes(n.item.buf.length)} key name` : ''}`;
      it.command = { command: 'redisClient.openKey', title: 'Open Key', arguments: [n] };
      return it;
    }
    if (n.kind === 'more') {
      const it = new vs.TreeItem(n.label, T.None);
      it.iconPath = new vs.ThemeIcon('ellipsis');
      it.command = { command: 'redisClient.loadMore', title: 'Load more keys', arguments: [n] };
      it.contextValue = 'more';
      return it;
    }
    const it = new vs.TreeItem(n.label, T.None);
    it.iconPath = new vs.ThemeIcon(n.icon || 'info', n.color ? new vs.ThemeColor(n.color) : undefined);
    if (n.command) it.command = n.command;
    it.tooltip = n.tooltip || n.label;
    it.contextValue = n.context || 'message';
    return it;
  }

  async getChildren(n) {
    if (!n) return this.store.list().map((c) => this.connNode(c.id));
    if (n.kind === 'conn') {
      const before = `${this.sessions.isOpen(n.id)}|${this.errors.get(n.id) || ''}`;
      const changed = () => `${this.sessions.isOpen(n.id)}|${this.errors.get(n.id) || ''}` !== before;
      try {
        const s = await this.sessions.get(n.id);
        this.errors.delete(n.id);
        const dbs = await s.databases();
        if (changed()) setTimeout(() => this.emitter.fire(this.connNode(n.id)), 0); // icon and description; children stay
        return dbs.map((d) => this.dbNode(n.id, d.db, d.keys));
      } catch (e) {
        const msg = e.message || String(e);
        if (!e.cancelled) this.errors.set(n.id, msg);
        if (changed()) setTimeout(() => this.emitter.fire(this.connNode(n.id)), 0);
        return [
          { kind: 'msg', label: msg, icon: 'error', color: 'errorForeground', tooltip: msg },
          { kind: 'msg', label: 'Edit the connection', icon: 'edit', command: { command: 'redisClient.editConnection', title: 'Edit', arguments: [{ kind: 'conn', id: n.id }] } },
          { kind: 'msg', label: 'Try again', icon: 'refresh', command: { command: 'redisClient.reconnect', title: 'Reconnect', arguments: [{ kind: 'conn', id: n.id }] } },
        ];
      }
    }
    if (n.kind === 'db') {
      const st = this.dbState(n.connId, n.db);
      try {
        if (!st.root) { await this.loadMore(n.connId, n.db); setTimeout(() => this.emitter.fire(n), 0); } // once: the description shows "loaded"
      } catch (e) {
        return [{ kind: 'msg', label: e.message, icon: 'error', color: 'errorForeground' }, { kind: 'msg', label: 'Try again', icon: 'refresh', command: { command: 'redisClient.refresh', title: 'Refresh', arguments: [n] } }];
      }
      const out = await this.folderChildren(n.connId, n.db, st.root);
      if (!st.loaded) out.push({ kind: 'msg', label: st.pattern !== '*' || st.type ? `No key matches ${st.pattern}` : 'No keys in this database', icon: 'info' });
      if (!st.done) out.push({ kind: 'more', connId: n.connId, db: n.db, label: `Load ${this.settings().scanPageSize.toLocaleString('en-US')} more keys…` });
      return out;
    }
    if (n.kind === 'folder') return this.folderChildren(n.connId, n.db, n.folder);
    return [];
  }

  async folderChildren(connId, db, folder) {
    const { folders, keys } = children(folder);
    const need = keys.filter((k) => !k.type).slice(0, 5000);
    if (need.length) {
      try {
        const session = await this.sessions.get(connId);
        const types = await session.types(db, need.map((k) => k.buf));
        need.forEach((k, i) => { k.type = types[i]; });
      } catch { /* types stay unknown */ }
    }
    return [
      ...folders.map((f) => ({ kind: 'folder', connId, db, folder: f })),
      ...keys.filter((k) => k.type !== 'none').map((item) => ({ kind: 'key', connId, db, item })),
    ];
  }

  /** Remove a key from the loaded tree after it was deleted or renamed. */
  forgetKey(connId, db, buf) {
    const st = this.dbState(connId, db);
    if (!st.root) return;
    const walk = (f) => {
      const i = f.keys.findIndex((k) => k.buf.equals(buf));
      if (i >= 0) { f.keys.splice(i, 1); for (let p = f; p; p = p.parent) p.count--; st.loaded--; return true; }
      for (const c of f.folders.values()) if (walk(c)) { if (!c.count) f.folders.delete(c.name); return true; }
      return false;
    };
    walk(st.root);
    if (st.total) st.total--;
  }

  addLoadedKey(connId, db, buf, type) {
    const st = this.dbState(connId, db);
    if (!st.root) return;
    const sep = (this.store.get(connId) || {}).separator ?? ':';
    const f = addKey(st.root, buf, sep);
    f.keys[f.keys.length - 1].type = type;
    st.loaded++;
    if (st.total !== null) st.total++;
  }
}

module.exports = { KeyTreeProvider, TYPE_LABEL, TYPE_ICON, display };
