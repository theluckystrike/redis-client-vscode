'use strict';
// Connection settings: URL parsing and ioredis options for a single node, a cluster or a sentinel set.
// Kept free of the vscode module and of ioredis so tests can run it.

const DEFAULT_PORT = 6379;
const SENTINEL_PORT = 26379;

function friendly(msg) { return Object.assign(new Error(msg), { friendly: true }); }

/** "host:port, host2:port2" or one per line -> [{host, port}] */
function parseNodes(text, defPort = DEFAULT_PORT) {
  return String(text || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
    let host = s; let port = defPort;
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
    if (v6) { host = v6[1]; if (v6[2]) port = Number(v6[2]); } else {
      const i = s.lastIndexOf(':');
      if (i > 0 && s.indexOf(':') === i) { host = s.slice(0, i); port = Number(s.slice(i + 1)); }
    }
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw friendly(`"${s}" is not host:port.`);
    return { host, port };
  });
}

function nodesText(nodes) {
  return (nodes || []).map((n) => (String(n.host).includes(':') ? `[${n.host}]:${n.port}` : `${n.host}:${n.port}`)).join(', ');
}

/**
 * Parse redis://, rediss://, valkey://, valkeys://, redis+sentinel:// and redis-sentinel:// URLs.
 * Returns connection fields plus password (kept apart: it goes to SecretStorage).
 */
function parseUrl(raw) {
  const s = String(raw || '').trim();
  const m = /^([a-z+-]+):\/\/(.*)$/i.exec(s);
  if (!m) throw friendly('A Redis URL starts with redis:// or rediss://, for example redis://default:secret@localhost:6379/0.');
  const scheme = m[1].toLowerCase();
  const known = { redis: [false, 'standalone'], rediss: [true, 'standalone'], valkey: [false, 'standalone'], valkeys: [true, 'standalone'],
    'redis+sentinel': [false, 'sentinel'], 'redis-sentinel': [false, 'sentinel'], 'rediss+sentinel': [true, 'sentinel'],
    'redis+cluster': [false, 'cluster'], 'rediss+cluster': [true, 'cluster'] };
  if (!known[scheme]) throw friendly(`Unknown scheme "${scheme}://". Use redis://, rediss://, redis+sentinel:// or redis+cluster://.`);
  const [tls, mode] = known[scheme];
  let rest = m[2];
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  let path = '';
  const sl = rest.indexOf('/');
  if (sl >= 0) { path = rest.slice(sl + 1); rest = rest.slice(0, sl); }
  let user = ''; let password = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at); rest = rest.slice(at + 1);
    const c = cred.indexOf(':');
    if (c >= 0) { user = decodeURIComponent(cred.slice(0, c)); password = decodeURIComponent(cred.slice(c + 1)); } else password = decodeURIComponent(cred);
  }
  const params = new URLSearchParams(query);
  const out = { mode, tls, user, db: 0 };
  if (mode === 'sentinel') {
    out.sentinels = parseNodes(rest, SENTINEL_PORT);
    const parts = path.split('/').filter(Boolean);
    out.sentinelName = params.get('sentinelMasterId') || params.get('name') || params.get('masterName') || parts[0] || 'mymaster';
    if (parts.length > 1 && /^\d+$/.test(parts[1])) out.db = Number(parts[1]);
    if (!out.sentinels.length) throw friendly('The sentinel URL has no host:port.');
  } else if (mode === 'cluster' || rest.includes(',')) {
    out.mode = 'cluster';
    out.nodes = parseNodes(rest);
    if (!out.nodes.length) throw friendly('The cluster URL has no host:port.');
  } else {
    const n = parseNodes(rest || 'localhost')[0];
    out.host = n.host; out.port = n.port;
    if (/^\d+$/.test(path)) out.db = Number(path);
    else if (path) throw friendly(`"/${path}" is not a database number. Use /0 to /15.`);
  }
  if (params.get('db') && /^\d+$/.test(params.get('db'))) out.db = Number(params.get('db'));
  if (out.mode === 'cluster') out.db = 0;
  return { conn: out, password };
}

/** The URL of a saved connection, without the password (for copy and display). */
function toUrl(c) {
  const auth = c.user ? `${encodeURIComponent(c.user)}@` : '';
  if (c.mode === 'cluster') return `${c.tls ? 'rediss' : 'redis'}+cluster://${auth}${nodesText(c.nodes)}`;
  if (c.mode === 'sentinel') return `${c.tls ? 'rediss' : 'redis'}+sentinel://${auth}${nodesText(c.sentinels)}/${encodeURIComponent(c.sentinelName || 'mymaster')}/${c.db || 0}`;
  const host = String(c.host).includes(':') ? `[${c.host}]` : c.host;
  return `${c.tls ? 'rediss' : 'redis'}://${auth}${host}:${c.port || DEFAULT_PORT}/${c.db || 0}`;
}

