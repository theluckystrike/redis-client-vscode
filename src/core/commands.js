'use strict';
// Console helpers: redis-cli style argument parsing, reply formatting, the read-only rule and the
// list of commands that ask before they run.

const commands = require('@ioredis/commands');
const { display } = require('./bytes');

function friendly(msg) { return Object.assign(new Error(msg), { friendly: true }); }

/**
 * Split a console line into argument Buffers like redis-cli: spaces separate arguments, "double quotes"
 * understand \xNN, \n, \r, \t, \" and \\, 'single quotes' are literal (\' is a quote).
 */
function parseLine(line) {
  const args = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const parts = [];
    let text = '';
    const flush = () => { if (text) { parts.push(Buffer.from(text, 'utf8')); text = ''; } };
    if (s[i] === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const c = s[i];
        if (c === '\\' && i + 1 < s.length) {
          const d = s[i + 1];
          if (d === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) { flush(); parts.push(Buffer.from([parseInt(s.slice(i + 2, i + 4), 16)])); i += 4; continue; }
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\u0007' };
          text += map[d] !== undefined ? map[d] : d;
          i += 2; continue;
        }
        if (c === '"') { closed = true; i++; break; }
        text += c; i++;
      }
      if (!closed) throw friendly('A double quote is not closed.');
      if (i < s.length && !/\s/.test(s[i])) throw friendly('A closing quote must be followed by a space.');
    } else if (s[i] === "'") {
      i++;
      let closed = false;
      while (i < s.length) {
        const c = s[i];
        if (c === '\\' && s[i + 1] === "'") { text += "'"; i += 2; continue; }
        if (c === "'") { closed = true; i++; break; }
        text += c; i++;
      }
      if (!closed) throw friendly('A single quote is not closed.');
      if (i < s.length && !/\s/.test(s[i])) throw friendly('A closing quote must be followed by a space.');
    } else {
      while (i < s.length && !/\s/.test(s[i])) { text += s[i]; i++; }
    }
    flush();
    args.push(Buffer.concat(parts));
  }
  return args;
}

