// The HTTP shell: one server, four surfaces. It owns the cross-cutting
// wire discipline — Bearer auth on everything except the boot probe,
// application/json on every REST-shaped reply, a non-empty
// X-GitHub-Request-Id on every response, JSON 404s for unknown routes and
// 400s for malformed JSON bodies — and routes to the git, REST, GraphQL
// and MCP handlers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

export interface AppHandle {
  server: Server;
  forge: Forge;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(options: { token: string }): AppHandle {
  const forge = new Forge();
  const token = options.token;
  let requestSeq = 0;

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      requestSeq += 1;
      const requestId = `lf-${String(requestSeq).padStart(6, '0')}`;
      const sendJson = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
        const body = value === null || value === undefined || status === 204 ? '' : JSON.stringify(value);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'x-github-request-id': requestId,
          ...headers,
        });
        res.end(body);
      };
      const sendRaw = (status: number, contentType: string, body: Buffer): void => {
        res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': requestId });
        res.end(body);
      };
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(200, { ok: true });
          return;
        }

        const authorization = req.headers.authorization ?? '';
        if (authorization !== `Bearer ${token}`) {
          sendJson(401, { message: 'Bad credentials' });
          return;
        }

        const body = await readBody(req);
        const origin = `http://${req.headers.host ?? 'localhost'}`;

        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          const answer = handleGraphql(forge, payload);
          sendJson(answer.status, answer.json);
          return;
        }

        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          let payload: unknown;
          let malformed = false;
          try {
            payload = JSON.parse(body.toString('utf8'));
          } catch {
            malformed = true;
          }
          const answer = handleMcp(forge, payload, malformed);
          if (answer.json === null) {
            res.writeHead(answer.status, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(answer.status, answer.json);
          return;
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const rest = pathname.slice('/api/v3'.length);
          const segments = rest.split('/').filter((part) => part !== '').map(decodeSegment);
          let parsed: unknown;
          let malformed = false;
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              malformed = true;
            }
          }
          const answer = handleRest(forge, method, segments, url.searchParams, parsed, malformed, origin);
          sendJson(answer.status, answer.json, answer.headers ?? {});
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/(info/refs|git-upload-pack|git-receive-pack)
        const parts = pathname.split('/').filter((part) => part !== '').map(decodeSegment);
        if (parts.length >= 3 && (parts[1] as string).endsWith('.git')) {
          const owner = parts[0] as string;
          const repoName = (parts[1] as string).slice(0, -'.git'.length);
          const tail = parts.slice(2).join('/');
          const repo = forge.getRepo(owner, repoName);
          if (tail === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const protocol = req.headers['git-protocol'];
            const version2 = typeof protocol === 'string' && protocol.includes('version=2');
            const answer = infoRefs(repo, service, version2);
            sendRaw(answer.status, answer.contentType, answer.body);
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            const answer = uploadPack(repo, body);
            sendRaw(answer.status, answer.contentType, answer.body);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            const answer = receivePack(repo, body);
            sendRaw(answer.status, answer.contentType, answer.body);
            return;
          }
          sendJson(404, { message: 'Not Found' });
          return;
        }

        sendJson(404, { message: 'Not Found' });
      } catch {
        try {
          sendJson(500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });

  return { server, forge };
}
