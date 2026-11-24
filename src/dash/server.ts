import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { SessionStore } from './sessions.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export interface DashboardOptions {
  store: SessionStore;
  /** Directory holding the built client (index.html and assets). */
  uiDir: string;
  port: number;
}

function send(response: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function sendJson(response: ServerResponse, body: unknown, etag?: string): void {
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    ...(etag && { etag }),
  });
  response.end(JSON.stringify(body));
}

/** Only answer requests addressed to this machine's own name for the server (blocks DNS rebinding). */
function hostAllowed(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function serveStatic(response: ServerResponse, uiDir: string, pathname: string): void {
  const root = resolve(uiDir);
  const wanted = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = resolve(root, wanted);
  if (!file.startsWith(root + sep)) return send(response, 404, 'Not found');
  let target = file;
  try {
    if (!statSync(target).isFile()) target = join(root, 'index.html');
  } catch {
    target = join(root, 'index.html');
  }
  try {
    const body = readFileSync(target);
    const immutable = target.includes(`${sep}assets${sep}`);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    response.end(body);
  } catch {
    send(response, 500, 'The dashboard client is not built. Run: npm run build');
  }
}

export function handleRequest(options: DashboardOptions, request: IncomingMessage, response: ServerResponse): void {
  if (!hostAllowed(request, options.port)) return send(response, 403, 'Forbidden host');
  if (request.method !== 'GET') return send(response, 405, 'Method not allowed');
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/sessions') return sendJson(response, options.store.list());

  if (url.pathname === '/api/session') {
    const path = url.searchParams.get('path') ?? '';
    const etag = options.store.etag(path);
    if (!etag) return send(response, 404, 'No such session');
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag });
      return void response.end();
    }
    const result = options.store.view(path);
    if (!result) return send(response, 404, 'No such session');
    return sendJson(response, result.view, result.etag);
  }

  if (url.pathname.startsWith('/api/')) return send(response, 404, 'Not found');
  serveStatic(response, options.uiDir, url.pathname);
}

export function startDashboard(options: DashboardOptions): Promise<Server> {
  const server = createServer((request, response) => {
    try {
      handleRequest(options, request, response);
    } catch (error) {
      send(response, 500, error instanceof Error ? error.message : String(error));
    }
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolveServer(server));
  });
}
