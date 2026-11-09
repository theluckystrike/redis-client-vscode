'use strict';
// Console, server info, pub/sub and the memory report pages.
const { rpc, onMessage, h, data, humanBytes, ttlText, status } = require('./lib');

function consolePage(app) {
  const d = data();
  const names = d.names || [];
  const history = (d.history || []).slice();
  let hi = history.length;
  let db = d.db || 0;
  const log = h('div', { class: 'console-log', role: 'log', 'aria-live': 'polite' });
  const prompt = h('span', { class: 'prompt' });
  const input = h('input', { class: 'console-input', spellcheck: 'false', autocomplete: 'off', list: 'cmd-names', placeholder: 'Type a command, for example SCAN 0 MATCH user:* COUNT 100. Tab completes, ↑ ↓ history.' });
  const dl = h('datalist', { id: 'cmd-names' });
  const hint = h('div', { class: 'help hint' });
  const setPrompt = () => { prompt.textContent = `${d.conn}${d.cluster ? '' : `[${db}]`}>`; };
  setPrompt();
  app.append(h('div', { class: 'console' },
    h('div', { class: 'toolbar' }, h('b', {}, `Console · ${d.conn}`), d.readOnly ? h('span', { class: 'pill ro' }, 'read-only') : null, h('span', { class: 'spacer' }),
      h('span', { class: 'meta' }, 'FLUSHALL, FLUSHDB, KEYS, DEBUG and SHUTDOWN ask first.'), h('button', { class: 'btn small', onclick: () => { log.textContent = ''; } }, 'Clear')),
    log, h('div', { class: 'console-line' }, prompt, input), dl, hint));
  const add = (cls, text) => { log.append(h('pre', { class: cls }, text)); log.scrollTop = log.scrollHeight; };
  async function run() {
    const line = input.value;
    if (!line.trim()) return;
    input.value = ''; hint.textContent = '';
    if (history[history.length - 1] !== line) history.push(line);
    hi = history.length;
    add('in', `${prompt.textContent} ${line}`);
    try {
      const r = await rpc('run', { line });
      if (r.error) add('err', `(error) ${r.error}`);
      else add('out', r.out);
      if (r.ms !== undefined) log.lastChild.title = `${r.ms} ms`;
      if (r.db !== undefined) { db = r.db; setPrompt(); }
    } catch (e) { add(e.cancelled ? 'meta' : 'err', e.cancelled ? '(not run)' : `(error) ${e.message}`); }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); return; }
    if (e.key === 'ArrowUp' && !e.shiftKey) { if (hi > 0) { hi--; input.value = history[hi]; } e.preventDefault(); return; }
    if (e.key === 'ArrowDown' && !e.shiftKey) { if (hi < history.length - 1) { hi++; input.value = history[hi]; } else { hi = history.length; input.value = ''; } e.preventDefault(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const v = input.value;
      if (/\s/.test(v.trimStart())) return;
      const p = v.trim().toLowerCase();
      const m = names.filter((n) => n.startsWith(p));
      if (m.length === 1) input.value = m[0].toUpperCase() + ' ';
      else if (m.length > 1) {
        let c = m[0];
        for (const x of m) while (!x.startsWith(c)) c = c.slice(0, -1);
        input.value = c.toUpperCase();
        hint.textContent = m.slice(0, 30).map((x) => x.toUpperCase()).join('  ') + (m.length > 30 ? '  …' : '');
      }
    }
  });
  input.addEventListener('input', () => {
    const v = input.value.trim().toLowerCase();
    dl.textContent = '';
    if (!v || /\s/.test(v)) return;
    for (const n of names.filter((x) => x.startsWith(v)).slice(0, 20)) dl.append(h('option', { value: n.toUpperCase() }));
  });
  input.focus();
}

