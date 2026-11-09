'use strict';
// Plain messages that say which step failed: DNS, TCP, TLS, AUTH, the server, the cluster or the sentinels.
// No "Something was wrong".

const TLS_CODES = /^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS|ERR_SSL|EPROTO$|ERR_OSSL|HOSTNAME_MISMATCH|ERR_TLS_CERT_ALTNAME_INVALID)/;

function where(cfg) {
  if (!cfg) return 'the server';
  if (cfg.mode === 'cluster') return 'the cluster';
  if (cfg.mode === 'sentinel') return `the sentinels of "${cfg.sentinelName}"`;
  return `${cfg.host}:${cfg.port}`;
}

/** {step, message, hint} for an error from a probe, ioredis or a command. */
function explain(err, cfg, ctx = {}) {
  const e = err || {};
  const code = String(e.code || '');
  const msg = String(e.message || e);
  const host = ctx.host || (cfg && cfg.host) || '';
  const port = ctx.port || (cfg && cfg.port) || '';
  const at = host ? `${host}:${port}` : where(cfg);
  if (e.step && e.friendlyText) return { step: e.step, message: e.friendlyText, hint: e.hint || '' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_FAIL') {
    return { step: 'DNS', message: `DNS: the host name "${host || e.hostname || ''}" could not be resolved (${code}).`, hint: 'Check the spelling, your VPN, or use the IP address.' };
  }
  if (code === 'ECONNREFUSED') return { step: 'TCP', message: `TCP: ${at} refused the connection. Nothing listens on that port, or a firewall rejects it.`, hint: 'Check the port and that the server runs.' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { step: 'TCP', message: `TCP: ${at} cannot be reached from this machine (${code}).`, hint: 'Check the network, VPN or SSH tunnel.' };
  if (code === 'ECONNRESET' || code === 'EPIPE') return { step: 'TCP', message: `TCP: ${at} closed the connection (${code}). The server may need TLS (rediss://), or it dropped the client.`, hint: 'Try turning TLS on, or check the server log.' };
  if (code === 'ETIMEDOUT' || /connect ETIMEDOUT|timed? ?out/i.test(msg) && !/WRONGPASS/.test(msg)) {
    return { step: e.step || 'TCP', message: `${e.step || 'TCP'}: no answer from ${at} within ${ctx.timeoutSec || 10} s.`, hint: 'The host may be behind a firewall, or the port is wrong. A cloud server may need your IP on its allow list.' };
  }
  if (TLS_CODES.test(code) || /certificate|SSL routines|wrong version number|TLS/i.test(msg)) {
    let why = msg;
    const signed = /self[- ]signed/i.test(msg) || ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT'].includes(code);
    if (signed && ctx.caGiven) why = 'the server certificate is not signed by the CA file you picked';
    else if (/self[- ]signed/i.test(msg) || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') why = 'the server certificate is self-signed (or signed by a private CA) and no CA file was given';
    else if (signed) why = 'the certificate was not signed by a CA this machine trusts';
    else if (code === 'CERT_HAS_EXPIRED') why = 'the server certificate has expired';
    else if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /altnames|Hostname\/IP does not match/i.test(msg)) why = `the certificate is not for "${host}"`;
    else if (/wrong version number|packet length too long/i.test(msg)) why = 'the server does not speak TLS on this port (try redis:// instead of rediss://)';
    return { step: 'TLS', message: `TLS: the handshake with ${at} failed: ${why}.`, hint: 'Add the CA file of the server, or check the host name. "Allow a certificate that cannot be verified" is there for tests only.' };
  }
  if (/WRONGPASS|invalid username-password|invalid password/i.test(msg)) return { step: 'AUTH', message: `AUTH: ${at} refused the user name or password.`, hint: 'Check the password, and the user name for Redis 6+ ACL users ("default" when you have no user).' };
  if (/NOAUTH/i.test(msg)) return { step: 'AUTH', message: `AUTH: ${at} needs a password.`, hint: 'Edit the connection and add the password.' };
  if (/NOPERM/i.test(msg)) return { step: 'AUTH', message: `ACL: this user may not run that command (${msg.replace(/^NOPERM\s*/, '')}).`, hint: 'Ask the admin for the permission, or use another user.' };
  if (/All sentinels are unreachable/i.test(msg)) return { step: 'SENTINEL', message: `Sentinel: none of the sentinels answered (${(cfg && cfg.sentinels || []).map((n) => `${n.host}:${n.port}`).join(', ')}).`, hint: 'Sentinels usually listen on port 26379. Check the list and the sentinel password.' };
  if (/no sentinel|master name|ERR No such master/i.test(msg) || /sentinel.*(not|no).*(found|known)/i.test(msg)) return { step: 'SENTINEL', message: `Sentinel: the sentinels do not know a primary named "${cfg && cfg.sentinelName}".`, hint: 'Check the name in sentinel.conf (sentinel monitor <name> ...).' };
  if (/Failed to refresh slots cache|None of startup nodes is available|ClusterAllFailedError/i.test(msg)) return { step: 'CLUSTER', message: 'Cluster: none of the seed nodes answered with the slot table.', hint: 'Check the node list. A cluster in Docker may announce internal IP addresses: use the addresses the cluster announces, or connect from inside the same network (Remote SSH or Dev Container).' };
  if (/CLUSTERDOWN/i.test(msg)) return { step: 'CLUSTER', message: `Cluster: the cluster is down right now (${msg}).`, hint: 'A primary may have failed and no replica took over yet. Try again in a few seconds.' };
  if (/MOVED|ASK /.test(msg) && cfg && cfg.mode !== 'cluster') return { step: 'CLUSTER', message: 'This server is part of a cluster. Edit the connection and pick Cluster.', hint: '' };
  if (/Connection is closed|Stream isn't writeable|enableOfflineQueue/i.test(msg)) return { step: 'CONNECTION', message: `The connection to ${where(cfg)} is closed.`, hint: 'Click Reconnect, or Refresh on the connection.' };
  if (/Reached the max retries per request limit/i.test(msg)) return { step: 'CONNECTION', message: `Lost the connection to ${where(cfg)} and could not get it back in time.`, hint: 'Click Reconnect. If the server failed over, the extension follows the new primary on reconnect.' };
  if (/READONLY/.test(msg)) return { step: 'SERVER', message: 'The server is a read-only replica, so it refused the write.', hint: 'Connect to the primary (or through the sentinels).' };
  if (/LOADING/.test(msg)) return { step: 'SERVER', message: 'The server is loading its data from disk. Try again in a moment.', hint: '' };
  if (/OOM/.test(msg)) return { step: 'SERVER', message: `The server is out of memory (maxmemory) and refused the write: ${msg}`, hint: '' };
  if (/WRONGTYPE/.test(msg)) return { step: 'SERVER', message: 'The key holds a different type now (it may have changed since the tree loaded). Refresh and try again.', hint: '' };
  if (/unknown command/i.test(msg)) return { step: 'SERVER', message: `The server does not know this command: ${msg.replace(/^ERR\s*/, '')}`, hint: 'Module commands (JSON., FT.) need the module on the server.' };
  if (/^ERR |^[A-Z]{3,} /.test(msg)) return { step: 'SERVER', message: `The server said: ${msg}`, hint: '' };
  return { step: 'ERROR', message: msg || 'Unknown error.', hint: '' };
}

module.exports = { explain };
