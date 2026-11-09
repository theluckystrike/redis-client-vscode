'use strict';
// Zovo Pro tools in the Redis client: Memory Analysis (biggest keys and key patterns by sampled MEMORY USAGE)
// and Bulk TTL / Delete by Pattern (with a dry run first). Everything else is free and stays free:
// connections, cluster, sentinel, TLS, the key tree, every type editor, the console, server info, pub/sub,
// export and import, read-only mode.
// Each Pro tool can be tried 3 times; after that one quiet explanation offers the unlock (GitHub Sponsors or
// a license key, both checked without a server of ours). PRO_ENABLED = false makes both tools free.

const { createLicense } = require('./license');
const { MemoryReport } = require('./core/memory');
const { display, humanBytes, toBuf } = require('./core/bytes');

const PRO_ENABLED = true;
const FREE_TRIES = 3;
const SKU = 'redis-client-pro';
const TRIES_KEY = 'redisClient.proTries';

function createPro(vscode, context) {
  // name 'Zovo' makes the label "Zovo Pro": one purchase for every Zovo extension.
  const license = createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'redisClient', product: 'Redis Client' });

  /** True when the user may run the tool now (unlocked, a free try left, or unlocked in the dialog). */
  async function allow(feature, detail) {
    if (!PRO_ENABLED) return true;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh().catch(() => {}); return true; }
    const tries = context.globalState.get(TRIES_KEY, {});
    const used = Number(tries[feature] || 0);
    if (used < FREE_TRIES) {
      tries[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, tries);
      const left = FREE_TRIES - used - 1;
      vscode.window.setStatusBarMessage(`Redis Client: ${feature} is a Zovo Pro tool. Free try ${used + 1} of ${FREE_TRIES}${left ? ` (${left} left)` : ', the last one'}.`, 8000);
      return true;
    }
    return license.requirePro(feature, `${detail} You used your ${FREE_TRIES} free tries. Zovo Pro is USD 19 once and unlocks the Pro tools in every Zovo extension. The key tree, every editor, the console, cluster, sentinel, export and import stay free.`);
  }

  return { license, allow, enabled: PRO_ENABLED };
}

/**
 * Sample keys with SCAN and MEMORY USAGE. opts: {pattern, limit, separator, samples, shouldStop, onProgress}
 * Returns the MemoryReport result.
 */
async function analyzeMemory(session, db, opts = {}) {
  const rep = new MemoryReport(opts.separator ?? ':', 50);
  let state = null;
  let seen = 0;
  const limit = opts.limit || 10000;
  const total = await session.dbsize(db).catch(() => 0);
  do {
    const r = await session.scan(db, state, { pattern: opts.pattern || '*', count: 1000, limit: Math.min(1000, limit - seen) });
    state = r.state;
    if (r.keys.length) {
      const types = await session.types(db, r.keys);
      const sizes = await memoryBatch(session, db, r.keys, opts.samples ?? 5);
      r.keys.forEach((k, i) => rep.add(k, types[i], sizes[i]));
      seen += r.keys.length;
    }
    if (opts.onProgress) opts.onProgress(seen, total);
    if (r.done || (opts.shouldStop && opts.shouldStop())) break;
  } while (seen < limit);
  const keysMatched = opts.pattern && opts.pattern !== '*' ? seen : total;
  return rep.result(Math.max(keysMatched, rep.sampled));
}

async function memoryBatch(session, db, keys, samples) {
  if (session.mode === 'cluster') {
    return Promise.all(keys.map((k) => session.main.callBuffer('MEMORY', ['USAGE', k, 'SAMPLES', String(samples)]).then((x) => (x === null ? null : Number(String(x))), () => null)));
  }
  const c = await session.db(db);
  const p = c.pipeline();
  for (const k of keys) p.callBuffer('MEMORY', ['USAGE', k, 'SAMPLES', String(samples)]);
  const res = await p.exec();
  return res.map(([err, v]) => (err || v === null ? null : Number(String(v))));
}

/** Dry run: every key that matches, counted, with the first `show` of them listed. */
async function bulkDryRun(session, db, pattern, { show = 200, shouldStop, onProgress } = {}) {
  let state = null; let count = 0; const sample = [];
  do {
    const r = await session.scan(db, state, { pattern, count: 1000, limit: 1000 });
    state = r.state;
    for (const k of r.keys) { if (sample.length < show) sample.push(k); count++; }
    if (onProgress) onProgress(count);
    if (r.done || (shouldStop && shouldStop())) return { count, sample, complete: r.done };
  } while (true);
}

/**
 * Apply an action to every key that matches: 'delete' (UNLINK), 'expire' (seconds) or 'persist'.
 * Keys are scanned again and changed in batches of 500; returns {matched, changed}.
 */
async function bulkApply(session, db, pattern, action, seconds, { shouldStop, onProgress } = {}) {
  if (session.readOnly) throw Object.assign(new Error('This connection is read-only, so nothing was changed.'), { friendly: true, readOnly: true });
  let state = null; let matched = 0; let changed = 0;
  const one = (k) => {
    if (action === 'delete') return ['UNLINK', k];
    if (action === 'expire') return ['EXPIRE', k, String(seconds)];
    return ['PERSIST', k];
  };
  // SCAN may return a key twice; UNLINK, EXPIRE and PERSIST are safe to repeat.
  do {
    const r = await session.scan(db, state, { pattern, count: 1000, limit: 500 });
    state = r.state;
    matched += r.keys.length;
    if (r.keys.length) {
      if (session.mode === 'cluster') {
        const res = await Promise.all(r.keys.map((k) => session.main.callBuffer(...[one(k)[0], one(k).slice(1)]).then((x) => Number(String(x)) || 0, () => 0)));
        changed += res.reduce((a, b) => a + b, 0);
      } else {
        const c = await session.db(db);
        const p = c.pipeline();
        for (const k of r.keys) { const a = one(k); p.callBuffer(a[0], a.slice(1)); }
        const res = await p.exec();
        for (const [err, v] of res) if (!err) changed += Number(String(v)) || 0;
      }
    }
    if (onProgress) onProgress(matched, changed);
    if (r.done) break;
    if (shouldStop && shouldStop()) break;
  } while (true);
  return { matched, changed };
}

function dryRunMarkdown(conn, db, pattern, action, seconds, r) {
  const what = action === 'delete' ? 'delete' : action === 'expire' ? `set a TTL of ${seconds} s on` : 'remove the TTL of';
  const L = [`# Dry run: ${what} keys matching \`${pattern}\``, '', `Connection ${conn}, database ${db}. Nothing was changed.`, '',
    `${r.count.toLocaleString('en-US')} keys match${r.complete ? '' : ' so far (stopped early)'}. ${r.sample.length < r.count ? `The first ${r.sample.length} are listed.` : ''}`, '', '| Key |', '|---|'];
  for (const k of r.sample) L.push(`| \`${display(k, 200).replace(/\|/g, '\\|').replace(/`/g, '\\`')}\` |`);
  return L.join('\n') + '\n';
}

module.exports = { createPro, analyzeMemory, bulkDryRun, bulkApply, dryRunMarkdown, PRO_ENABLED, FREE_TRIES, SKU, humanBytes, toBuf };