/** Check a connection from the form; returns a clean copy or throws a friendly error. */
function validate(c) {
  const out = { ...c };
  out.mode = ['standalone', 'cluster', 'sentinel'].includes(c.mode) ? c.mode : 'standalone';
  out.name = String(c.name || '').trim();
  out.db = Number(c.db || 0);
  if (!Number.isInteger(out.db) || out.db < 0 || out.db > 1000) throw friendly('The database index is a number from 0 (most servers have 0 to 15).');
  if (out.mode === 'standalone') {
    out.host = String(c.host || '').trim() || 'localhost';
    out.port = Number(c.port || DEFAULT_PORT);
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw friendly('The port is a number from 1 to 65535.');
  }
  if (out.mode === 'cluster') {
    out.nodes = Array.isArray(c.nodes) ? c.nodes : parseNodes(c.nodes);
    if (!out.nodes.length) throw friendly('Add at least one cluster node as host:port.');
    out.db = 0;
  }
  if (out.mode === 'sentinel') {
    out.sentinels = Array.isArray(c.sentinels) ? c.sentinels : parseNodes(c.sentinels, SENTINEL_PORT);
    if (!out.sentinels.length) throw friendly('Add at least one sentinel as host:port.');
    out.sentinelName = String(c.sentinelName || '').trim();
    if (!out.sentinelName) throw friendly('Type the name of the primary that the sentinels watch (often "mymaster").');
  }
  out.separator = c.separator === undefined ? ':' : String(c.separator);
  if (!out.name) out.name = out.mode === 'standalone' ? `${out.host}:${out.port}` : out.mode === 'cluster' ? `cluster ${nodesText(out.nodes.slice(0, 1))}` : `sentinel ${out.sentinelName}`;
  return out;
}

/**
 * ioredis options. secrets: {password, sentinelPassword}; caText: the CA file content (or undefined).
 * lazyConnect: nothing connects until the extension calls connect().
 */
function ioredisOptions(c, secrets = {}, extra = {}) {
  const timeout = extra.connectTimeoutMs || 10000;
  const tls = c.tls ? {
    rejectUnauthorized: c.tlsInsecure !== true,
    ...(extra.caText ? { ca: extra.caText } : {}),
    ...(c.tlsServername ? { servername: c.tlsServername } : {}),
  } : undefined;
  const base = {
    username: c.user || undefined,
    password: secrets.password || undefined,
    db: c.mode === 'cluster' ? undefined : (c.db || 0),
    connectTimeout: timeout,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectionName: undefined,
    retryStrategy: (times) => (times > (extra.maxReconnects ?? 20) ? null : Math.min(200 * times, 3000)),
    reconnectOnError: (err) => /READONLY/.test(err && err.message) ? 2 : false,
    tls,
  };
  if (c.mode === 'sentinel') {
    return {
      ...base,
      sentinels: c.sentinels.map((n) => ({ host: n.host, port: n.port })),
      name: c.sentinelName,
      sentinelUsername: c.sentinelUser || undefined,
      sentinelPassword: secrets.sentinelPassword || undefined,
      enableTLSForSentinelMode: !!c.tls,
      sentinelTLS: tls,
      sentinelRetryStrategy: (times) => (times > (extra.maxReconnects ?? 20) ? null : Math.min(300 * times, 3000)),
      failoverDetector: true,
    };
  }
  if (c.mode === 'cluster') {
    const { db, retryStrategy, ...redisOptions } = base;
    return {
      nodes: c.nodes.map((n) => ({ host: n.host, port: n.port })),
      options: {
        redisOptions,
        lazyConnect: true,
        enableReadyCheck: true,
        maxRedirections: 16,
        retryDelayOnFailover: 200,
        retryDelayOnClusterDown: 300,
        slotsRefreshTimeout: timeout,
        clusterRetryStrategy: (times) => (times > (extra.maxReconnects ?? 20) ? null : Math.min(300 * times, 3000)),
        dnsLookup: (address, cb) => cb(null, address),
        ...(c.natMap ? { natMap: c.natMap } : {}),
      },
    };
  }
  return { ...base, host: c.host, port: c.port };
}

module.exports = { parseUrl, parseNodes, nodesText, toUrl, validate, ioredisOptions, DEFAULT_PORT, SENTINEL_PORT };
