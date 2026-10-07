import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { AppError } from './store.js';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
denied.addSubnet('2001::', 23, 'ipv6');
denied.addSubnet('2001:db8::', 32, 'ipv6');
denied.addSubnet('2002::', 16, 'ipv6');

export function publicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  // Restrict IPv6 to globally routed unicast, excluding transition/documentation ranges.
  return family === 6 && /^[23]/i.test(address) && !denied.check(address, 'ipv6');
}

const rejected = () => new AppError('ATTACHMENT_URL_REJECTED', 'Use the temporary HTTPS download_url supplied with the ChatGPT attachment. Local paths, private network URLs and URL credentials are not supported.');

export function attachmentUrl(raw: string, ownOrigin: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw rejected(); }
  const ownDownload = url.origin === ownOrigin && /^\/files\/download\/[a-f0-9-]{36}\/[A-Za-z0-9_-]{43}$/.test(url.pathname) && !url.search;
  if (url.username || url.password || url.hash || (ownDownload
    ? !['http:', 'https:'].includes(url.protocol)
    : url.protocol !== 'https:' || (url.port && url.port !== '443'))) throw rejected();
  return { url, ownDownload };
}

// Pin the connection to a checked address. Redirects repeat the checks and no
// Hostherd credentials are forwarded to the attachment host.
export async function openAttachment(raw: string, signal: AbortSignal, ownOrigin: string): Promise<IncomingMessage> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const { url, ownDownload } = attachmentUrl(raw, ownOrigin);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new AppError('ATTACHMENT_DOWNLOAD_FAILED', 'Could not resolve the attachment download host. Request a fresh attachment and retry.'); }
    if (!addresses.length || (!ownDownload && addresses.some(item => !publicAddress(item.address)))) throw rejected();
    const selected = addresses[0];
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(url, {
        agent: false, family: selected.family, signal,
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Hostherd-file-transfer' },
      }, resolve);
      request.setTimeout(60_000, () => request.destroy(new Error('Attachment connection idle timeout')));
      request.on('error', () => reject(new AppError('ATTACHMENT_DOWNLOAD_FAILED', 'Attachment connection failed or was idle for 60 seconds. Request a fresh attachment URL and retry.')));
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects === 5) throw new AppError('ATTACHMENT_DOWNLOAD_FAILED', 'Attachment URL redirected too many times or omitted its destination.');
      try { raw = new URL(location, url).href; } catch { throw rejected(); }
      continue;
    }
    if (response.statusCode !== 200) {
      const status = response.statusCode;
      response.destroy();
      throw new AppError([401, 403, 404].includes(status ?? 0) ? 'ATTACHMENT_URL_EXPIRED' : 'ATTACHMENT_DOWNLOAD_FAILED',
        `Attachment host returned HTTP ${status}. Reattach the file or obtain a fresh download_url and start a new transfer.`);
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      response.destroy();
      throw new AppError('ATTACHMENT_DOWNLOAD_FAILED', 'Attachment host returned an encoded response despite the request for original bytes.');
    }
    return response;
  }
  throw new AppError('ATTACHMENT_DOWNLOAD_FAILED', 'Attachment URL could not be resolved.');
}
