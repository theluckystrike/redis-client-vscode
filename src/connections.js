'use strict';
// Saved connections (VS Code global state, no secrets) and their passwords (VS Code SecretStorage).
// A connection opens only when the user expands it or runs a command on it.

const fs = require('fs');
const crypto = require('crypto');

const KEY = 'redisClient.connections';
const SECRET = (id) => `redisClient.password.${id}`;
const SENTINEL_SECRET = (id) => `redisClient.sentinelPassword.${id}`;
const FIELDS = ['id', 'name', 'mode', 'host', 'port', 'user', 'db', 'tls', 'tlsInsecure', 'tlsServername', 'caFile', 'nodes', 'sentinels', 'sentinelName', 'sentinelUser', 'sentinelTls', 'readOnly', 'separator', 'savePassword'];

class ConnectionStore {
  constructor(vscode, context) {
    this.vscode = vscode;
    this.context = context;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  list() {
    const raw = this.context.globalState.get(KEY, []);
    return Array.isArray(raw) ? raw.filter((c) => c && c.id && c.mode) : [];
  }

  get(id) { return this.list().find((c) => c.id === id) || null; }

  /** password / sentinelPassword: a string to store, '' to clear, undefined to keep the stored one. */
  async save(conn, password, sentinelPassword) {
    const clean = {};
    for (const f of FIELDS) if (conn[f] !== undefined) clean[f] = conn[f];
    if (!clean.id) clean.id = crypto.randomUUID();
    clean.readOnly = !!clean.readOnly;
    const list = this.list();
    const i = list.findIndex((c) => c.id === clean.id);
    if (i >= 0) list[i] = clean; else list.push(clean);
    await this.context.globalState.update(KEY, list);
    if (password !== undefined) {
      if (password && clean.savePassword !== false) await this.context.secrets.store(SECRET(clean.id), password);
      else await this.context.secrets.delete(SECRET(clean.id));
    }
    if (sentinelPassword !== undefined) {
      if (sentinelPassword && clean.savePassword !== false) await this.context.secrets.store(SENTINEL_SECRET(clean.id), sentinelPassword);
      else await this.context.secrets.delete(SENTINEL_SECRET(clean.id));
    }
    this.emitter.fire(clean.id);
    return clean;
  }

  async setReadOnly(id, on) {
    const c = this.get(id);
    if (!c) return null;
    return this.save({ ...c, readOnly: !!on });
  }

  async remove(id) {
    await this.context.globalState.update(KEY, this.list().filter((c) => c.id !== id));
    await this.context.secrets.delete(SECRET(id));
    await this.context.secrets.delete(SENTINEL_SECRET(id));
    this.emitter.fire(id);
  }

  async secrets(id) {
    return { password: (await this.context.secrets.get(SECRET(id))) || '', sentinelPassword: (await this.context.secrets.get(SENTINEL_SECRET(id))) || '' };
  }
}

class SessionManager {
  constructor(vscode, store, settings) {
    this.vscode = vscode;
    this.store = store;
    this.settings = settings;
    this.sessions = new Map(); // connId -> RedisSession
    this.pending = new Map(); // connId -> Promise<RedisSession>
    this.asked = new Map(); // passwords typed for this window only (savePassword false)
    this.onStatus = null;
  }

  isOpen(id) { const s = this.sessions.get(id); return !!(s && !s.closed); }
  peek(id) { return this.sessions.get(id) || null; }

  async get(id) {
    const s = this.sessions.get(id);
    if (s && !s.closed && s.status !== 'closed') return s;
    if (this.pending.has(id)) return this.pending.get(id);
    const p = this.open(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  async open(id) {
    const c = this.store.get(id);
    if (!c) throw Object.assign(new Error('This connection was deleted.'), { friendly: true });
    const old = this.sessions.get(id);
    if (old) { this.sessions.delete(id); old.close().catch(() => {}); }
    const secrets = await this.store.secrets(id);
    if (!secrets.password && c.savePassword === false) {
      let pw = this.asked.get(id);
      if (pw === undefined) {
        pw = await this.vscode.window.showInputBox({ title: `Password for ${c.name}`, prompt: 'Leave empty when the server has no password.', password: true, ignoreFocusOut: true });
        if (pw === undefined) throw Object.assign(new Error('No password was typed.'), { friendly: true, cancelled: true });
        this.asked.set(id, pw);
      }
      secrets.password = pw;
    }
    let caText;
    if (c.tls && c.caFile) {
      try { caText = fs.readFileSync(c.caFile, 'utf8'); } catch (e) { throw Object.assign(new Error(`The CA file ${c.caFile} could not be read: ${e.message}`), { friendly: true, step: 'TLS' }); }
    }
    const st = this.settings();
    const { RedisSession } = require('./redis/session'); // loads ioredis only when a connection opens
    const s = new RedisSession(c, secrets, {
      caText, connectTimeoutMs: st.connectTimeoutSeconds * 1000, commandTimeoutMs: st.commandTimeoutSeconds * 1000,
      onStatus: (status, err) => { if (this.onStatus) this.onStatus(id, status, err); },
    });
    await s.connect();
    this.sessions.set(id, s);
    return s;
  }

  async close(id) {
    const all = id ? [[id, this.sessions.get(id)]] : [...this.sessions.entries()];
    for (const [k, s] of all) {
      this.sessions.delete(k);
      if (id) this.asked.delete(id);
      if (s) await s.close().catch(() => {});
    }
    if (!id) this.asked.clear();
  }
}

module.exports = { ConnectionStore, SessionManager };
