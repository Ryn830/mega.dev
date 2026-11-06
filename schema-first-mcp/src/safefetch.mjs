import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_FETCH === '1'; // local tests only

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

async function assertPublicUrl(url) {
  if (url.protocol !== 'https:' && !(ALLOW_PRIVATE && url.protocol === 'http:')) {
    throw new Error('Only https URLs are allowed.');
  }
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed.');
  if (ALLOW_PRIVATE) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('That address is not publicly reachable.');
  }
}

/**
 * Fetch a URL on behalf of a caller. https only, public addresses only,
 * redirects re-checked, hard size and time limits.
 */
export async function safeFetch(rawUrl, { maxBytes = 25 * 1024 * 1024, timeoutMs = 30000, accept } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('That is not a valid URL.');
  }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: accept ? { accept } : undefined,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (!res.ok) throw new Error(`The remote server answered ${res.status}.`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`The file is larger than ${maxBytes} bytes.`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`The file is larger than ${maxBytes} bytes.`);
      chunks.push(chunk);
    }
    return {
      buffer: Buffer.concat(chunks),
      contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      finalUrl: url.toString(),
    };
  }
  throw new Error('Too many redirects.');
}
