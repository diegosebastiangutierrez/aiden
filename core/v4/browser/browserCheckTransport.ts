import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { browserCheckRequestAllowed, type BrowserCheckContract } from './browserCheckContract';

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const resolve: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });
const maxResponse = 4 * 1024 * 1024;
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const reservedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const)
  reservedV6.addSubnet(address, prefix, 'ipv6');

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
    || a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0
    || a === 192 && b === 88 && c === 99 || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
}

/** This beta admits public IPv4 targets or the exact explicitly approved loopback origin. */
export async function resolveBrowserCheckAddress(contract: BrowserCheckContract, resolver: Resolver = resolve): Promise<Address> {
  const url = new URL(contract.origin);
  if (url.hostname === '127.0.0.1' && contract.allowLoopback && url.protocol === 'http:')
    return { address: '127.0.0.1', family: 4 };
  const answers = await resolver(url.hostname);
  const ipv4 = answers.filter(answer => answer.family === 4);
  if (!ipv4.length || answers.some(answer => answer.family === 4 ? !publicIpv4(answer.address)
    : answer.family !== 6 || isIP(answer.address) !== 6 || !globalV6.check(answer.address, 'ipv6') || reservedV6.check(answer.address, 'ipv6')))
    throw new Error('Browser target has a private, reserved or unsupported network address');
  return { ...ipv4[0] };
}

/** One bounded request with pinned DNS, normal TLS verification, no redirects and no retries. */
export async function fetchBrowserCheckResponse(contract: BrowserCheckContract, input: {
  url: string; method: string; headers: Record<string, string>; body: Buffer | null;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  if (!browserCheckRequestAllowed(contract, input.url, input.method)) throw new Error('Browser request is outside approved scope');
  if (input.body && input.body.length > 65536) throw new Error('Browser submission size limit exceeded');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let abortResolution: (() => void) | undefined;
  try {
    const address = await Promise.race([resolveBrowserCheckAddress(contract), new Promise<never>((_, reject) => {
      abortResolution = () => reject(new Error('Browser address resolution timed out'));
      controller.signal.addEventListener('abort', abortResolution, { once: true });
    })]);
    if (abortResolution) controller.signal.removeEventListener('abort', abortResolution);
    const url = new URL(input.url);
    const headers = Object.fromEntries(Object.entries(input.headers).filter(([name]) =>
      !['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'content-length', 'accept-encoding'].includes(name.toLowerCase())));
    headers['accept-encoding'] = 'identity';
    if (input.body) headers['content-length'] = String(input.body.length);
    return await new Promise((resolveResponse, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: input.method, headers, signal: controller.signal, agent: false, family: 4,
        lookup: (_hostname: string, options: any, callback: any) => options.all
          ? callback(null, [address]) : callback(null, address.address, address.family),
      }, response => {
        response.on('error', reject);
        if (Number(response.headers['content-length'] ?? 0) > maxResponse) {
          response.destroy(new Error('Browser response size limit exceeded')); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponse) response.destroy(new Error('Browser response size limit exceeded'));
          else chunks.push(chunk);
        });
        response.on('end', () => resolveResponse({ status: response.statusCode ?? 502,
          headers: Object.fromEntries(Object.entries(response.headers).filter(([name, value]) => value !== undefined
            && !['transfer-encoding', 'connection', 'content-length'].includes(name)).map(([name, value]) =>
            [name, Array.isArray(value) ? value.join('\n') : String(value)])), body: Buffer.concat(chunks) }));
      });
      request.on('error', reject);
      if (input.body) request.write(input.body);
      request.end();
    });
  } finally {
    clearTimeout(timer);
    if (abortResolution) controller.signal.removeEventListener('abort', abortResolution);
  }
}
