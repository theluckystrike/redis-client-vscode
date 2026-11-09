'use strict';
// Export / import format: JSON with one key per line, binary safe.
// A byte string that is valid UTF-8 is written as a JSON string; any other is {"$b64": "..."}.
// {"format":"zovo-redis-export","version":1,...,"keys":[
// {"key":"user:1","type":"hash","ttl":-1,"value":[["name","Ann"]]},
// ...
// ]}

const { isUtf8, toBuf } = require('./bytes');

const FORMAT = 'zovo-redis-export';

function enc(buf) {
  buf = toBuf(buf);
  return isUtf8(buf) ? buf.toString('utf8') : { $b64: buf.toString('base64') };
}

function dec(v) {
  if (v && typeof v === 'object' && typeof v.$b64 === 'string') return Buffer.from(v.$b64, 'base64');
  if (typeof v === 'number') return Buffer.from(String(v));
  if (typeof v !== 'string') throw Object.assign(new Error('A value in the file is not a string or {"$b64": ...}.'), { friendly: true });
  return Buffer.from(v, 'utf8');
}

function header(meta = {}) {
  return `{"format":"${FORMAT}","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"source":${JSON.stringify(meta.source || '')},"pattern":${JSON.stringify(meta.pattern || '*')},"keys":[\n`;
}

const FOOTER = '\n]}\n';

/** One exported key -> JSON text (one line). value is in the shape readKeyFull returns. */
function entryLine(e) {
  const o = { key: enc(e.key), type: e.type, ttl: e.ttl };
  switch (e.type) {
    case 'string': o.value = enc(e.value); break;
    case 'hash': o.value = e.value.map(([f, v]) => [enc(f), enc(v)]); break;
    case 'list': case 'set': o.value = e.value.map(enc); break;
    case 'zset': o.value = e.value.map(([m, s]) => [enc(m), Number(s)]); break;
    case 'stream': o.value = e.value.map(([id, fields]) => [String(id), fields.map(([f, v]) => [enc(f), enc(v)])]); break;
    case 'ReJSON-RL': case 'json': o.type = 'json'; o.value = e.value.toString('utf8'); break;
    default: throw new Error(`type ${e.type} cannot be exported`);
  }
  return JSON.stringify(o);
}

/** Parsed entry from the file -> {key: Buffer, type, ttl, value} with Buffers. */
function decodeEntry(o) {
  if (!o || typeof o !== 'object' || o.key === undefined || !o.type) throw Object.assign(new Error('An entry has no "key" or "type".'), { friendly: true });
  const e = { key: dec(o.key), type: o.type, ttl: Number(o.ttl || -1) };
  const v = o.value;
  switch (o.type) {
    case 'string': e.value = dec(v); break;
    case 'hash': e.value = v.map(([f, x]) => [dec(f), dec(x)]); break;
    case 'list': case 'set': e.value = v.map(dec); break;
    case 'zset': e.value = v.map(([m, s]) => [dec(m), Number(s)]); break;
    case 'stream': e.value = v.map(([id, fields]) => [String(id), fields.map(([f, x]) => [dec(f), dec(x)])]); break;
    case 'json': e.value = Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'); break;
    default: throw Object.assign(new Error(`Unknown type "${o.type}".`), { friendly: true });
  }
  return e;
}

/**
 * Entries of a file, line by line when it has our layout (so a big export never sits in memory as one string).
 * lines: async iterable of text lines. Returns an async generator of decoded entries.
 */
async function* readEntries(lines) {
  let first = true;
  let whole = null;
  for await (const raw of lines) {
    const line = raw.trim();
    if (first) {
      first = false;
      if (line.startsWith('{"format":"zovo-redis-export"') && line.endsWith('"keys":[')) continue;
      whole = [raw];
      continue;
    }
    if (whole) { whole.push(raw); if (whole.length > 2000000) throw Object.assign(new Error('The file is not in the export layout and is too big to read at once.'), { friendly: true }); continue; }
    if (!line || line === ']}') continue;
    yield decodeEntry(JSON.parse(line.replace(/,$/, '')));
  }
  if (whole) {
    const o = JSON.parse(whole.join('\n'));
    const list = Array.isArray(o) ? o : o && Array.isArray(o.keys) ? o.keys : null;
    if (!list) throw Object.assign(new Error('The file has no "keys" list. Import reads files made by Export Keys.'), { friendly: true });
    for (const x of list) yield decodeEntry(x);
  }
}

module.exports = { FORMAT, enc, dec, header, FOOTER, entryLine, decodeEntry, readEntries };
