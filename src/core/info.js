'use strict';
// Parsers for INFO, SLOWLOG GET, CLIENT LIST and CLUSTER NODES text.

function parseInfo(text) {
  const sections = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { cur = { name: line.replace(/^#\s*/, ''), rows: [] }; sections.push(cur); continue; }
    const i = line.indexOf(':');
    if (i < 0) continue;
    if (!cur) { cur = { name: 'Info', rows: [] }; sections.push(cur); }
    cur.rows.push([line.slice(0, i), line.slice(i + 1)]);
  }
  return sections;
}

function infoValue(sections, key) {
  for (const s of sections) for (const [k, v] of s.rows) if (k === key) return v;
  return undefined;
}

/** db0:keys=1,expires=0,avg_ttl=0 -> [{db: 0, keys: 1, expires: 0, avgTtl: 0}] */
function keyspace(sections) {
  const s = sections.find((x) => /^keyspace$/i.test(x.name));
  if (!s) return [];
  return s.rows.filter(([k]) => /^db\d+$/.test(k)).map(([k, v]) => {
    const o = Object.fromEntries(v.split(',').map((p) => p.split('=')));
    return { db: Number(k.slice(2)), keys: Number(o.keys || 0), expires: Number(o.expires || 0), avgTtl: Number(o.avg_ttl || 0) };
  });
}

const str = (x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x === null || x === undefined ? '' : String(x));

/** SLOWLOG GET reply -> [{id, time, micros, args, client, name}] */
function parseSlowlog(reply) {
  return (reply || []).map((e) => ({
    id: Number(str(e[0])), time: Number(str(e[1])), micros: Number(str(e[2])),
    args: (e[3] || []).map(str), client: str(e[4]), name: str(e[5]),
  }));
}

/** CLIENT LIST text -> [{id, addr, name, age, idle, db, cmd, ...}] */
function parseClients(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const o = {};
    for (const p of line.split(' ')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); }
    return o;
  });
}

/** CLUSTER NODES text -> [{id, addr, host, port, flags, master, slots, connected}] */
function parseClusterNodes(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const p = line.split(' ');
    const addr = (p[1] || '').split('@')[0].split(',')[0];
    const i = addr.lastIndexOf(':');
    return { id: p[0], addr, host: addr.slice(0, i), port: Number(addr.slice(i + 1)), flags: (p[2] || '').split(','), master: p[3], connected: p[7] === 'connected', slots: p.slice(8).join(' ') };
  });
}

module.exports = { parseInfo, infoValue, keyspace, parseSlowlog, parseClients, parseClusterNodes };
