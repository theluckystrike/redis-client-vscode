'use strict';
// Step-by-step connection check before ioredis connects: DNS, then TCP, then TLS. Each step has its own
// time limit, so a failure names the step instead of a generic timeout.

const dns = require('dns');
const net = require('net');
const tls = require('tls');

function stepError(step, err, text, hint) {
  return Object.assign(err instanceof Error ? err : new Error(String(err)), { step, friendlyText: text, hint });
}

function withTimeout(p, ms, onTimeout) {
  let t;
  return Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(onTimeout()), ms); })]).finally(() => clearTimeout(t));
}

/**
 * opts: {host, port, tls: bool, ca, rejectUnauthorized, servername, timeoutMs}
 * Resolves {address, steps: [...]} or rejects with an error that has .step and .friendlyText.
 */
async function probe(opts) {
  const ms = opts.timeoutMs || 10000;
  const steps = [];
  const at = `${opts.host}:${opts.port}`;
  let addresses = [opts.host];
  if (!net.isIP(opts.host)) {
    try {
      const r = await withTimeout(dns.promises.lookup(opts.host, { all: true }), ms, () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      addresses = r.map((x) => x.address);
      steps.push(`DNS ${opts.host} -> ${addresses.join(', ')}`);
    } catch (e) {
      throw stepError('DNS', e, `DNS: the host name "${opts.host}" could not be resolved (${e.code || e.message}).`, 'Check the spelling, your VPN, or use the IP address.');
    }
  }
  // try each address in turn (localhost may resolve to ::1 and 127.0.0.1, and only one may listen)
  let sock = null;
  let address = addresses[0];
  let lastErr = null;
  for (const a of addresses) {
    try {
      sock = await withTimeout(new Promise((res, rej) => {
        const s = net.connect({ host: a, port: opts.port });
        s.once('connect', () => res(s));
        s.once('error', rej);
      }), ms, () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
      address = a;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!sock) {
    const e = lastErr;
    if (e.code === 'ETIMEDOUT') throw stepError('TCP', e, `TCP: no answer from ${at} within ${Math.round(ms / 1000)} s.`, 'A firewall may drop the packets, or the port is wrong. A cloud server may need your IP on its allow list.');
    if (e.code === 'ECONNREFUSED') throw stepError('TCP', e, `TCP: ${at} refused the connection. Nothing listens on that port, or a firewall rejects it.`, 'Check the port and that the server runs.');
    throw stepError('TCP', e, `TCP: could not connect to ${at} (${e.code || e.message}).`, 'Check the network, VPN or SSH tunnel.');
  }
  steps.push(`TCP ${address}:${opts.port} open`);
  if (!opts.tls) { sock.destroy(); return { address, steps }; }
  try {
    await withTimeout(new Promise((res, rej) => {
      const t = tls.connect({ socket: sock, servername: opts.servername || (net.isIP(opts.host) ? undefined : opts.host), ca: opts.ca, rejectUnauthorized: opts.rejectUnauthorized !== false });
      t.once('secureConnect', () => { steps.push(`TLS ${t.getProtocol ? t.getProtocol() : ''} ok`); t.destroy(); res(); });
      t.once('error', rej);
    }), ms, () => Object.assign(new Error('TLS handshake timed out'), { code: 'ETIMEDOUT' }));
  } catch (e) {
    sock.destroy();
    const { explain } = require('./errors');
    const x = e.code === 'ETIMEDOUT' ? { message: `TLS: ${at} accepted TCP but did not finish the TLS handshake within ${Math.round(ms / 1000)} s. It may not speak TLS on this port.`, hint: 'Try redis:// instead of rediss://.' } : explain(e, null, { host: opts.host, port: opts.port, caGiven: !!opts.ca });
    throw stepError('TLS', e, x.message, x.hint);
  }
  return { address, steps };
}

module.exports = { probe };
