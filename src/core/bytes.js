'use strict';
// Binary-safe helpers. Keys and values stay Buffers end to end; text is only for display.
// A key is addressed by its exact bytes (base64 id), never by its display text.

const nodeBuffer = require('buffer');

function isUtf8(buf) {
  if (!buf || !buf.length) return true;
  if (typeof nodeBuffer.isUtf8 === 'function') return nodeBuffer.isUtf8(buf);
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

function toBuf(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x);
  if (x === null || x === undefined) return Buffer.alloc(0);
  return Buffer.from(String(x), 'utf8');
}

const toId = (buf) => toBuf(buf).toString('base64');
const fromId = (id) => Buffer.from(String(id || ''), 'base64');

/**
 * Display text in the style of redis-cli: valid UTF-8 without control characters is shown as is;
 * anything else escapes bytes as \xNN (and \n, \r, \t, \\, \"). parseEscaped() turns it back into the same bytes.
 */
function display(buf, max = Infinity) {
  buf = toBuf(buf);
  const cut = buf.length > max ? buf.subarray(0, max) : buf;
  let out;
  if (isUtf8(cut) && !/[\u0000-\u001f\u007f\\]/.test(cut.toString('utf8'))) out = cut.toString('utf8');
  else if (isUtf8(cut)) out = escapeText(cut.toString('utf8'));
  else out = escapeBytes(cut);
  return buf.length > max ? out + '…' : out;
}

function escapeText(s) {
  return s.replace(/[\u0000-\u001f\u007f\\]/g, (c) => {
    if (c === '\\') return '\\\\';
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');
  });
}

function escapeBytes(buf) {
  let s = '';
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    // keep valid multi-byte UTF-8 sequences readable
    const n = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 1;
    if (n > 1 && i + n <= buf.length && isUtf8(buf.subarray(i, i + n))) { s += buf.subarray(i, i + n).toString('utf8'); i += n; continue; }
    if (b === 0x5c) s += '\\\\';
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x09) s += '\\t';
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += '\\x' + b.toString(16).padStart(2, '0');
    i += 1;
  }
  return s;
}

/** The bytes of a display string from display(): \xNN, \n, \r, \t, \\ and \" are decoded, the rest is UTF-8. */
function parseEscaped(s) {
  const parts = [];
  let text = '';
  const flush = () => { if (text) { parts.push(Buffer.from(text, 'utf8')); text = ''; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i === s.length - 1) { text += c; continue; }
    const d = s[i + 1];
    if (d === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) { flush(); parts.push(Buffer.from([parseInt(s.slice(i + 2, i + 4), 16)])); i += 3; continue; }
    const map = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', a: '\u0007', b: '\b' };
    if (d in map) { text += map[d]; i += 1; continue; }
    text += c;
  }
  flush();
  return Buffer.concat(parts);
}

function hex(buf, max = Infinity) {
  buf = toBuf(buf);
  const cut = buf.length > max ? buf.subarray(0, max) : buf;
  return cut.toString('hex').replace(/(..)(?!$)/g, '$1 ');
}

function parseHex(s) {
  const clean = String(s).replace(/0x/gi, '').replace(/[\s,:]/g, '');
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean)) throw Object.assign(new Error('Hex must be pairs of 0-9 and a-f, for example "de ad be ef".'), { friendly: true });
  return Buffer.from(clean, 'hex');
}

/** The form a value travels in to a webview: text when it is valid UTF-8, plus base64 for the exact bytes. */
function wire(buf, maxText = 1 << 20) {
  buf = toBuf(buf);
  const utf8 = isUtf8(buf);
  return { b64: buf.toString('base64'), len: buf.length, utf8, text: utf8 ? (buf.length > maxText ? buf.subarray(0, maxText).toString('utf8') : buf.toString('utf8')) : display(buf, maxText) };
}

function humanBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

module.exports = { isUtf8, toBuf, toId, fromId, display, escapeBytes, parseEscaped, hex, parseHex, wire, humanBytes };
