'use strict';
// Memory analysis (Zovo Pro): biggest keys and key patterns from sampled MEMORY USAGE.

const { display } = require('./bytes');

/** user:12345:profile -> user:*:profile ; ids, numbers, uuids and long hex become "*". */
function patternOf(text, separator = ':') {
  if (!separator) return text.replace(/\d+/g, '*');
  return text.split(separator).map((seg) => {
    if (/^\d+$/.test(seg)) return '*';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '*';
    if (/^[0-9a-f]{12,}$/i.test(seg)) return '*';
    if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg)) return '*';
    if (/\d{3,}/.test(seg)) return seg.replace(/\d+/g, '*');
    return seg;
  }).join(separator);
}

class MemoryReport {
  constructor(separator = ':', top = 50) {
    this.separator = separator; this.top = top;
    this.sampled = 0; this.bytes = 0; this.missing = 0;
    this.biggest = []; // {key, text, type, bytes}
    this.patterns = new Map(); // pattern -> {count, bytes, max, type}
    this.types = new Map(); // type -> {count, bytes}
  }

  add(keyBuf, type, bytes) {
    if (bytes === null || bytes === undefined) { this.missing++; return; }
    bytes = Number(bytes);
    this.sampled++; this.bytes += bytes;
    const text = display(keyBuf, 300);
    if (this.biggest.length < this.top || bytes > this.biggest[this.biggest.length - 1].bytes) {
      this.biggest.push({ key: keyBuf, text, type, bytes });
      this.biggest.sort((a, b) => b.bytes - a.bytes);
      if (this.biggest.length > this.top) this.biggest.pop();
    }
    const p = patternOf(text, this.separator);
    const cur = this.patterns.get(p) || { count: 0, bytes: 0, max: 0, types: new Set() };
    cur.count++; cur.bytes += bytes; cur.max = Math.max(cur.max, bytes); cur.types.add(type);
    this.patterns.set(p, cur);
    const t = this.types.get(type) || { count: 0, bytes: 0 };
    t.count++; t.bytes += bytes;
    this.types.set(type, t);
  }

  result(totalKeys) {
    const scale = totalKeys && this.sampled ? totalKeys / this.sampled : 1;
    const patterns = [...this.patterns.entries()].map(([pattern, v]) => ({ pattern, count: v.count, bytes: v.bytes, max: v.max, avg: Math.round(v.bytes / v.count), types: [...v.types].join(', '), share: this.bytes ? v.bytes / this.bytes : 0 }))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 100);
    const types = [...this.types.entries()].map(([type, v]) => ({ type, count: v.count, bytes: v.bytes })).sort((a, b) => b.bytes - a.bytes);
    return { sampled: this.sampled, missing: this.missing, bytes: this.bytes, totalKeys: totalKeys || this.sampled, estimatedBytes: Math.round(this.bytes * scale), biggest: this.biggest, patterns, types };
  }
}

function toMarkdown(r, title, humanBytes) {
  const L = [`# Memory analysis: ${title}`, '', `Sampled ${r.sampled.toLocaleString('en-US')} of ${r.totalKeys.toLocaleString('en-US')} keys with MEMORY USAGE. Sampled keys use ${humanBytes(r.bytes)}; all keys are about ${humanBytes(r.estimatedBytes)}.`, '', '## Key patterns by memory', '', '| Pattern | Keys | Memory | Share | Average | Largest | Types |', '|---|---:|---:|---:|---:|---:|---|'];
  for (const p of r.patterns) L.push(`| \`${p.pattern.replace(/\|/g, '\\|')}\` | ${p.count} | ${humanBytes(p.bytes)} | ${(p.share * 100).toFixed(1)} % | ${humanBytes(p.avg)} | ${humanBytes(p.max)} | ${p.types} |`);
  L.push('', '## Biggest keys', '', '| Key | Type | Memory |', '|---|---|---:|');
  for (const b of r.biggest) L.push(`| \`${b.text.replace(/\|/g, '\\|')}\` | ${b.type} | ${humanBytes(b.bytes)} |`);
  L.push('', '## By type', '', '| Type | Keys | Memory |', '|---|---:|---:|');
  for (const t of r.types) L.push(`| ${t.type} | ${t.count} | ${humanBytes(t.bytes)} |`);
  return L.join('\n') + '\n';
}

module.exports = { patternOf, MemoryReport, toMarkdown };