/** A reply as redis-cli prints it. Buffers are shown as quoted, escaped text. */
function formatReply(r, indent = '') {
  if (r === null || r === undefined) return '(nil)';
  if (r instanceof Error) return `(error) ${r.message}`;
  if (typeof r === 'number' || typeof r === 'bigint') return `(integer) ${r}`;
  if (Buffer.isBuffer(r)) return `"${display(r).replace(/"/g, '\\"')}"`;
  if (typeof r === 'string') return r === 'OK' || r === 'PONG' || r === 'QUEUED' ? r : `"${r.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  if (Array.isArray(r)) {
    if (!r.length) return '(empty array)';
    const w = String(r.length).length;
    return r.map((x, i) => {
      const lead = `${String(i + 1).padStart(w)}) `;
      const body = formatReply(x, indent + ' '.repeat(lead.length));
      return (i ? indent : '') + lead + body;
    }).join('\n');
  }
  if (typeof r === 'object') return formatReply(Object.entries(r).flat(), indent);
  return String(r);
}

/** Status replies such as OK come back from callBuffer as Buffers; INFO-like bulk text reads better raw. */
function formatTop(name, r) {
  const raw = ['info', 'client', 'cluster', 'memory', 'latency', 'lolwut'].includes(name);
  if (raw && Buffer.isBuffer(r)) {
    const t = r.toString('utf8');
    if (name !== 'client' || t.includes('\n') || /^id=/.test(t)) return t.replace(/\r\n/g, '\n').trimEnd();
  }
  if (Buffer.isBuffer(r) && ['OK', 'PONG', 'QUEUED'].includes(r.toString('latin1'))) return r.toString('latin1');
  return formatReply(r);
}

const READ_SUB = {
  client: ['list', 'info', 'getname', 'id', 'trackinginfo', 'getredir', 'no-evict', 'help'],
  config: ['get', 'help'],
  memory: ['usage', 'stats', 'doctor', 'malloc-stats', 'help'],
  object: ['encoding', 'freq', 'idletime', 'refcount', 'help'],
  xinfo: ['stream', 'groups', 'consumers', 'help'],
  slowlog: ['get', 'len', 'help'],
  cluster: ['info', 'nodes', 'slots', 'shards', 'myid', 'myshardid', 'keyslot', 'countkeysinslot', 'getkeysinslot', 'links', 'replicas', 'slaves', 'count-failure-reports', 'help'],
  acl: ['whoami', 'list', 'users', 'cat', 'getuser', 'log', 'dryrun', 'help'],
  function: ['list', 'stats', 'dump', 'help'],
  script: ['exists', 'help'],
  command: null, // every subcommand reads
  latency: ['latest', 'history', 'doctor', 'graph', 'histogram', 'help'],
  module: ['list', 'help'],
  pubsub: null,
};

const READ_MODULE = new Set(['json.get', 'json.mget', 'json.type', 'json.strlen', 'json.arrlen', 'json.objlen', 'json.objkeys', 'json.resp', 'json.debug', 'json.arrindex',
  'ft.search', 'ft.aggregate', 'ft.info', 'ft._list', 'ft.explain', 'ft.explaincli', 'ft.profile', 'ft.tagvals', 'ft.spellcheck', 'ft.syndump', 'ft.dictdump',
  'ts.get', 'ts.mget', 'ts.range', 'ts.revrange', 'ts.mrange', 'ts.mrevrange', 'ts.info', 'ts.queryindex',
  'bf.exists', 'bf.mexists', 'bf.info', 'bf.card', 'cf.exists', 'cf.mexists', 'cf.count', 'cf.info', 'cms.query', 'cms.info', 'topk.query', 'topk.list', 'topk.info', 'topk.count',
  'tdigest.quantile', 'tdigest.cdf', 'tdigest.min', 'tdigest.max', 'tdigest.info', 'tdigest.rank', 'tdigest.byrank', 'tdigest.trimmed_mean']);

/** null when the command may run on a read-only connection, else the reason it may not. */
function readOnlyBlock(argv) {
  const name = String(argv[0] || '').toLowerCase();
  const sub = String(argv[1] || '').toLowerCase();
  if (!name) return null;
  if (Object.prototype.hasOwnProperty.call(READ_SUB, name)) {
    const ok = READ_SUB[name];
    if (ok === null || ok.includes(sub)) return null;
    return `${name.toUpperCase()} ${sub.toUpperCase()} can change the server`;
  }
  if (READ_MODULE.has(name)) return null;
  if (!commands.exists(name)) return `${name.toUpperCase()} is not a known read command`;
  if (['eval', 'evalsha', 'fcall'].includes(name)) return `${name.toUpperCase()} can write (use ${name.toUpperCase()}_RO)`;
  if (commands.hasFlag(name, 'write')) return `${name.toUpperCase()} writes`;
  if (commands.hasFlag(name, 'admin')) return `${name.toUpperCase()} is an admin command`;
  return null;
}

/** Commands that ask for a confirmation in the console. Returns the reason text or null. */
function dangerous(argv) {
  const name = String(argv[0] || '').toLowerCase();
  const sub = String(argv[1] || '').toLowerCase();
  const why = {
    flushall: 'deletes every key in every database',
    flushdb: 'deletes every key in the current database',
    keys: 'walks every key in one call and blocks the server until it finishes (the key tree uses SCAN instead)',
    debug: 'is a debugging command that can crash or block the server',
    shutdown: 'stops the server',
    swapdb: 'swaps two whole databases',
  }[name];
  if (why) return why;
  if (name === 'script' && sub === 'flush') return 'removes every cached Lua script';
  if (name === 'function' && sub === 'flush') return 'removes every function library';
  if (name === 'cluster' && ['reset', 'failover', 'forget', 'flushslots', 'delslots', 'delslotsrange'].includes(sub)) return 'changes the cluster layout';
  if (name === 'config' && ['set', 'rewrite', 'resetstat'].includes(sub)) return 'changes the server configuration';
  if (name === 'client' && ['kill', 'pause'].includes(sub)) return 'disconnects or pauses clients';
  if (['replicaof', 'slaveof', 'failover'].includes(name)) return 'changes replication';
  return null;
}

/** Commands the console does not run (they take over the connection). */
function unsupported(argv) {
  const name = String(argv[0] || '').toLowerCase();
  if (['subscribe', 'psubscribe', 'ssubscribe', 'unsubscribe', 'punsubscribe', 'sunsubscribe'].includes(name)) return 'Use Redis: Pub/Sub to subscribe; it keeps its own connection and shows messages live.';
  if (name === 'monitor') return 'MONITOR streams every command on the server and is not run from the console.';
  if (['multi', 'exec', 'discard', 'watch'].includes(name)) return 'Transactions are not run line by line in the console. Use EVAL or a script.';
  if (name === 'sync' || name === 'psync') return 'Replication commands are not run from the console.';
  if (name === 'quit' || name === 'reset' || name === 'hello' || name === 'auth') return `${name.toUpperCase()} would change the console connection. Edit the connection instead.`;
  return null;
}

/** Command names for autocomplete (lowercase, sorted), plus the common module commands. */
function names() {
  const extra = ['json.get', 'json.set', 'json.del', 'json.type', 'json.mget', 'json.arrappend', 'json.numincrby', 'ft.search', 'ft.info', 'ft._list', 'ts.add', 'ts.range', 'ts.get', 'bf.add', 'bf.exists'];
  return [...new Set([...commands.list.filter((n) => !n.includes('|')), ...extra])].sort();
}

/** Completions for the text typed so far: command names that start with the first word. */
function complete(prefix, list = names()) {
  const p = String(prefix || '').trimStart().toLowerCase();
  if (!p || /\s/.test(p)) return [];
  return list.filter((n) => n.startsWith(p)).slice(0, 50);
}

module.exports = { parseLine, formatReply, formatTop, readOnlyBlock, dangerous, unsupported, names, complete };
