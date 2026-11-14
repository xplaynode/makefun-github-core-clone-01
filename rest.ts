// The REST v3 surface under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests, in GitHub's shapes
// and status codes. Every handler answers a {status, json} pair; the app
// shell serializes it as application/json with the request-id header, and
// every error body is an object with a string message.

import {
  commitWalk,
  identityTimestamp,
  isOid,
  parseTree,
} from './gitobjects.ts';
import { diffTrees, type FileChange } from './merge.ts';
import {
  ACCOUNT,
  addComment,
  commitFiles,
  createIssue,
  createPull,
  filesAtCommit,
  filesAtRef,
  mergePull,
  openPullFor,
  pullMergeBase,
  readCommit,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestAnswer {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const err = (status: number, message: string): RestAnswer => ({ status, json: { message } });
const notFound = (): RestAnswer => err(404, 'Not Found');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Deterministic ISO stamps: derived from a sequence number, never the wall clock. */
function isoOf(seq: number): string {
  return new Date((1_700_000_000 + seq) * 1000).toISOString();
}

export function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: ACCOUNT.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.seq),
    updated_at: isoOf(repo.seq),
  };
}

export function userView(): Record<string, unknown> {
  return {
    login: ACCOUNT.login,
    id: ACCOUNT.id,
    name: ACCOUNT.name,
    email: ACCOUNT.email,
    type: 'User',
  };
}

function labelView(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

export function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelView(repo, name)),
    user: { login: ACCOUNT.login, id: ACCOUNT.id, type: 'User' },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: isoOf(issue.seq),
    updated_at: isoOf(issue.seq),
  };
}

function refTip(repo: RepoRec, branch: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? fallback;
}

export function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: refTip(repo, pull.headRef, pull.headSha),
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: refTip(repo, pull.baseRef, pull.baseSha),
      label: `${repo.owner}:${pull.baseRef}`,
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: ACCOUNT.login, id: ACCOUNT.id, type: 'User' },
    created_at: isoOf(pull.seq),
    updated_at: isoOf(pull.seq),
  };
}

function commentView(comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: ACCOUNT.login, id: ACCOUNT.id, type: 'User' },
    created_at: isoOf(comment.seq),
    updated_at: isoOf(comment.seq),
  };
}

/** Page through a list with per_page/page query parameters. */
function paginate<T>(items: readonly T[], query: URLSearchParams): T[] {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------------------
// Repository routes

function createRepo(forge: Forge, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const name = stringField(body, 'name');
  if (name === undefined || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
    return err(422, 'Repository creation failed: the name is invalid.');
  }
  const isPrivate = typeof body.private === 'boolean' ? body.private : false;
  const description = stringField(body, 'description') ?? '';
  const repo = forge.createRepo(name, isPrivate, description);
  if (repo === null) return err(422, 'name already exists on this account');
  return { status: 201, json: repoView(repo) };
}

function listUserRepos(forge: Forge, query: URLSearchParams, origin: string): RestAnswer {
  const all = forge.listRepos();
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const links: string[] = [];
  const url = (p: number): string => `${origin}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
  if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  const headers: Record<string, string> = {};
  if (links.length > 0) headers.link = links.join(', ');
  return { status: 200, json: slice.map(repoView), headers };
}

function patchRepo(repo: RepoRec, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const description = stringField(body, 'description');
  if (description !== undefined) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  return { status: 200, json: repoView(repo) };
}

function listBranches(repo: RepoRec): RestAnswer {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
  return { status: 200, json: branches };
}

function getBranch(repo: RepoRec, branch: string): RestAnswer {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return notFound();
  return { status: 200, json: { name: branch, commit: { sha: oid }, protected: false } };
}

function getGitRef(repo: RepoRec, branch: string): RestAnswer {
  const ref = `refs/heads/${branch}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  const object = repo.objects.get(oid);
  return { status: 200, json: { ref, object: { sha: oid, type: object?.type ?? 'commit' } } };
}

function createGitRef(repo: RepoRec, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
    return err(422, 'Validation Failed: ref and sha are required');
  }
  const object = repo.objects.get(sha);
  if (object === undefined) return err(422, `Validation Failed: the object ${sha} does not exist`);
  repo.refs.set(ref, sha);
  return { status: 201, json: { ref, object: { sha, type: object.type } } };
}