function serverPage(app) {
  const d = data();
  const st = h('div', { class: 'status' });
  const nodeSel = h('select', { class: 'node-select' }, (d.nodes || []).map((n) => h('option', { value: n.id }, n.label)));
  const body = h('div', {});
  let tab = 'overview';
  let snap = null;
  const tabs = h('div', { class: 'seg' }, ['overview', 'info', 'slowlog', 'clients', ...(d.mode === 'cluster' ? ['cluster'] : [])].map((t) => h('button', { class: `seg-btn ${t === tab ? 'on' : ''}`, 'data-t': t, onclick: () => { tab = t; for (const b of tabs.children) b.classList.toggle('on', b.dataset.t === t); render(); } }, { overview: 'Overview', info: 'INFO', slowlog: 'Slow log', clients: 'Clients', cluster: 'Cluster nodes' }[t])));
  app.append(h('div', { class: 'toolbar' }, h('b', {}, `Server · ${d.conn}`), d.mode === 'cluster' ? nodeSel : null, tabs, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => load() }, 'Refresh')), st, body);
  nodeSel.addEventListener('change', () => load());
  const val = (k) => { for (const s of snap.info) for (const [a, b] of s.rows) if (a === k) return b; return ''; };
  async function load() {
    status(st, 'Loading…', 'busy');
    try { snap = await rpc('snapshot', { node: nodeSel.value }); status(st, `Updated ${new Date(snap.at).toLocaleTimeString()}${snap.infoError ? ` · INFO: ${snap.infoError}` : ''}`, ''); render(); } catch (e) { status(st, e.message, 'err'); }
  }
  const kv = (pairs) => h('table', { class: 'grid kv' }, h('tbody', {}, pairs.filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
  function render() {
    body.textContent = '';
    if (!snap) return;
    if (tab === 'overview') {
      const hits = Number(val('keyspace_hits')); const miss = Number(val('keyspace_misses'));
      body.append(h('div', { class: 'cards' },
        card('Server', [[val('valkey_version') ? 'Valkey' : 'Redis', val('valkey_version') || val('redis_version')], ['Mode', val('redis_mode')], ['Role', val('role')], ['Uptime', ttlText(Number(val('uptime_in_seconds')) * 1000)], snap.primary ? ['Primary (sentinel)', snap.primary] : ['', ''], ['OS', val('os')]]),
        card('Memory', [['Used', humanBytes(val('used_memory'))], ['Peak', humanBytes(val('used_memory_peak'))], ['RSS', humanBytes(val('used_memory_rss'))], ['Max', val('maxmemory') === '0' ? 'no limit' : humanBytes(val('maxmemory'))], ['Policy', val('maxmemory_policy')], ['Fragmentation', val('mem_fragmentation_ratio')]]),
        card('Activity', [['Clients', val('connected_clients')], ['Ops/s', val('instantaneous_ops_per_sec')], ['Commands', Number(val('total_commands_processed')).toLocaleString('en-US')], ['Hit rate', hits + miss ? `${((hits / (hits + miss)) * 100).toFixed(1)} %` : '–'], ['Expired keys', val('expired_keys')], ['Evicted keys', val('evicted_keys')]]),
        card('Keyspace', snap.keyspace.length ? snap.keyspace.map((k) => [`db${k.db}`, `${k.keys.toLocaleString('en-US')} keys · ${k.expires.toLocaleString('en-US')} with TTL`]) : [['', 'No keys']])));
    } else if (tab === 'info') {
      for (const s of snap.info) body.append(h('details', { open: ['Server', 'Memory', 'Stats', 'Keyspace'].includes(s.name) }, h('summary', {}, s.name), kv(s.rows)));
    } else if (tab === 'slowlog') {
      if (!snap.slowlog) { body.append(h('p', { class: 'help' }, `SLOWLOG is not available: ${snap.slowlogError || ''}`)); return; }
      if (!snap.slowlog.length) { body.append(h('p', { class: 'help' }, 'The slow log is empty.')); return; }
      body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['ID', 'When', 'Duration', 'Command', 'Client'].map((x) => h('th', {}, x)))),
        h('tbody', {}, snap.slowlog.map((e) => h('tr', {}, h('td', { class: 'num' }, e.id), h('td', {}, new Date(e.time * 1000).toLocaleString()), h('td', { class: 'num' }, `${(e.micros / 1000).toFixed(2)} ms`), h('td', { class: 'mono' }, e.args.join(' ').slice(0, 300)), h('td', {}, `${e.client} ${e.name}`))))));
    } else if (tab === 'clients') {
      if (!snap.clients) { body.append(h('p', { class: 'help' }, `CLIENT LIST is not available: ${snap.clientsError || ''}`)); return; }
      body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['ID', 'Address', 'Name', 'Age', 'Idle', 'DB', 'Last command'].map((x) => h('th', {}, x)))),
        h('tbody', {}, snap.clients.map((c) => h('tr', {}, h('td', { class: 'num' }, c.id), h('td', {}, c.addr), h('td', {}, c.name), h('td', { class: 'num' }, ttlText(Number(c.age) * 1000)), h('td', { class: 'num' }, ttlText(Number(c.idle) * 1000)), h('td', { class: 'num' }, c.db), h('td', { class: 'mono' }, c.cmd))))));
    } else if (tab === 'cluster' && snap.cluster) {
      body.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Node', 'Role', 'State', 'Slots', 'ID'].map((x) => h('th', {}, x)))),
        h('tbody', {}, snap.cluster.map((n) => h('tr', { class: n.flags.includes('fail') ? 'bad' : '' }, h('td', {}, n.addr), h('td', {}, n.flags.filter((f) => f !== 'myself').join(', ')), h('td', {}, n.connected ? 'connected' : 'disconnected'), h('td', { class: 'mono' }, n.slots), h('td', { class: 'mono' }, n.id.slice(0, 12)))))));
    }
  }
  const card = (title, pairs) => h('div', { class: 'card' }, h('h3', {}, title), kv(pairs));
  load();
}

