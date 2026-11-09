'use strict';
const { rpc, h, status } = require('./lib');

async function formPage(app) {
  const init = await rpc('init', {});
  const c = init.conn || { mode: 'standalone', host: '127.0.0.1', port: 6379, db: 0, separator: ':' };
  let pwTouched = false; let spwTouched = false;
  const f = (id, label, input, help) => h('div', { class: `row row-${id}` }, h('label', { for: `f-${id}` }, label), input, help ? h('div', { class: 'help' }, help) : null);
  const inp = (id, value, attrs = {}) => h('input', { id: `f-${id}`, value: value ?? '', ...attrs });
  const st = h('div', { class: 'status form-status', role: 'status' });
  const url = inp('url', '', { placeholder: 'redis://user:password@host:6379/0  ·  rediss://…  ·  redis+sentinel://host:26379/mymaster' });
  const modeBtns = ['standalone', 'cluster', 'sentinel'].map((m) => h('button', { class: `seg-btn ${c.mode === m ? 'on' : ''}`, 'data-mode': m, type: 'button', onclick: () => setMode(m) }, { standalone: 'Single node', cluster: 'Cluster', sentinel: 'Sentinel' }[m]));
  const pw = inp('password', '', { type: 'password', placeholder: init.hasPassword ? '(saved; type to replace)' : 'none', autocomplete: 'off', oninput: () => { pwTouched = true; } });
  const spw = inp('sentinelPassword', '', { type: 'password', placeholder: init.hasSentinelPassword ? '(saved; type to replace)' : 'none', autocomplete: 'off', oninput: () => { spwTouched = true; } });
  const tls = inp('tls', '', { type: 'checkbox', checked: !!c.tls, onchange: () => sync() });
  const insecure = inp('tlsInsecure', '', { type: 'checkbox', checked: !!c.tlsInsecure });
  const ro = inp('readOnly', '', { type: 'checkbox', checked: !!c.readOnly });
  const savePw = inp('savePassword', '', { type: 'checkbox', checked: c.savePassword !== false });
  const ca = inp('caFile', c.caFile || '', { placeholder: 'optional: the CA certificate of a private or self-signed server (PEM)' });
  const els = {
    name: inp('name', c.name || '', { placeholder: 'shown in the tree' }),
    host: inp('host', c.host || '127.0.0.1'), port: inp('port', c.port || 6379, { type: 'number', min: 1, max: 65535 }),
    user: inp('user', c.user || '', { placeholder: 'default', autocomplete: 'off' }),
    db: inp('db', c.db || 0, { type: 'number', min: 0 }),
    nodes: h('textarea', { id: 'f-nodes', rows: 2, placeholder: '10.0.0.1:7000, 10.0.0.2:7000' }, c.nodes || ''),
    sentinels: h('textarea', { id: 'f-sentinels', rows: 2, placeholder: '10.0.0.1:26379, 10.0.0.2:26379' }, c.sentinels || ''),
    sentinelName: inp('sentinelName', c.sentinelName || 'mymaster'),
    sentinelUser: inp('sentinelUser', c.sentinelUser || '', { placeholder: 'only when the sentinels have their own ACL user' }),
    tlsServername: inp('tlsServername', c.tlsServername || '', { placeholder: 'optional: the name on the certificate when you connect by IP' }),
    separator: inp('separator', c.separator ?? ':', { maxlength: 8 }),
  };
  let mode = c.mode || 'standalone';
  const setMode = (m) => { mode = m; for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === m); sync(); };
  const sections = h('div', {});
  function sync() {
    for (const [k, show] of Object.entries({ host: mode === 'standalone', port: mode === 'standalone', db: mode !== 'cluster', nodes: mode === 'cluster', sentinels: mode === 'sentinel', sentinelName: mode === 'sentinel', sentinelUser: mode === 'sentinel', sentinelPassword: mode === 'sentinel', caFile: tls.checked, tlsInsecure: tls.checked, tlsServername: tls.checked })) {
      const row = app.querySelector(`.row-${k}`); if (row) row.style.display = show ? '' : 'none';
    }
  }
  const collect = () => ({
    conn: { mode, name: els.name.value, host: els.host.value, port: els.port.value, user: els.user.value, db: els.db.value, nodes: els.nodes.value, sentinels: els.sentinels.value, sentinelName: els.sentinelName.value, sentinelUser: els.sentinelUser.value, tls: tls.checked, tlsInsecure: insecure.checked, tlsServername: els.tlsServername.value, caFile: ca.value, readOnly: ro.checked, separator: els.separator.value, savePassword: savePw.checked },
    password: pwTouched ? pw.value : null, sentinelPassword: spwTouched ? spw.value : null,
  });
  const run = async (method) => {
    status(st, method === 'test' ? 'Connecting…' : 'Saving…', 'busy');
    try {
      const r = await rpc(method, collect());
      if (method === 'test') status(st, `✓ ${r.message}${r.steps && r.steps.length ? `  (${r.steps.join(' · ')})` : ''}`, 'ok');
    } catch (e) { status(st, e.message, 'err'); }
  };
  app.append(h('div', { class: 'form conn-form' },
    h('h2', {}, init.conn ? `Edit ${init.conn.name}` : 'New Redis connection'),
    h('p', { class: 'help' }, 'Redis, Valkey and KeyDB. The password goes to VS Code\'s secret storage. The extension connects only to this server; nothing else is sent anywhere.'),
    h('div', { class: 'row url-row' }, h('label', { for: 'f-url' }, 'Paste a URL'), h('div', { class: 'inline' }, url, h('button', { class: 'btn', type: 'button', onclick: async () => {
      try {
        const r = await rpc('parseUrl', { url: url.value });
        const x = r.conn; setMode(x.mode);
        els.host.value = x.host || ''; els.port.value = x.port || 6379; els.user.value = x.user || ''; els.db.value = x.db || 0;
        els.nodes.value = x.nodes || ''; els.sentinels.value = x.sentinels || ''; els.sentinelName.value = x.sentinelName || 'mymaster';
        tls.checked = !!x.tls; if (r.password) { pw.value = r.password; pwTouched = true; }
        sync(); status(st, 'Filled in from the URL.', 'ok');
      } catch (e) { status(st, e.message, 'err'); }
    } }, 'Fill in'))),
    h('div', { class: 'row' }, h('label', {}, 'Type'), h('div', { class: 'seg' }, modeBtns)),
    f('name', 'Name', els.name),
    f('host', 'Host', els.host), f('port', 'Port', els.port),
    f('nodes', 'Cluster nodes', els.nodes, 'One or more nodes as host:port. The rest of the cluster is found from them.'),
    f('sentinels', 'Sentinels', els.sentinels, 'host:port of the sentinels (often port 26379).'),
    f('sentinelName', 'Primary name', els.sentinelName, 'The name in "sentinel monitor <name> …".'),
    f('user', 'User', els.user, 'Redis 6+ ACL user. Leave empty for the default user.'),
    f('password', 'Password', pw),
    f('sentinelUser', 'Sentinel user', els.sentinelUser),
    f('sentinelPassword', 'Sentinel password', spw, 'Only when the sentinels have their own password.'),
    f('db', 'Database', els.db, 'The database the tree opens with (0-15 on most servers). Databases with keys are listed too.'),
    h('div', { class: 'row check' }, tls, h('label', { for: 'f-tls' }, 'TLS (rediss://)')),
    h('div', { class: 'row row-caFile' }, h('label', { for: 'f-caFile' }, 'CA file'), h('div', { class: 'inline' }, ca, h('button', { class: 'btn', type: 'button', onclick: async () => { const p = await rpc('browseCa', {}); if (p) ca.value = p; } }, 'Browse…'))),
    f('tlsServername', 'TLS server name', els.tlsServername),
    h('div', { class: 'row check row-tlsInsecure' }, insecure, h('label', { for: 'f-tlsInsecure' }, 'Allow a certificate that cannot be verified (tests only)')),
    f('separator', 'Key separator', els.separator, 'Groups keys into folders in the tree. Empty = a flat list.'),
    h('div', { class: 'row check' }, ro, h('label', { for: 'f-readOnly' }, 'Read-only: refuse every write on this connection')),
    h('div', { class: 'row check' }, savePw, h('label', { for: 'f-savePassword' }, 'Save the password (else asked once per window)')),
    h('div', { class: 'buttons' },
      h('button', { class: 'btn', type: 'button', onclick: () => run('test') }, 'Test connection'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => run('save') }, init.conn ? 'Save' : 'Save connection'),
      h('button', { class: 'btn', type: 'button', onclick: () => rpc('cancel', {}) }, 'Cancel')),
    st));
  sync();
}

module.exports = { formPage };