function listCommits(repo: RepoRec, query: URLSearchParams): RestAnswer {
  const shaParam = query.get('sha');
  let tip: string | undefined;
  if (shaParam === null || shaParam === '') tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  else if (isOid(shaParam)) tip = repo.objects.has(shaParam) ? shaParam : undefined;
  else tip = repo.refs.get(`refs/heads/${shaParam}`);
  if (tip === undefined) return { status: 200, json: [] };
  const views: Record<string, unknown>[] = [];
  for (const oid of commitWalk(repo.objects, tip)) {
    const view = readCommit(repo, oid);
    if (view === null) continue;
    const stamp = (line: string): Record<string, unknown> => {
      const match = /^(.*) <(.*)> (\d+) /.exec(line);
      return {
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: new Date((match ? Number(match[3]) : identityTimestamp(line)) * 1000).toISOString(),
      };
    };
    views.push({
      sha: oid,
      commit: {
        message: view.message,
        author: stamp(view.author),
        committer: stamp(view.committer),
        tree: { sha: view.tree },
      },
      parents: view.parents.map((parent) => ({ sha: parent })),
    });
  }
  return { status: 200, json: views };
}

// ---------------------------------------------------------------------------
// Contents routes

/** The tree oid at a directory path inside a commit's tree, or null. */
function treeAtPath(repo: RepoRec, rootTree: string, dirPath: string): string | null {
  if (dirPath === '') return rootTree;
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

/** Resolve a ?ref= value (branch name or commit id) to a commit oid. */
function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  if (isOid(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

function getContents(repo: RepoRec, path: string, query: URLSearchParams): RestAnswer {
  const commitOid = resolveRef(repo, query.get('ref'));
  if (commitOid === null) return notFound();
  const files = filesAtCommit(repo, commitOid);
  const blobOid = files.get(path);
  if (blobOid !== undefined && path !== '') {
    const blob = repo.objects.get(blobOid);
    if (blob === undefined) return notFound();
    const name = path.slice(path.lastIndexOf('/') + 1);
    return {
      status: 200,
      json: {
        type: 'file',
        name,
        path,
        sha: blobOid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      },
    };
  }
  // A directory listing: the entries directly under `path`.
  const commit = readCommit(repo, commitOid);
  if (commit === null) return notFound();
  const dirTree = treeAtPath(repo, commit.tree, path);
  if (dirTree === null) return notFound();
  const treeObject = repo.objects.get(dirTree);
  if (treeObject === undefined || treeObject.type !== 'tree') return notFound();
  const entries = parseTree(treeObject.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  }));
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { status: 200, json: entries };
}

function decodeBase64(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function putContents(forge: Forge, repo: RepoRec, path: string, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const contentField = stringField(body, 'content');
  const message = stringField(body, 'message');
  if (contentField === undefined || message === undefined) {
    return err(422, 'Validation Failed: content and message are required');
  }
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  if (!repo.refs.has(ref) && branch !== repo.defaultBranch) {
    // A contents write can seed a new branch from the default branch's tip.
    const seed = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (seed !== undefined) repo.refs.set(ref, seed);
  }
  const existing = filesAtRef(repo, ref).get(path);
  const givenSha = stringField(body, 'sha');
  if (givenSha !== undefined && existing !== undefined && givenSha !== existing) {
    return err(409, `${path} does not match the sha ${givenSha}`);
  }
  const bytes = decodeBase64(contentField);
  const commitOid = commitFiles(forge, repo, branch, new Map([[path, bytes]]), message);
  const blobOid = filesAtRef(repo, ref).get(path) as string;
  return {
    status: existing === undefined ? 201 : 200,
    json: {
      content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: blobOid, size: bytes.length, encoding: 'base64' },
      commit: { sha: commitOid },
    },
  };
}

function deleteContents(forge: Forge, repo: RepoRec, path: string, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const message = stringField(body, 'message');
  if (message === undefined) return err(422, 'Validation Failed: message is required');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const existing = filesAtRef(repo, ref).get(path);
  if (existing === undefined) return notFound();
  const givenSha = stringField(body, 'sha');
  if (givenSha !== undefined && givenSha !== existing) {
    return err(409, `${path} does not match the sha ${givenSha}`);
  }
  const commitOid = commitFiles(forge, repo, branch, new Map([[path, null]]), message);
  return { status: 200, json: { content: null, commit: { sha: commitOid } } };
}

// ---------------------------------------------------------------------------
// Labels, issues, comments

function createLabel(repo: RepoRec, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const name = stringField(body, 'name');
  if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
  if (repo.labels.has(name)) return err(422, 'Validation Failed: the label already exists');
  const color = (stringField(body, 'color') ?? 'ededed').replace(/^#/, '');
  repo.labels.set(name, { name, color });
  return { status: 201, json: labelView(repo, name) };
}

function createIssueAnswer(forge: Forge, repo: RepoRec, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const title = stringField(body, 'title');
  if (title === undefined) return err(422, 'Validation Failed: title is required');
  const text = stringField(body, 'body') ?? '';
  const rawLabels = body.labels;
  const labelNames: string[] = [];
  if (Array.isArray(rawLabels)) {
    for (const entry of rawLabels) {
      const name = typeof entry === 'string' ? entry : isRecord(entry) ? stringField(entry, 'name') : undefined;
      if (name === undefined) return err(422, 'Validation Failed: labels must be names');
      if (!repo.labels.has(name)) return err(422, `Validation Failed: label "${name}" does not exist`);
      labelNames.push(name);
    }
  }
  const issue = createIssue(forge, repo, title, text, labelNames);
  return { status: 201, json: issueView(repo, issue) };
}

function listIssues(repo: RepoRec, query: URLSearchParams): RestAnswer {
  const state = query.get('state') ?? 'open';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  const direction = query.get('direction') ?? 'asc';
  issues.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
  return { status: 200, json: paginate(issues, query).map((issue) => issueView(repo, issue)) };
}

function patchIssue(repo: RepoRec, number: number, body: unknown): RestAnswer {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const state = stringField(body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = stringField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = stringField(body, 'body');
  if (text !== undefined) issue.body = text;
  return { status: 200, json: issueView(repo, issue) };
}

function createCommentAnswer(forge: Forge, repo: RepoRec, number: number, body: unknown): RestAnswer {
  if (!repo.issues.has(number) && !repo.pulls.has(number)) return notFound();
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const text = stringField(body, 'body');
  if (text === undefined) return err(422, 'Validation Failed: body is required');
  const comment = addComment(forge, repo, number, text);
  return { status: 201, json: commentView(comment) };
}

function listComments(repo: RepoRec, number: number): RestAnswer {
  if (!repo.issues.has(number) && !repo.pulls.has(number)) return notFound();
  const comments = repo.comments.get(number) ?? [];
  return { status: 200, json: comments.map(commentView) };
}

// ---------------------------------------------------------------------------
// Pull requests

function branchNameOf(value: string): string {
  const colon = value.lastIndexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function createPullAnswer(forge: Forge, repo: RepoRec, body: unknown): RestAnswer {
  if (!isRecord(body)) return err(400, 'Problems parsing JSON');
  const title = stringField(body, 'title');
  const headRaw = stringField(body, 'head');
  const baseRaw = stringField(body, 'base');
  if (title === undefined || headRaw === undefined || baseRaw === undefined) {
    return err(422, 'Validation Failed: title, head and base are required');
  }
  const head = branchNameOf(headRaw);
  const base = branchNameOf(baseRaw);
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined) return err(422, `Validation Failed: the head branch ${head} does not exist`);
  if (baseTip === undefined) return err(422, `Validation Failed: the base branch ${base} does not exist`);
  if (headTip === baseTip) return err(422, `Validation Failed: no commits between ${base} and ${head}`);
  if (openPullFor(repo, head, base) !== undefined) {
    return err(422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
  }
  const pull = createPull(forge, repo, head, base, title, stringField(body, 'body') ?? '');
  return { status: 201, json: pullView(repo, pull) };
}

function listPulls(repo: RepoRec, query: URLSearchParams): RestAnswer {
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => a.number - b.number);
  return { status: 200, json: paginate(pulls, query).map((pull) => pullView(repo, pull)) };
}

function pullFilesAnswer(repo: RepoRec, pull: PullRec): RestAnswer {
  const base = pullMergeBase(repo, pull);
  const ancestorFiles = base === null ? new Map<string, string>() : filesAtCommit(repo, base);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const headFiles = headTip === undefined ? new Map<string, string>() : filesAtCommit(repo, headTip);
  const changes: FileChange[] = diffTrees(repo.objects, ancestorFiles, headFiles);
  return {
    status: 200,
    json: changes.map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    })),
  };
}

