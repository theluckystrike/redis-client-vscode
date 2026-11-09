'use strict';
// Key editor: header (type, TTL, size, memory on demand), then an editor per type.
// Values arrive as {b64, len, utf8, text}; edits go back as {enc: 'text' | 'hex', v}. Binary values edit as hex.
const { rpc, h, data, humanBytes, ttlText, b64hex, status, ask } = require('./lib');

const TYPE_LABEL = { string: 'String', hash: 'Hash', list: 'List', set: 'Set', zset: 'Sorted set', stream: 'Stream', 'ReJSON-RL': 'JSON' };

function keyPage(app) {
  const d = data();
  let state = null; // last load result
  let rows = []; let cursor = '0'; let match = ''; let lastId = '+'; let done = false;
  const st = h('div', { class: 'status', role: 'status' });
  const head = h('div', { class: 'key-head' });
  const body = h('div', { class: 'key-body' });
  app.append(head, st, body);
  const err = (e) => { if (!e.cancelled) status(st, e.message, 'err'); };
  const ok = (t) => status(st, t, 'ok');

  const valueText = (v) => (v.big ? `${v.text}  (${humanBytes(v.len)}, cut)` : v.utf8 ? v.text : v.text);
  const valueCell = (v) => h('span', { class: `val ${v.utf8 ? '' : 'bin'} ${v.big ? 'big' : ''}`, title: v.utf8 ? '' : 'binary: shown with \\xNN escapes' }, valueText(v));
  /** an editor for one value: text when it is UTF-8, else hex */
  function editor(v, rowsN = 3) {
    const bin = v && !v.utf8;
    const ta = h('textarea', { class: `edit ${bin ? 'hex' : ''}`, rows: rowsN, spellcheck: 'false' });
    ta.value = v ? (bin ? b64hex(v.b64) : v.text) : '';
    ta.enc = bin ? 'hex' : 'text';
    return ta;
  }
  const out = (ta) => ({ enc: ta.enc, v: ta.value });

  async function load(keep) {
    status(st, 'Loading…', 'busy');
    try {
      state = await rpc('load', keep ? { cursor: '0', match } : {});
      status(st, '', '');
      renderHead();
      reset();
      renderBody(state.page);
    } catch (e) { err(e); }
  }
  function reset() { rows = []; cursor = '0'; lastId = '+'; done = false; }

  function renderHead() {
    const i = state.info;
    head.textContent = '';
    const ro = state.readOnly;
    const keyName = h('code', { class: 'key-name', title: 'Key name (\\xNN = a byte that is not text)' }, state.key.text);
    if (!i.exists) { head.append(h('div', {}, keyName, h('span', { class: 'pill warn' }, 'This key does not exist (it expired or was deleted).'))); body.textContent = ''; return; }
    const mem = h('span', { class: 'meta' }, h('a', { href: '#', class: 'link', onclick: async (e) => { e.preventDefault(); try { const b = await rpc('memory', {}); mem.textContent = `memory ${b === null ? '?' : humanBytes(b)}`; } catch (x) { err(x); } } }, 'memory?'));
    const ttlBtn = h('button', { class: 'btn small', disabled: ro, onclick: async () => {
      const v = await ask('TTL in seconds (empty = no TTL, the key stays)', i.pttl > 0 ? String(Math.round(i.pttl / 1000)) : '');
      if (v === null) return;
      try { await rpc('ttl', { seconds: v.trim() === '' ? -1 : v.trim() }); ok(v.trim() === '' ? 'TTL removed.' : `TTL set to ${v.trim()} s.`); load(); } catch (e) { err(e); }
    } }, 'TTL…');
    const renameBtn = h('button', { class: 'btn small', disabled: ro, onclick: async () => {
      const v = await ask('New key name (\\xNN for a byte that is not text)', state.key.text);
      if (v === null || v === state.key.text) return;
      try { const r = await rpc('rename', { newKey: { enc: 'esc', v } }); ok('Renamed.'); state.key = r.key; renderHead(); } catch (e) { err(e); }
    } }, 'Rename…');
    const delBtn = h('button', { class: 'btn small danger', disabled: ro, onclick: async () => { try { await rpc('delete', {}); } catch (e) { err(e); } } }, 'Delete key');
    head.append(
      h('div', { class: 'key-line' }, h('span', { class: `pill t-${i.type}` }, TYPE_LABEL[i.type] || i.type), keyName),
      h('div', { class: 'key-meta' },
        h('span', { class: 'meta' }, `${state.conn} · db${state.db}`),
        h('span', { class: 'meta ttl' }, `TTL ${ttlText(i.pttl)}`),
        i.size !== null && i.size !== undefined ? h('span', { class: 'meta' }, i.type === 'string' ? humanBytes(i.size) : i.type === 'ReJSON-RL' ? humanBytes(i.size) : `${Number(i.size).toLocaleString('en-US')} ${i.type === 'hash' ? 'fields' : i.type === 'stream' ? 'entries' : i.type === 'zset' || i.type === 'set' ? 'members' : 'items'}`) : null,
        i.encoding ? h('span', { class: 'meta' }, i.encoding) : null,
        mem,
        ro ? h('span', { class: 'pill ro' }, 'read-only') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => load() }, 'Refresh'), ttlBtn, renameBtn, delBtn));
  }

  function renderBody(page) {
    body.textContent = '';
    const t = state.info.type;
    if (!state.info.exists) return;
    if (page && page.unsupported) { body.append(h('p', {}, `The type "${page.unsupported}" has no editor yet. Use the console.`)); return; }
    if (t === 'string') return stringView(page);
    if (t === 'ReJSON-RL') return jsonView(page);
    if (t === 'stream') return streamView(page);
    return collectionView(t, page);
  }

  function stringView(page) {
    const ro = state.readOnly;
    if (page.tooLarge) {
      const pre = h('pre', { class: 'value-pre' });
      body.append(h('div', { class: 'notice' },
        h('p', {}, `This value is ${humanBytes(page.len)}, more than the ${state.maxValueMB} MB that open in the editor (setting redisClient.maxValueSizeMB). It was not loaded.`),
        h('div', { class: 'buttons' },
          h('button', { class: 'btn', onclick: async () => { try { const v = await rpc('head', { bytes: 65536 }); pre.textContent = v.utf8 ? v.text : v.text; ok(`First ${humanBytes(v.len)} shown.`); } catch (e) { err(e); } } }, 'Show the first 64 KB'),
          h('button', { class: 'btn', onclick: async () => { try { await rpc('saveToFile', {}); } catch (e) { err(e); } } }, 'Save to a file…'))), pre);
      return;
    }
    const v = page.value;
    let mode = v.utf8 ? 'text' : 'hex';
    let json = null;
    if (v.utf8) { try { const p = JSON.parse(v.text); if (p && typeof p === 'object') json = p; } catch { /* not JSON */ } }
    if (json) mode = 'json';
    const ta = h('textarea', { class: 'edit big', rows: 18, spellcheck: 'false', readonly: ro });
    const tabs = h('div', { class: 'seg' });
    const set = (m) => {
      if (m === 'text' && !v.utf8) { status(st, 'This value is not valid UTF-8 text. It is shown and edited as hex so no byte changes by accident.', 'warn'); return; }
      mode = m;
      ta.value = m === 'hex' ? b64hex(v.b64) : m === 'json' ? JSON.stringify(json, null, 2) : v.text;
      ta.classList.toggle('hex', m === 'hex');
      for (const b of tabs.children) b.classList.toggle('on', b.dataset.m === m);
    };
    for (const m of ['text', 'json', 'hex']) if (m !== 'json' || json) tabs.append(h('button', { class: 'seg-btn', 'data-m': m, onclick: () => set(m) }, { text: 'Text', json: 'JSON', hex: 'Hex' }[m]));
    set(mode);
    const save = h('button', { class: 'btn primary', disabled: ro, onclick: async () => {
      let value;
      if (mode === 'json') { try { value = { enc: 'text', v: JSON.stringify(JSON.parse(ta.value)) }; } catch (e) { status(st, `Not valid JSON: ${e.message}`, 'err'); return; } }
      else value = { enc: mode === 'hex' ? 'hex' : 'text', v: ta.value };
      try { await rpc('saveString', { value }); ok('Saved. The TTL was kept.'); load(); } catch (e) { err(e); }
    } }, 'Save');
    body.append(h('div', { class: 'toolbar' }, tabs, h('span', { class: 'meta' }, `${humanBytes(v.len)}${v.utf8 ? '' : ' · binary'}`), h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => rpc('copy', { b64: v.b64 }) }, 'Copy value'), save), ta,
    mode === 'json' ? h('p', { class: 'help' }, 'JSON view: Save writes the JSON compact. Use Text to keep your own formatting.') : null);
  }

  function jsonView(page) {
    const ro = state.readOnly;
    let txt = page.json;
    try { txt = JSON.stringify(JSON.parse(page.json), null, 2); } catch { /* keep */ }
    const ta = h('textarea', { class: 'edit big', rows: 20, spellcheck: 'false', readonly: ro });
    ta.value = txt;
    body.append(h('div', { class: 'toolbar' }, h('span', { class: 'meta' }, 'RedisJSON document'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', disabled: ro, onclick: async () => { try { await rpc('jsonSet', { text: ta.value }); ok('Saved with JSON.SET.'); load(); } catch (e) { err(e); } } }, 'Save')), ta);
  }

  function collectionView(t, page) {
    const ro = state.readOnly;
    const table = h('table', { class: 'grid' });
    const cols = { hash: ['Field', 'Value'], list: ['#', 'Value'], set: ['Member'], zset: ['#', 'Score', 'Member'] }[t];
    table.append(h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)), h('th', { class: 'act' }, ''))));
    const tbody = h('tbody', {});
    table.append(tbody);
    const more = h('button', { class: 'btn', onclick: () => next() }, 'Load more');
    const count = h('span', { class: 'meta' });
    const filter = (t === 'hash' || t === 'set') ? h('input', { class: 'filter', placeholder: t === 'hash' ? 'Filter fields (glob, HSCAN MATCH)' : 'Filter members (glob, SSCAN MATCH)', value: match, onkeydown: (e) => { if (e.key === 'Enter') { match = e.target.value; reset(); tbody.textContent = ''; next(true); } } }) : null;
    const add = addForm(t);
    body.append(h('div', { class: 'toolbar' }, filter, count, h('span', { class: 'spacer' })), add, table, h('div', { class: 'more-row' }, more));
    function append(page2) {
      const list = page2.rows;
      const seen = new Set(rows.map((r) => rowId(t, r)));
      for (const r of list) {
        const idx = t === 'list' || t === 'zset' ? rows.length : null;
        const row = t === 'list' || t === 'zset' ? { r, idx } : { r };
        if (t === 'hash' || t === 'set') { const id = rowId(t, row); if (seen.has(id)) continue; seen.add(id); }
        rows.push(row);
        tbody.append(renderRow(t, row, ro));
      }
      if (t === 'hash' || t === 'set') { cursor = page2.cursor; done = cursor === '0'; } else done = !page2.more;
      more.style.display = done ? 'none' : '';
      count.textContent = `${rows.length.toLocaleString('en-US')} of ${Number(state.info.size).toLocaleString('en-US')} shown`;
    }
    async function next(fromStart) {
      try {
        const p = t === 'hash' || t === 'set' ? { type: t, cursor: fromStart ? '0' : cursor, match } : { type: t, start: rows.length };
        append(await rpc('page', p));
      } catch (e) { err(e); }
    }
    append(page);
  }

  function rowId(t, row) { return t === 'hash' ? row.r[0].b64 : t === 'set' ? row.r.b64 : String(row.idx); }

  function actions(ro, onEdit, onDel, copyB64) {
    return h('td', { class: 'act' },
      copyB64 ? h('button', { class: 'icon', title: 'Copy value', onclick: () => rpc('copy', { b64: copyB64 }) }, '⧉') : null,
      ro ? null : h('button', { class: 'icon', title: 'Edit', onclick: onEdit }, '✎'),
      ro ? null : h('button', { class: 'icon danger', title: 'Delete', onclick: onDel }, '✕'));
  }

  function renderRow(t, row, ro) {
    const tr = h('tr', {});
    const r = row.r;
    const bigMsg = () => status(st, 'This value is over 1 MB. Edit it from the console, or save the key to a file with Export.', 'warn');
    if (t === 'hash') {
      tr.append(h('td', {}, valueCell(r[0])), h('td', {}, valueCell(r[1])), actions(ro, () => {
        if (r[1].big || r[0].big) return bigMsg();
        const fe = editor(r[0], 1); const ve = editor(r[1], 3);
        inlineEdit(tr, [fe, ve], async () => {
          const changedName = fe.value !== (r[0].utf8 ? r[0].text : b64hex(r[0].b64));
          await rpc('hset', { field: out(fe), value: out(ve), oldField: changedName ? r[0].b64 : undefined });
        });
      }, async () => { try { await rpc('hdel', { field: r[0].b64 }); tr.remove(); ok('Field deleted.'); } catch (e) { err(e); } }, r[1].big ? null : r[1].b64));
    } else if (t === 'list') {
      tr.append(h('td', { class: 'num' }, row.idx), h('td', {}, valueCell(r)), actions(ro, () => {
        if (r.big) return bigMsg();
        const ve = editor(r, 3);
        inlineEdit(tr, [ve], () => rpc('lset', { index: row.idx, old: r.b64, value: out(ve) }));
      }, async () => { try { await rpc('ldel', { index: row.idx, old: r.b64 }); ok('Item deleted.'); load(true); } catch (e) { err(e); } }, r.big ? null : r.b64));
    } else if (t === 'set') {
      tr.append(h('td', {}, valueCell(r)), actions(ro, () => {
        if (r.big) return bigMsg();
        const ve = editor(r, 2);
        inlineEdit(tr, [ve], () => rpc('sreplace', { old: r.b64, member: out(ve) }));
      }, async () => { try { await rpc('srem', { member: r.b64 }); tr.remove(); ok('Member removed.'); } catch (e) { err(e); } }, r.big ? null : r.b64));
    } else if (t === 'zset') {
      tr.append(h('td', { class: 'num' }, row.idx), h('td', { class: 'num' }, r[1]), h('td', {}, valueCell(r[0])), actions(ro, () => {
        if (r[0].big) return bigMsg();
        const se = h('input', { class: 'edit', value: r[1] }); const me = editor(r[0], 2);
        inlineEdit(tr, [se, me], () => rpc('zadd', { old: r[0].b64, member: out(me), score: se.value.trim() }));
      }, async () => { try { await rpc('zrem', { member: r[0].b64 }); tr.remove(); ok('Member removed.'); } catch (e) { err(e); } }, r[0].big ? null : r[0].b64));
    }
    return tr;
  }

  function inlineEdit(tr, inputs, save) {
    const n = tr.children.length;
    const td = h('td', { colspan: n, class: 'editing' });
    const keep = [...tr.children];
    tr.textContent = '';
    td.append(...inputs.map((x, i) => h('div', { class: 'edit-row' }, h('span', { class: 'meta' }, inputs.length > 1 ? (i === 0 ? (state.info.type === 'zset' ? 'Score' : 'Field') : (state.info.type === 'zset' ? 'Member' : 'Value')) : 'Value'), x, x.enc === 'hex' ? h('span', { class: 'meta' }, 'hex') : null)),
      h('div', { class: 'buttons' },
        h('button', { class: 'btn primary', onclick: async () => { try { await save(); ok('Saved.'); load(true); } catch (e) { err(e); } } }, 'Save'),
        h('button', { class: 'btn', onclick: () => { tr.textContent = ''; tr.append(...keep); } }, 'Cancel')));
    tr.append(td);
    inputs[inputs.length - 1].focus();
  }

  function addForm(t) {
    if (state.readOnly) return h('div', {});
    const a = h('input', { class: 'edit', placeholder: { hash: 'new field', list: 'new item', set: 'new member', zset: 'new member' }[t] });
    const b = t === 'hash' ? h('input', { class: 'edit', placeholder: 'value' }) : t === 'zset' ? h('input', { class: 'edit score', placeholder: 'score', value: '0' }) : null;
    const go = async (tail) => {
      try {
        if (t === 'hash') await rpc('hset', { field: { enc: 'esc', v: a.value }, value: { enc: 'text', v: b.value }, isNew: true });
        if (t === 'list') await rpc('lpush', { value: { enc: 'text', v: a.value }, tail });
        if (t === 'set') await rpc('sadd', { member: { enc: 'esc', v: a.value } });
        if (t === 'zset') await rpc('zadd', { member: { enc: 'esc', v: a.value }, score: b.value.trim() });
        ok('Added.'); load(true);
      } catch (e) { err(e); }
    };
    return h('div', { class: 'add-row' }, h('span', { class: 'meta' }, 'Add'), a, b,
      t === 'list' ? [h('button', { class: 'btn small', onclick: () => go(false) }, 'Add to head'), h('button', { class: 'btn small', onclick: () => go(true) }, 'Add to tail')] : h('button', { class: 'btn small', onclick: () => go() }, 'Add'));
  }

  function streamView(page) {
    const ro = state.readOnly;
    const table = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Fields'), h('th', { class: 'act' }, ''))));
    const tbody = h('tbody', {});
    table.append(tbody);
    const more = h('button', { class: 'btn', onclick: async () => { try { append(await rpc('page', { type: 'stream', before: lastId })); } catch (e) { err(e); } } }, 'Load older entries');
    const count = h('span', { class: 'meta' });
    const groupsBox = h('div', { class: 'groups' });
    const fieldsIn = h('textarea', { class: 'edit', rows: 2, placeholder: 'field=value, one per line' });
    const add = ro ? null : h('div', { class: 'add-row' }, h('span', { class: 'meta' }, 'Add entry'), fieldsIn,
      h('button', { class: 'btn small', onclick: async () => {
        const fields = fieldsIn.value.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]; });
        if (!fields.length) { status(st, 'Type at least one field=value line.', 'err'); return; }
        try { const id = await rpc('xadd', { fields: fields.map(([f, v]) => [{ enc: 'esc', v: f }, { enc: 'text', v }]) }); ok(`Added ${id}.`); load(true); } catch (e) { err(e); }
      } }, 'XADD'));
    body.append(h('div', { class: 'toolbar' }, count, h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: async () => {
      groupsBox.textContent = 'Loading consumer groups…';
      try { renderGroups(groupsBox, await rpc('groups', {})); } catch (e) { groupsBox.textContent = ''; err(e); }
    } }, 'Consumer groups')), groupsBox, add, table, h('div', { class: 'more-row' }, more));
    function append(p) {
      for (const [id, fields] of p.rows) {
        const tr = h('tr', {}, h('td', { class: 'mono' }, id), h('td', {}, h('div', { class: 'fields' }, fields.map(([f, v]) => h('div', {}, h('span', { class: 'fname' }, valueText(f)), ' ', valueCell(v))))),
          h('td', { class: 'act' }, ro ? null : h('button', { class: 'icon danger', title: 'Delete entry', onclick: async () => { try { await rpc('xdel', { id }); tr.remove(); ok('Entry deleted.'); } catch (e) { err(e); } } }, '✕')));
        tbody.append(tr);
        rows.push(id);
        lastId = id;
      }
      more.style.display = p.rows.length ? '' : 'none';
      count.textContent = `${rows.length.toLocaleString('en-US')} of ${Number(state.info.size).toLocaleString('en-US')} entries shown, newest first`;
    }
    append(page);
  }

  function renderGroups(box, groups) {
    box.textContent = '';
    if (!groups.length) { box.append(h('p', { class: 'help' }, 'No consumer groups on this stream.')); return; }
    for (const g of groups) {
      box.append(h('div', { class: 'group' },
        h('div', {}, h('b', {}, g.name), h('span', { class: 'meta' }, ` · ${g.consumers} consumers · ${g.pending} pending · last delivered ${g['last-delivered-id']}${g.lag !== undefined && g.lag !== '' ? ` · lag ${g.lag}` : ''}`)),
        g.consumersList.length ? h('table', { class: 'grid small' }, h('thead', {}, h('tr', {}, h('th', {}, 'Consumer'), h('th', {}, 'Pending'), h('th', {}, 'Idle'))), h('tbody', {}, g.consumersList.map((c) => h('tr', {}, h('td', {}, c.name), h('td', { class: 'num' }, c.pending), h('td', { class: 'num' }, ttlText(Number(c.idle))))))) : null,
        g.pendingList.length ? h('details', {}, h('summary', {}, `First ${g.pendingList.length} pending entries`), h('table', { class: 'grid small' }, h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Consumer'), h('th', {}, 'Idle'), h('th', {}, 'Deliveries'))), h('tbody', {}, g.pendingList.map((p) => h('tr', {}, h('td', { class: 'mono' }, p.id), h('td', {}, p.consumer), h('td', { class: 'num' }, ttlText(p.idle)), h('td', { class: 'num' }, p.deliveries)))))) : null));
    }
  }

  load();
}

module.exports = { keyPage };
