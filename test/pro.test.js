'use strict';
// Zovo Pro gate: 3 free tries per tool, then requirePro. A fake vscode and context, no network.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function fakeVscode(log) {
  const ev = () => ({ event: () => ({ dispose() {} }), fire() {}, dispose() {} });
  return {
    EventEmitter: function () { return ev(); },
    Uri: { parse: (u) => ({ toString: () => u }) },
    env: { openExternal: async (u) => { log.push(['open', String(u)]); return true; }, uriScheme: 'vscode', appName: 'Visual Studio Code' },
    window: {
      setStatusBarMessage: (m) => { log.push(['status', m]); return { dispose() {} }; },
      showInformationMessage: async (m, ...a) => { log.push(['info', m, a]); return undefined; },
      showWarningMessage: async (m, ...a) => { log.push(['warn', m, a]); return undefined; },
      showErrorMessage: async (m) => { log.push(['error', m]); },
      showInputBox: async () => undefined,
      onDidChangeWindowState: () => ({ dispose() {} }),
    },
    authentication: { getSession: async () => undefined },
    commands: { registerCommand: (id) => { log.push(['cmd', id]); return { dispose() {} }; } },
  };
}
function fakeContext() {
  const m = new Map(); const sec = new Map();
  return {
    subscriptions: [],
    globalState: { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()], setKeysForSync() {} },
    secrets: { get: async (k) => sec.get(k), store: async (k, v) => { sec.set(k, v); }, delete: async (k) => { sec.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  };
}

test('3 free tries per Pro tool, then one modal with USD 19; nothing on Escape', async () => {
  const log = [];
  const vscode = fakeVscode(log);
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : orig.call(this, req, ...rest); };
  try {
    delete require.cache[require.resolve('../src/pro')];
    const pro = require('../src/pro');
    assert.strictEqual(pro.PRO_ENABLED, true);
    assert.strictEqual(pro.FREE_TRIES, 3);
    const ctx = fakeContext();
    const api = pro.createPro(vscode, ctx);
    for (let i = 1; i <= 3; i++) assert.strictEqual(await api.allow('Memory Analysis', 'x'), true, `try ${i}`);
    assert.ok(log.some(([k, m]) => k === 'status' && /Free try 3 of 3/.test(m)));
    assert.strictEqual(await api.allow('Bulk TTL and Delete', 'x'), true, 'tries count per tool');
    const before = log.length;
    assert.strictEqual(await api.allow('Memory Analysis', 'x'), false, '4th try: modal, Escape = no');
    const modal = log.slice(before).find(([k]) => k === 'warn' || k === 'info');
    assert.ok(modal, 'one modal');
    assert.match(JSON.stringify(modal), /USD 19|\$19/);
    assert.ok(!/USD 15/.test(JSON.stringify(log)));
    assert.ok(log.some(([k, id]) => k === 'cmd' && id === 'redisClient.unlockWithSponsors'));
  } finally { Module._load = orig; }
});
