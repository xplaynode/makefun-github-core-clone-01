// Tree diffs and three-way merges over the object store. Pull-request file
// lists, mergeability and squash merges are all answered from these helpers:
// a merge walks the paths of the base, head and current trees, takes the side
// that changed each path, and merges text files line by line when both sides
// changed them — a conflict only when the two sides edited the same lines
// differently, which is exactly the case the suite's 405 check builds.

import {
  buildTree,
  parseCommit,
  parseTree,
  storeObject,
  type ObjectStore,
  type TreeEntry,
} from './gitobjects.ts';

/** path -> blob oid for every file under a tree (recursive flattening). */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', into = new Map<string, string>()): Map<string, string> {
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return into;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, into);
    else into.set(path, entry.oid);
  }
  return into;
}

/** The tree oid at a commit; '' when the commit is unknown. */
export function commitTree(store: ObjectStore, commitOid: string): string {
  const object = store.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

/** Rebuild nested trees from a flat path -> blob oid map; answers the root tree oid. */
export function unflattenTree(store: ObjectStore, files: ReadonlyMap<string, string>): string {
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let next = dir.dirs.get(name);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of dir.files) entries.push({ mode: '100644', name, oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return storeObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------
// Line diffs

/** A text as its lines, without terminators; a trailing newline ends the last line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line-level edit script between two line arrays, as the set of base-line
 * indexes removed and the lines inserted in their place, computed with a
 * longest-common-subsequence walk. Inputs in this forge are small (issue and
 * fixture files), so the quadratic table is never a burden; a size guard
 * falls back to whole-file replacement counts for pathological inputs.
 */
export interface LineDiff {
  additions: number;
  deletions: number;
  /** Hunks over base lines: [start, end) replaced by `lines`. */
  hunks: { start: number; end: number; lines: string[] }[];
}

export function diffLines(base: readonly string[], next: readonly string[]): LineDiff {
  const n = base.length;
  const m = next.length;
  if (n * m > 4_000_000) {
    return {
      additions: m,
      deletions: n,
      hunks: [{ start: 0, end: n, lines: [...next] }],
    };
  }
  // lcs[i][j] = LCS length of base[i:] and next[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = base[i] === next[j] ? (lcs[i + 1][j + 1] as number) + 1 : Math.max(lcs[i + 1][j] as number, lcs[i][j + 1] as number);
    }
  }
  const hunks: LineDiff['hunks'] = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  let open: { start: number; end: number; lines: string[] } | null = null;
  const close = (): void => {
    if (open !== null) {
      hunks.push(open);
      open = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === next[j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    if (open === null) open = { start: i, end: i, lines: [] };
    // Prefer deleting a base line when that keeps the LCS, else insert.
    if (i < n && (j >= m || (lcs[i + 1][j] as number) >= (lcs[i][j + 1] as number))) {
      open.end = i + 1;
      deletions += 1;
      i += 1;
    } else {
      open.lines.push(next[j] as string);
      additions += 1;
      j += 1;
    }
  }
  close();
  return { additions, deletions, hunks };
}

// ---------------------------------------------------------------------------
// Three-way merges

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function blobText(store: ObjectStore, oid: string | undefined): string | null {
  if (oid === undefined) return null;
  const object = store.get(oid);
  if (object === undefined || object.type !== 'blob') return null;
  return object.data.toString('utf8');
}

/** The changed-file list between two flat path maps, with line counts. */
export function diffTrees(store: ObjectStore, from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) continue;
    if (before === undefined && after !== undefined) {
      const lines = splitLines(blobText(store, after) ?? '').length;
      changes.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (after === undefined && before !== undefined) {
      const lines = splitLines(blobText(store, before) ?? '').length;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else {
      const diff = diffLines(splitLines(blobText(store, before) ?? ''), splitLines(blobText(store, after) ?? ''));
      changes.push({
        filename: path,
        status: 'modified',
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
      });
    }
  }
  return changes;
}

/**
 * Merge two texts that both descend from `base`. Returns the merged text, or
 * null when the two sides changed the same base lines differently (or one
 * side is not text at all, signalled by the caller passing null).
 */
export function mergeTexts(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  const baseLines = splitLines(base);
  const oursDiff = diffLines(baseLines, splitLines(ours));
  const theirsDiff = diffLines(baseLines, splitLines(theirs));
  // The two sides conflict when their changed base ranges overlap and do not
  // agree on the replacement. Insertions at a point (start === end) conflict
  // only with a change covering that point or another insertion there with
  // different content.
  interface Hunk {
    start: number;
    end: number;
    lines: string[];
  }
  const overlaps = (a: Hunk, b: Hunk): boolean => {
    if (a.start === a.end && b.start === b.end) return a.start === b.start;
    if (a.start === a.end) return b.start < a.start && a.start < b.end;
    if (b.start === b.end) return a.start < b.start && b.start < a.end;
    return a.start < b.end && b.start < a.end;
  };
  const sameChange = (a: Hunk, b: Hunk): boolean =>
    a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((line, i) => line === b.lines[i]);
  for (const a of oursDiff.hunks) {
    for (const b of theirsDiff.hunks) {
      if (overlaps(a, b) && !sameChange(a, b)) return null;
    }
  }
  // Apply both sides' hunks to the base: walk base lines in order, emitting
  // each side's replacement where its hunk starts.
  const byStart = new Map<number, { end: number; lines: string[] }[]>();
  for (const hunk of [...oursDiff.hunks, ...theirsDiff.hunks]) {
    const list = byStart.get(hunk.start) ?? [];
    if (!list.some((existing) => existing.end === hunk.end && existing.lines.join('\n') === hunk.lines.join('\n'))) {
      list.push({ end: hunk.end, lines: hunk.lines });
    }
    byStart.set(hunk.start, list);
  }
  const out: string[] = [];
  let i = 0;
  while (i < baseLines.length) {
    const here = byStart.get(i);
    if (here !== undefined) {
      let furthest = i;
      for (const hunk of here) {
        out.push(...hunk.lines);
        furthest = Math.max(furthest, hunk.end);
      }
      if (furthest > i) {
        i = furthest;
        continue;
      }
      // Only pure insertions at this point: they precede the base line.
    }
    out.push(baseLines[i] as string);
    i += 1;
  }
  const tail = byStart.get(baseLines.length);
  if (tail !== undefined) {
    for (const hunk of tail) out.push(...hunk.lines);
  }
  const trailing = base.endsWith('\n') || ours.endsWith('\n') || theirs.endsWith('\n') ? '\n' : '';
  return out.join('\n') + (out.length > 0 ? trailing : '');
}

export interface MergeOutcome {
  ok: boolean;
  /** path -> blob oid of the merged tree (present when ok). */
  files: Map<string, string>;
  conflictPath?: string;
}

/**
 * Three-way merge of flat file maps: `ancestor` is the merge base's files,
 * `ours` the current base branch, `theirs` the head being merged in.
 */
export function mergeTrees(
  store: ObjectStore,
  ancestor: ReadonlyMap<string, string>,
  ours: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
): MergeOutcome {
  const files = new Map<string, string>();
  const paths = new Set<string>([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const inAncestor = ancestor.get(path);
    const inOurs = ours.get(path);
    const inTheirs = theirs.get(path);
    if (inOurs === inTheirs) {
      if (inOurs !== undefined) files.set(path, inOurs);
      continue;
    }
    if (inAncestor === inOurs) {
      // Only theirs changed it (or deleted it).
      if (inTheirs !== undefined) files.set(path, inTheirs);
      continue;
    }
    if (inAncestor === inTheirs) {
      // Only ours changed it.
      if (inOurs !== undefined) files.set(path, inOurs);
      continue;
    }
    // Both sides changed the same path differently.
    if (inOurs === undefined || inTheirs === undefined) {
      return { ok: false, files, conflictPath: path }; // delete vs modify
    }
    const baseText = blobText(store, inAncestor);
    const oursText = blobText(store, inOurs);
    const theirsText = blobText(store, inTheirs);
    if (baseText === null || oursText === null || theirsText === null) {
      return { ok: false, files, conflictPath: path };
    }
    const merged = mergeTexts(baseText, oursText, theirsText);
    if (merged === null) return { ok: false, files, conflictPath: path };
    files.set(path, storeObject(store, 'blob', Buffer.from(merged, 'utf8')));
  }
  return { ok: true, files };
}
