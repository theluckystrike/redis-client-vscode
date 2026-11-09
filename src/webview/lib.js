'use strict';
// Small DOM and RPC helpers shared by every page. No framework, no network.

// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();
let seq = 0;
const waiting = new Map();
const listeners = [];

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m && m.rpc && waiting.has(m.rpc)) {
    const { res, rej } = waiting.get(m.rpc);
    waiting.delete(m.rpc);
    if (m.ok) res(m.result); else rej(Object.assign(new Error(m.error), { readOnly: m.readOnly, cancelled: m.cancelled }));
    return;
  }
  for (const l of listeners) l(m);
});

function rpc(method, params) {
  const id = ++seq;
  return new Promise((res, rej) => { waiting.set(id, { res, rej }); vscode.postMessage({ rpc: id, method, params }); });
}

function onMessage(fn) { listeners.push(fn); }

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'style') e.style.cssText = v; // CSSOM: allowed by the CSP, unlike a style attribute
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

function data() {
  try { return JSON.parse(document.getElementById('zovo-data').textContent || '{}'); } catch { return {}; }
}

function humanBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

function ttlText(ms) {
  if (ms === -1 || ms === undefined || ms === null) return 'no TTL';
  if (ms === -2) return 'gone';
  let s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const hh = Math.floor(s / 3600); s -= hh * 3600;
  const mm = Math.floor(s / 60); s -= mm * 60;
  return [d ? `${d}d` : '', hh ? `${hh}h` : '', mm ? `${mm}m` : '', `${s}s`].filter(Boolean).slice(0, 2).join(' ');
}

/** base64 -> hex text "de ad be ef" */
function b64hex(b64) {
  const bin = atob(b64 || '');
  let out = '';
  for (let i = 0; i < bin.length; i++) out += (i ? ' ' : '') + bin.charCodeAt(i).toString(16).padStart(2, '0');
  return out;
}

function status(el, text, kind) {
  el.textContent = text || '';
  el.classList.add('status');
  el.classList.remove('ok', 'err', 'warn', 'busy');
  if (kind) el.classList.add(kind);
}

/** A small inline dialog (window.prompt does not work in webviews). Resolves the text, or null on Cancel/Escape. */
function ask(label, value) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'edit', value: value ?? '' });
    const close = (v) => { box.remove(); resolve(v); };
    const box = h('div', { class: 'ask-overlay' }, h('div', { class: 'ask', role: 'dialog', 'aria-label': label },
      h('label', {}, label), input,
      h('div', { class: 'buttons' }, h('button', { class: 'btn primary', onclick: () => close(input.value) }, 'OK'), h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'))));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value); if (e.key === 'Escape') close(null); });
    document.body.append(box);
    input.focus(); input.select();
  });
}

module.exports = { vscode, rpc, onMessage, h, data, humanBytes, ttlText, b64hex, status, ask };
