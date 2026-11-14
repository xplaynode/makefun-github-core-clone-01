// The MCP surface at /mcp: JSON-RPC 2.0 over plain POSTs (Streamable HTTP
// without the event stream — the client accepts JSON bodies). Implements
// the modern server/discover handshake, the legacy initialize fallback,
// and the six forge tools the checks drive, backed by the same store and
// the same JSON shapes as the REST surface. Tool arguments use exactly the
// property names the suite's semantic mapping looks for.

import { issueView, pullView, repoView } from './rest.ts';
import {
  ACCOUNT,
  createIssue,
  createPull,
  mergePull,
  type Forge,
  type RepoRec,
} from './store.ts';

export interface McpAnswer {
  status: number;
  json: unknown;
}

const SERVER_INFO = { name: 'lucky-forge', version: '1.0.0', title: 'Lucky Forge' };
const CAPABILITIES = { tools: { listChanged: false } };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: true, required } };
}

const str = (): Record<string, unknown> => ({ type: 'string' });
const strDesc = (description: string): Record<string, unknown> => ({ type: 'string', description });

const TOOLS: ToolDef[] = [
  toolDef(
    'create_repo',
    'Create a new repository for the authenticated user.',
    { name: strDesc('Repository name'), description: str(), private: { type: 'boolean' } },
    ['name'],
  ),
  toolDef(
    'get_repo',
    'Get details of a repository, including its default branch.',
    { owner: strDesc('Repository owner login'), repo: strDesc('Repository name') },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_issue',
    'Create a new issue in a repository.',
    { owner: str(), repo: str(), title: strDesc('Issue title'), body: str() },
    ['owner', 'repo', 'title'],
  ),
  toolDef(
    'list_issues',
    'List issues in a repository, optionally filtered by state (open, closed or all).',
    { owner: str(), repo: str(), state: str() },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    { owner: str(), repo: str(), title: strDesc('Pull request title'), head: str(), base: str(), body: str() },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  toolDef(
    'merge_pull_request',
    'Merge a pull request by number, using the squash method by default.',
    { owner: str(), repo: str(), pull_number: { type: 'integer' }, merge_method: str() },
    ['owner', 'repo', 'pull_number'],
  ),
];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolOk(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    isError: false,
  };
  if (typeof value === 'object' && value !== null) result.structuredContent = value;
  return result;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function findRepo(forge: Forge, args: Record<string, unknown>): RepoRec | undefined {
  const name = argString(args, 'repo');
  if (name === undefined) return undefined;
  const owner = argString(args, 'owner') ?? ACCOUNT.login;
  return forge.getRepo(owner, name);
}

function callTool(forge: Forge, name: string, rawArgs: unknown): { error?: Record<string, unknown>; result?: Record<string, unknown> } {
  const args = isRecord(rawArgs) ? rawArgs : {};
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === undefined || repoName === '') return { result: toolError('Missing required argument: name') };
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = forge.createRepo(repoName, isPrivate, argString(args, 'description') ?? '');
      if (repo === null) return { result: toolError('name already exists on this account') };
      return { result: toolOk(repoView(repo)) };
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      return { result: toolOk(repoView(repo)) };
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const title = argString(args, 'title');
      if (title === undefined || title === '') return { result: toolError('Missing required argument: title') };
      const issue = createIssue(forge, repo, title, argString(args, 'body') ?? '', []);
      return { result: toolOk(issueView(repo, issue)) };
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const state = argString(args, 'state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return { result: toolOk(issues.map((issue) => issueView(repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        return { result: toolError('Missing required arguments: title, head and base are required') };
      }
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined) return { result: toolError(`The head branch ${head} does not exist`) };
      if (baseTip === undefined) return { result: toolError(`The base branch ${base} does not exist`) };
      if (headTip === baseTip) return { result: toolError(`No commits between ${base} and ${head}`) };
      const pull = createPull(forge, repo, head, base, title, argString(args, 'body') ?? '');
      return { result: toolOk(pullView(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return { result: toolError('Repository not found') };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      if (!Number.isInteger(number)) return { result: toolError('Missing required argument: pull_number') };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { result: toolError('Pull request not found') };
      if (pull.state !== 'open') return { result: toolError('Pull Request is not mergeable') };
      const methodField = argString(args, 'merge_method');
      const method = methodField === 'merge' || methodField === 'rebase' ? methodField : 'squash';
      const merged = mergePull(forge, repo, pull, method);
      if (!merged.ok) return { result: toolError(merged.detail) };
      return {
        result: toolOk({ sha: merged.sha, merged: true, message: 'Pull Request successfully merged', number: pull.number }),
      };
    }
    default:
      return { error: rpcError(null, -32602, `Unknown tool: ${name}`) };
  }
}

function handleOne(forge: Forge, message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  const hasId = 'id' in message;
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : undefined;
  if (method === undefined) {
    return hasId ? rpcError(id, -32600, 'Invalid Request: missing method') : null;
  }
  if (!hasId) return null; // a notification: accepted, never answered
  const params = isRecord(message.params) ? message.params : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
        supportedVersions: SUPPORTED_VERSIONS,
        protocolVersion: '2026-07-28',
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      return rpcResult(id, { protocolVersion: requested, capabilities: CAPABILITIES, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const outcome = callTool(forge, name, params.arguments ?? params.args);
      if (outcome.error !== undefined) {
        const errorBody = outcome.error.error as { code: number; message: string };
        return rpcError(id, errorBody.code, errorBody.message);
      }
      return rpcResult(id, outcome.result as Record<string, unknown>);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one MCP POST. A malformed JSON body answers 400 with -32700. */
export function handleMcp(forge: Forge, payload: unknown, bodyMalformed: boolean): McpAnswer {
  if (bodyMalformed) return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  if (Array.isArray(payload)) {
    const responses = payload
      .map((message) => handleOne(forge, message))
      .filter((response) => response !== null);
    return { status: 200, json: responses };
  }
  const response = handleOne(forge, payload);
  if (response === null) return { status: 202, json: null };
  return { status: 200, json: response };
}
