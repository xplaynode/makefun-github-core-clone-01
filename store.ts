// The forge's state and the operations every surface shares. One process
// holds everything in memory: repositories with their git object stores and
// refs, and the issue / pull-request / label / comment records the REST,
// GraphQL and MCP surfaces all read and write, so an object created through
// one surface is the same object through the others.
//
// The forge is a single-account instance. Its account is the user the
// trial's bearer token belongs to — the conformance scenario the kit
// publishes names that user adaiversen — and repositories live under that
// login only; any other owner in a path is simply not here, which the
// surfaces answer 404, never 403.

import {
  mergeBase,
  parseCommit,
  storeObject,
  ZERO_OID,
  type ObjectStore,
} from './gitobjects.ts';
import { commitTree, flattenTree, mergeTrees, unflattenTree } from './merge.ts';

export const ACCOUNT = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** The branch every repository is born expecting. */
export const DEFAULT_BRANCH = 'main';

export interface LabelRec {
  name: string;
  color: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** Tips at creation, the fallback when a branch later disappears. */
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  comments: Map<number, CommentRec[]>;
  /** One numbering sequence shared by issues and pull requests, as GitHub's is. */
  nextNumber: number;
  seq: number;
}

const CLOCK_EPOCH_SEC = 1_700_000_000;

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private entitySeq = 0;
  private clockSeq = 0;

  /** A deterministic logical clock: identical request streams, identical stamps. */
  nowSec(): number {
    this.clockSeq += 1;
    return CLOCK_EPOCH_SEC + this.clockSeq;
  }

  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  }

  nextEntityId(): number {
    this.entitySeq += 1;
    return this.entitySeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
    const key = this.repoKey(ACCOUNT.login, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: RepoRec = {
      dbId: this.repoSeq,
      owner: ACCOUNT.login,
      name,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      seq: this.repoSeq,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** The repository at owner/name, or undefined — a foreign owner is a miss, like a missing name. */
  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== ACCOUNT.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== ACCOUNT.login) return false;
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  repoByDbId(dbId: number): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.dbId === dbId) return repo;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, and decodable by this forge alone.

export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

export const repoGlobalId = (repo: RepoRec): string => globalId('Repository', repo.dbId);
export const issueGlobalId = (repo: RepoRec, issue: IssueRec): string => globalId('Issue', repo.dbId, issue.number);
export const pullGlobalId = (repo: RepoRec, pull: PullRec): string => globalId('PullRequest', repo.dbId, pull.number);
export const commentGlobalId = (repo: RepoRec, number: number, comment: CommentRec): string =>
  globalId('Comment', repo.dbId, number, comment.id);
export const userGlobalId = (): string => globalId('User', ACCOUNT.id);

// ---------------------------------------------------------------------------
// Commits made by the forge itself (contents writes, merges)

/** One identity line for the forge's own commits, at a logical timestamp. */
function identity(forge: Forge): string {
  return `${ACCOUNT.name} <${ACCOUNT.email}> ${forge.nowSec()} +0000`;
}

/**
 * Commit a set of file changes on a branch: `changes` maps a path to its new
 * bytes, or null to remove it. Creates the branch (and the repository's first
 * commit) when the ref does not exist yet. Answers the new commit's id.
 */
export function commitFiles(
  forge: Forge,
  repo: RepoRec,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const files = new Map<string, string>();
  if (tip !== undefined) {
    const tree = commitTree(repo.objects, tip);
    if (tree !== '') flattenTree(repo.objects, tree, '', files);
  }
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, storeObject(repo.objects, 'blob', content));
  }
  const treeOid = unflattenTree(repo.objects, files);
  const stamp = identity(forge);
  const lines = [`tree ${treeOid}`];
  if (tip !== undefined) lines.push(`parent ${tip}`);
  lines.push(`author ${stamp}`, `committer ${stamp}`, '', message);
  const commitOid = storeObject(repo.objects, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  repo.refs.set(ref, commitOid);
  return commitOid;
}