function pubsubPage(app) {
  const d = data();
  const st = h('div', { class: 'status' });
  const ch = h('input', { class: 'edit', placeholder: 'channel, or a pattern such as news.*' });
  const isPat = h('input', { type: 'checkbox', id: 'pat' });
  const subs = h('div', { class: 'subs' });
  const log = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Time', 'Channel', 'Message'].map((x) => h('th', {}, x)))));
  const tbody = h('tbody', {});
  log.append(tbody);
  const pubCh = h('input', { class: 'edit', placeholder: 'channel' });
  const pubMsg = h('input', { class: 'edit', placeholder: 'message' });
  let count = 0;
  const counter = h('span', { class: 'meta' }, '0 messages');
  let paused = false;
  const active = new Set();
  const renderSubs = () => { subs.textContent = ''; for (const k of active) { const [p, name] = [k[0] === 'p', k.slice(2)]; subs.append(h('span', { class: 'pill' }, `${p ? 'pattern ' : ''}${name}`, h('button', { class: 'icon', title: 'Unsubscribe', onclick: async () => { try { await rpc('unsubscribe', { channel: name, pattern: p }); active.delete(k); renderSubs(); } catch (e) { status(st, e.message, 'err'); } } }, '✕'))); } };
  app.append(h('div', { class: 'toolbar' }, h('b', {}, `Pub/Sub · ${d.conn}`), h('span', { class: 'spacer' }), counter,
    h('button', { class: 'btn small', onclick: (e) => { paused = !paused; e.target.textContent = paused ? 'Resume' : 'Pause'; } }, 'Pause'),
    h('button', { class: 'btn small', onclick: () => { tbody.textContent = ''; count = 0; counter.textContent = '0 messages'; } }, 'Clear')),
  h('div', { class: 'add-row' }, h('span', { class: 'meta' }, 'Subscribe'), ch, isPat, h('label', { for: 'pat' }, 'pattern'),
    h('button', { class: 'btn small', onclick: async () => { try { await rpc('subscribe', { channel: ch.value, pattern: isPat.checked }); active.add(`${isPat.checked ? 'p' : 'c'}:${ch.value}`); renderSubs(); status(st, `Listening on ${ch.value}.`, 'ok'); } catch (e) { status(st, e.message, 'err'); } } }, 'Subscribe')),
  subs,
  d.readOnly ? null : h('div', { class: 'add-row' }, h('span', { class: 'meta' }, 'Publish'), pubCh, pubMsg, h('button', { class: 'btn small', onclick: async () => { try { const n = await rpc('publish', { channel: pubCh.value, message: pubMsg.value }); status(st, `Published to ${n} subscriber${n === 1 ? '' : 's'}.`, 'ok'); } catch (e) { status(st, e.message, 'err'); } } }, 'Publish')),
  st, log);
  onMessage((m) => {
    if (!m || m.type !== 'messages' || paused) return;
    for (const x of m.list) {
      count++;
      tbody.prepend(h('tr', {}, h('td', { class: 'mono' }, new Date(x.at).toLocaleTimeString()), h('td', {}, x.pattern ? `${x.channel} (${x.pattern})` : x.channel), h('td', { class: 'mono' }, x.message.text)));
    }
    while (tbody.children.length > 2000) tbody.lastChild.remove();
    counter.textContent = `${count.toLocaleString('en-US')} messages`;
  });
}

function memoryPage(app) {
  const d = data();
  const r = d.report;
  app.append(h('div', { class: 'toolbar' }, h('b', {}, `Memory analysis · ${d.title}`), h('span', { class: 'pill pro' }, 'Zovo Pro'), h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => rpc('markdown', {}) }, 'Open as Markdown')),
    h('p', {}, `Sampled ${r.sampled.toLocaleString('en-US')} of ${r.totalKeys.toLocaleString('en-US')} keys with MEMORY USAGE: they use ${humanBytes(r.bytes)}. All keys use about ${humanBytes(r.estimatedBytes)}.${r.missing ? ` ${r.missing} keys were gone before they could be measured.` : ''}`),
    h('h3', {}, 'Key patterns by memory'),
    h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Pattern', 'Keys', 'Memory', 'Share', 'Average', 'Largest', 'Types'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.patterns.map((p) => h('tr', {}, h('td', { class: 'mono' }, p.pattern), h('td', { class: 'num' }, p.count.toLocaleString('en-US')), h('td', { class: 'num' }, humanBytes(p.bytes)), h('td', { class: 'num' }, h('span', { class: 'bar', style: `--w:${Math.round(p.share * 100)}%` }), `${(p.share * 100).toFixed(1)} %`), h('td', { class: 'num' }, humanBytes(p.avg)), h('td', { class: 'num' }, humanBytes(p.max)), h('td', {}, p.types))))),
    h('h3', {}, 'Biggest keys'),
    h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Key', 'Type', 'Memory'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.biggest.map((b) => h('tr', {}, h('td', { class: 'mono' }, h('a', { href: '#', class: 'link', onclick: (e) => { e.preventDefault(); rpc('open', { id: b.id }); } }, b.text)), h('td', {}, b.type), h('td', { class: 'num' }, humanBytes(b.bytes)))))),
    h('h3', {}, 'By type'),
    h('table', { class: 'grid small' }, h('thead', {}, h('tr', {}, ['Type', 'Keys', 'Memory'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.types.map((t) => h('tr', {}, h('td', {}, t.type), h('td', { class: 'num' }, t.count.toLocaleString('en-US')), h('td', { class: 'num' }, humanBytes(t.bytes)))))));
}

module.exports = { consolePage, serverPage, pubsubPage, memoryPage };
