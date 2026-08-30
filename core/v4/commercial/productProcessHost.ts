/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';

import { killProcessTree, spawnCommand } from '../util/spawnCommand';
import {
  createProductHostAuthority,
  type ProductHostAuthority,
  type ProductPublicationAuthorization,
} from './productHostAuthority';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_REQUESTS = 4_096;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const requestIdPattern = /^[A-Za-z0-9_-]{1,100}$/;

export type ProductHostMethod = 'admit' | 'validate' | 'acquire' | 'release' | 'authorizePublication' | 'getJob' | 'getAttempt' | 'listJobs' | 'retrieveLearning' | 'accessMode';

interface ProductHostRequest {
  version: 1;
  token: string;
  id: string;
  method: ProductHostMethod;
  params: unknown;
}

function authenticate(expected: string, observed: unknown): boolean {
  if (typeof observed !== 'string' || !tokenPattern.test(observed)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(observed));
}

async function dispatch(authority: ProductHostAuthority, request: ProductHostRequest,
  accessMode?: () => 'FULL' | 'READ_ONLY' | 'DENIED' | Promise<'FULL' | 'READ_ONLY' | 'DENIED'>): Promise<unknown> {
  const params = request.params as Record<string, unknown>;
  switch (request.method) {
    case 'admit': return authority.admit(params as never);
    case 'validate': return authority.validate(params as never);
    case 'acquire': return authority.acquire(params as never);
    case 'release': {
      const { binding, reason } = params;
      if (typeof reason !== 'string' || reason.length < 1 || reason.length > 200) throw new Error('Invalid release reason');
      authority.release(binding as never, reason); return { released: true };
    }
    case 'authorizePublication': return authority.authorizePublication(params as unknown as ProductPublicationAuthorization);
    case 'getJob': return authority.getJob(String(params.jobId ?? ''));
    case 'getAttempt': return authority.getAttempt(String(params.attemptId ?? ''));
    case 'listJobs': return authority.listJobs();
    case 'retrieveLearning': return authority.retrieveLearning(params as never);
    case 'accessMode': return { accessMode: accessMode ? await accessMode() : 'DENIED' };
    default: throw new Error('Unsupported product-host method');
  }
}

export interface ProductProcessHandle {
  child: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Launches a private product with two inherited anonymous pipes reserved for
 * authenticated authority RPC. The private process never receives the Aiden
 * database path or lifecycle objects.
 */
export class ProductProcessHost {
  constructor(private readonly options: {
    aidenRoot: string;
    ownerId: string;
    authorizePublication?: (input: ProductPublicationAuthorization) => void;
    accessMode?: () => 'FULL' | 'READ_ONLY' | 'DENIED' | Promise<'FULL' | 'READ_ONLY' | 'DENIED'>;
  }) {}

  launch(input: { productId: string; executable: string; args: string[]; cwd: string; environment?: NodeJS.ProcessEnv }): ProductProcessHandle {
    const authority = createProductHostAuthority({ aidenRoot: this.options.aidenRoot, ownerId: this.options.ownerId,
      productId: input.productId, authorizePublication: this.options.authorizePublication });
    const token = randomBytes(32).toString('base64url');
    const { child } = spawnCommand(input.executable, input.args, { cwd: input.cwd,
      env: { ...input.environment, AIDEN_PRODUCT_HOST_REQUEST_FD: '3', AIDEN_PRODUCT_HOST_RESPONSE_FD: '4', AIDEN_PRODUCT_HOST_TOKEN: token,
        AIDEN_PRODUCT_PARENT_PID: String(process.pid) },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const requestPipe = child.stdio[3]; const responsePipe = child.stdio[4];
    if (!requestPipe || !responsePipe || !('on' in requestPipe) || !('write' in responsePipe)) {
      authority.close(); killProcessTree(child, 'SIGKILL'); throw new Error('Product-host authority pipes are unavailable');
    }
    let buffer = Buffer.alloc(0); let count = 0; let stopped = false; const seen = new Set<string>();
    const fail = () => { if (stopped) return; stopped = true; authority.close(); killProcessTree(child, 'SIGKILL'); };
    requestPipe.on('data', (chunk: Buffer) => {
      if (stopped) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_MESSAGE_BYTES) return fail();
      for (;;) {
        const newline = buffer.indexOf(10); if (newline < 0) break;
        const raw = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        if (++count > MAX_REQUESTS || raw.length === 0 || raw.length > MAX_MESSAGE_BYTES) return fail();
        let request: ProductHostRequest;
        try { request = JSON.parse(raw.toString('utf8')) as ProductHostRequest; }
        catch { return fail(); }
        if (request.version !== 1 || !authenticate(token, request.token) || !requestIdPattern.test(request.id) || seen.has(request.id)) return fail();
        seen.add(request.id);
        void dispatch(authority, request, this.options.accessMode)
          .then((result) => { if (!stopped) responsePipe.write(`${JSON.stringify({ version: 1, id: request.id, ok: true, result })}\n`); })
          .catch((error) => { if (!stopped) responsePipe.write(`${JSON.stringify({ version: 1, id: request.id, ok: false,
            error: error instanceof Error ? error.message.slice(0, 300) : 'Product-host request failed' })}\n`); });
      }
    });
    child.once('exit', () => { if (!stopped) { stopped = true; authority.close(); } });
    child.once('error', fail);
    return { child, stop: async () => { if (stopped) return; stopped = true; authority.close(); killProcessTree(child, 'SIGTERM'); } };
  }
}
