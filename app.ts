// The forge's HTTP router: health probe, git smart HTTP, REST v3, GraphQL v4 and
// MCP, all served from the single in-memory store. main.ts (the entry <-> env
// lifecycle) is kept as the starter ships it; this file is the server.
//
// Routing order matters: /healthz first (no auth), then the four surfaces by
// path shape, then the JSON 404. Every response carries a non-empty
// X-GitHub-Request-Id (a monotonic counter, deterministic across runs).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store, type Store } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGit } from './src/git.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import type { Ctx, Resp } from './src/rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the suite presents, when the trial sets one. */
const TOKEN: string | null =
  process.env.MAKEFUN_SHOP_TOKEN ?? process.env.FORGE_TOKEN ?? null;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

const ctx: Ctx = { store: store as Store, token: TOKEN, reqId: nextRequestId };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendResp(res: ServerResponse, r: Resp): void {
  const body = r.body;
  const h = r.headers;
  // Fast path: the REST json()/jsonRaw() responses always carry Content-Type
  // + X-GitHub-Request-Id + a precomputed Content-Length — write them
  // straight out with no scanning, no Set, no object copy.
  if (
    h !== undefined &&
    (h['Content-Type'] !== undefined || h['content-type'] !== undefined) &&
    (h['X-GitHub-Request-Id'] !== undefined || h['x-github-request-id'] !== undefined) &&
    (h['Content-Length'] !== undefined || h['content-length'] !== undefined)
  ) {
    res.writeHead(r.status, h);
    res.end(body);
    return;
  }
  // Slow path (git plain()/git responses, GraphQL/MCP, 404/500): fill in
  // whichever of the three standard headers is missing, case-insensitively.
  const headers: Record<string, string> = {};
  if (h !== undefined) {
    for (const k of Object.keys(h)) headers[k] = h[k];
  }
  let hasCT = false;
  let hasLen = false;
  let hasReqId = false;
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'content-type') hasCT = true;
    else if (lk === 'content-length') hasLen = true;
    else if (lk === 'x-github-request-id') hasReqId = true;
  }
  if (!hasCT) headers['content-type'] = JSON_TYPE;
  if (!hasReqId) headers['x-github-request-id'] = nextRequestId();
  if (!hasLen) {
    headers['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.length);
  }
  res.writeHead(r.status, headers);
  res.end(body);
}

/** Read the whole request body (binary-safe). Caps at 64 MiB. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Manual URL split: `new URL()` costs ~1-2us per request and the
      // handlers only need the raw path + query string. Percent-escapes
      // stay encoded here; the REST handler decodes each segment and the
      // git handler decodes owner/repo itself, exactly as before.
      const rawUrl = req.url ?? '/';
      const qPos = rawUrl.indexOf('?');
      const path = qPos < 0 ? rawUrl : rawUrl.slice(0, qPos);
      const method = req.method ?? 'GET';

      // Boot probe: no auth, no body.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Node lowercases every incoming header name, so req.headers is used
      // directly — the old headerMap() rebuild per request is gone. Values
      // may be string[] for duplicated headers; the readers join them.
      const headers = req.headers as unknown as Record<string, string | undefined>;
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const query = new URLSearchParams(qPos < 0 ? '' : rawUrl.slice(qPos + 1));

      let r: Resp | null = null;
      if (path === '/api/graphql') {
        r = await handleGraphQL(method, path, query, headers, body, ctx);
      } else if (path === '/mcp') {
        r = await handleMcp(method, path, query, headers, body, ctx);
      } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        r = await handleRest(method, path, query, headers, body, ctx);
      } else if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
        r = await handleGit(method, path, query, headers, body, ctx);
      }

      if (r !== null) {
        sendResp(res, r);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.destroy();
      }
    }
  });
  // Keep-alive generous enough for the 2,000-read workload on one connection.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}