function mergePullAnswer(forge: Forge, repo: RepoRec, pull: PullRec, body: unknown): RestAnswer {
  if (pull.state !== 'open') return err(405, 'Pull Request is not mergeable');
  const methodField = isRecord(body) ? stringField(body, 'merge_method') : undefined;
  const method = methodField === 'merge' || methodField === 'rebase' ? methodField : 'squash';
  const result = mergePull(forge, repo, pull, method);
  if (!result.ok) return err(405, result.detail);
  return { status: 200, json: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// ---------------------------------------------------------------------------
// Router

/**
 * Route one REST call. `segments` are the path parts after /api/v3; `body`
 * is the parsed JSON body (or undefined); `bodyMalformed` marks a body that
 * failed JSON parsing, which answers 400 on routes that need a body.
 */
export function handleRest(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  bodyMalformed: boolean,
  origin: string,
): RestAnswer {
  try {
    return route(forge, method, segments, query, body, bodyMalformed, origin);
  } catch {
    return err(500, 'Internal Server Error');
  }
}

function route(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  bodyMalformed: boolean,
  origin: string,
): RestAnswer {
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: { current_user_url: `${origin}/api/v3/user`, repository_url: `${origin}/api/v3/repos/{owner}/{repo}` },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    return method === 'GET' ? { status: 200, json: { installed_version: '1.0.0' } } : notFound();
  }
  if (segments[0] === 'user' && segments.length === 1) {
    return method === 'GET' ? { status: 200, json: userView() } : notFound();
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return listUserRepos(forge, query, origin);
    if (method === 'POST') return bodyMalformed ? err(400, 'Problems parsing JSON') : createRepo(forge, body);
    return notFound();
  }
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();

  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound();
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoView(repo) };
    if (method === 'PATCH') return bodyMalformed ? err(400, 'Problems parsing JSON') : patchRepo(repo, body);
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, json: null };
    }
    return notFound();
  }
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') return listBranches(repo);
  if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') return getBranch(repo, rest.slice(1).join('/'));
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
    return bodyMalformed ? err(400, 'Problems parsing JSON') : createGitRef(repo, body);
  }
  if (rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && rest.length >= 4 && method === 'GET') {
    return getGitRef(repo, rest.slice(3).join('/'));
  }
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(repo, query);
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(repo, path, query);
    if (method === 'PUT') return bodyMalformed ? err(400, 'Problems parsing JSON') : putContents(forge, repo, path, body);
    if (method === 'DELETE') return bodyMalformed ? err(400, 'Problems parsing JSON') : deleteContents(forge, repo, path, body);
    return notFound();
  }
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, json: [...repo.labels.keys()].map((labelName) => labelView(repo, labelName)) };
    }
    if (rest.length === 1 && method === 'POST') {
      return bodyMalformed ? err(400, 'Problems parsing JSON') : createLabel(repo, body);
    }
    return notFound();
  }
  if (rest[0] === 'issues') return routeIssues(forge, repo, method, rest, query, body, bodyMalformed);
  if (rest[0] === 'pulls') return routePulls(forge, repo, method, rest, query, body, bodyMalformed);
  return notFound();
}