/** Files at a ref (branch name or full ref), flattened; empty for an unborn ref. */
export function filesAtRef(repo: RepoRec, refName: string): Map<string, string> {
  const oid = repo.refs.get(refName);
  if (oid === undefined) return new Map();
  const tree = commitTree(repo.objects, oid);
  return tree === '' ? new Map() : flattenTree(repo.objects, tree);
}

/** Files at a commit oid, flattened. */
export function filesAtCommit(repo: RepoRec, commitOid: string): Map<string, string> {
  const tree = commitTree(repo.objects, commitOid);
  return tree === '' ? new Map() : flattenTree(repo.objects, tree);
}

// ---------------------------------------------------------------------------
// Issues, pull requests, comments

export function createIssue(forge: Forge, repo: RepoRec, title: string, body: string, labels: readonly string[]): IssueRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    id: forge.nextEntityId(),
    number,
    title,
    body,
    state: 'open',
    labels: [...labels],
    seq: number,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function addComment(forge: Forge, repo: RepoRec, number: number, body: string): CommentRec {
  const comment: CommentRec = { id: forge.nextEntityId(), body, seq: 0 };
  const list = repo.comments.get(number) ?? [];
  comment.seq = list.length + 1;
  list.push(comment);
  repo.comments.set(number, list);
  return comment;
}

export function createPull(
  forge: Forge,
  repo: RepoRec,
  headRef: string,
  baseRef: string,
  title: string,
  body: string,
): PullRec {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    id: forge.nextEntityId(),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha: repo.refs.get(`refs/heads/${headRef}`) ?? ZERO_OID,
    baseSha: repo.refs.get(`refs/heads/${baseRef}`) ?? ZERO_OID,
    seq: number,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** The open pull request for a head/base pair, if one exists. */
export function openPullFor(repo: RepoRec, headRef: string, baseRef: string): PullRec | undefined {
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
  }
  return undefined;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; conflict: boolean; detail: string };

/**
 * Merge a pull request into its base branch. `squash` lands one commit with
 * the merged tree; `merge` lands a two-parent merge commit. A tree that will
 * not merge cleanly is a conflict and changes nothing.
 */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: 'squash' | 'merge' | 'rebase'): MergeResult {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (baseTip === undefined || headTip === undefined) {
    return { ok: false, conflict: false, detail: 'a branch of this pull request no longer exists' };
  }
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null || base === headTip) {
    return { ok: false, conflict: false, detail: 'there are no changes to merge' };
  }
  const outcome = mergeTrees(
    repo.objects,
    filesAtCommit(repo, base),
    filesAtCommit(repo, baseTip),
    filesAtCommit(repo, headTip),
  );
  if (!outcome.ok) return { ok: false, conflict: true, detail: `the merge conflicts at ${outcome.conflictPath ?? 'a file'}` };
  const treeOid = unflattenTree(repo.objects, outcome.files);
  const stamp = identity(forge);
  const lines = [`tree ${treeOid}`, `parent ${baseTip}`];
  let message: string;
  if (method === 'merge') {
    lines.push(`parent ${headTip}`);
    message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  } else {
    message = pull.title;
  }
  lines.push(`author ${stamp}`, `committer ${stamp}`, '', message);
  const sha = storeObject(repo.objects, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  repo.refs.set(baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Can this pull request merge cleanly right now? */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return false;
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null || base === headTip) return false;
  return mergeTrees(repo.objects, filesAtCommit(repo, base), filesAtCommit(repo, baseTip), filesAtCommit(repo, headTip)).ok;
}

/** The merge base of a pull request's branches, or null. */
export function pullMergeBase(repo: RepoRec, pull: PullRec): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  return mergeBase(repo.objects, baseTip, headTip);
}

/** Parse a commit in a repo for the REST commits view. */
export function readCommit(repo: RepoRec, oid: string) {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}