function routeIssues(
  forge: Forge,
  repo: RepoRec,
  method: string,
  rest: readonly string[],
  query: URLSearchParams,
  body: unknown,
  bodyMalformed: boolean,
): RestAnswer {
  if (rest.length === 1) {
    if (method === 'GET') return listIssues(repo, query);
    if (method === 'POST') return bodyMalformed ? err(400, 'Problems parsing JSON') : createIssueAnswer(forge, repo, body);
    return notFound();
  }
  const number = Number.parseInt(rest[1] as string, 10);
  if (!Number.isInteger(number)) return notFound();
  if (rest.length === 2) {
    if (method === 'GET') {
      const issue = repo.issues.get(number);
      return issue === undefined ? notFound() : { status: 200, json: issueView(repo, issue) };
    }
    if (method === 'PATCH') return bodyMalformed ? err(400, 'Problems parsing JSON') : patchIssue(repo, number, body);
    return notFound();
  }
  if (rest.length === 3 && rest[2] === 'comments') {
    if (method === 'POST') return bodyMalformed ? err(400, 'Problems parsing JSON') : createCommentAnswer(forge, repo, number, body);
    if (method === 'GET') return listComments(repo, number);
  }
  return notFound();
}

function routePulls(
  forge: Forge,
  repo: RepoRec,
  method: string,
  rest: readonly string[],
  query: URLSearchParams,
  body: unknown,
  bodyMalformed: boolean,
): RestAnswer {
  if (rest.length === 1) {
    if (method === 'GET') return listPulls(repo, query);
    if (method === 'POST') return bodyMalformed ? err(400, 'Problems parsing JSON') : createPullAnswer(forge, repo, body);
    return notFound();
  }
  const number = Number.parseInt(rest[1] as string, 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (rest.length === 2 && method === 'GET') {
    return pull === undefined ? notFound() : { status: 200, json: pullView(repo, pull) };
  }
  if (pull === undefined) return notFound();
  if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFilesAnswer(repo, pull);
  if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
    return bodyMalformed ? err(400, 'Problems parsing JSON') : mergePullAnswer(forge, repo, pull, body);
  }
  return notFound();
}
