// The git object store: content-addressed commits, trees, blobs and tags,
// held in memory per repository. An object's id is the SHA-1 of its type
// header and bytes, exactly as git computes it, so anything the suite pushes
// keeps its id here and anything served back hashes to the same value.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** oid -> object, one map per repository. */
export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);
export const TYPE_IDS: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const TYPE_NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The id an object with these bytes owns: sha1("<type> <size>\0" + data). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Insert an object (idempotent) and answer its id. */
export function storeObject(store: ObjectStore, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  /** Octal mode as git writes it in the tree object: '100644', '40000', ... */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: bytewise by name, directories compared as name + '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  let lastKey = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) {
      // A continuation of the previous header (e.g. a signature block).
      if (lastKey === 'author') author += `\n${line}`;
      if (lastKey === 'committer') committer += `\n${line}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    lastKey = key;
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** The unix timestamp inside an author/committer line ("Name <mail> 123 +0000"). */
export function identityTimestamp(identityLine: string): number {
  const match = /> (\d+) /.exec(identityLine);
  return match ? Number(match[1]) : 0;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') view.object = value;
    else if (key === 'type') view.type = value;
    else if (key === 'tag') view.tag = value;
    else if (key === 'tagger') view.tagger = value;
  }
  return view;
}

/** Follow tag objects to the commit they ultimately name; null when not a commit. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** The commit a tag object points at directly, for advertisement peeling. */
export function peelOneLevel(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// ---------------------------------------------------------------------------
// Reachability

/** Every object reachable from the given tips: commits' ancestry, their trees, blobs, tags. */
export function closure(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree, ...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Only the tree-side objects (trees and blobs) under a tree oid. */
export function treeClosure(store: ObjectStore, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/** Is `ancestor` reachable from `descendant` through commit parents? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * A merge base of two commits: a common ancestor that is not itself an
 * ancestor of another common ancestor. With the suite's linear-plus-branch
 * histories the first common commit met walking back from `b` is the base.
 */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      stackA.push(...parseCommit(object.data).parents);
    }
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      queue.push(...parseCommit(object.data).parents);
    }
  }
  return null;
}

/** All commits reachable from a tip, tip first, breadth-first over parents. */
export function commitWalk(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Packs

interface PackEntryRaw {
  type: ObjectType;
  data: Buffer;
  /** Byte offset of this entry's header inside the pack, for ofs-delta bases. */
  offset: number;
  baseOid?: string;
  baseOffset?: number;
}

/** Apply a git delta stream (copy/insert instructions) onto a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 56) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, the delta expects ${sourceSize}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) copyOffset |= (delta[offset++] as number) << (8 * bit);
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) copySize |= (delta[offset++] as number) << (8 * bit);
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const count = op & 0x7f;
      delta.copy(out, written, offset, offset + count);
      offset += count;
      written += count;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a pack into the store. Delta entries are resolved against objects
 * already in the pack or, through `external`, objects the repository holds.
 * Answers the ids the pack carried (after resolution).
 */
export function readPack(store: ObjectStore, pack: Buffer, external?: (oid: string) => GitObject | undefined): string[] {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum does not match its bytes');

  const raw: PackEntryRaw[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeNumber = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNumber === 6) {
      // ofs-delta: a negative offset to the base entry, in git's offset encoding.
      let b = pack[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeNumber === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const data = inflated.buffer;
    if (data.length !== size) throw new Error(`pack entry inflated to ${data.length} bytes, its header says ${size}`);
    offset += inflated.engine.bytesWritten;
    const type = TYPE_IDS[typeNumber];
    if (type !== undefined) raw.push({ type, data, offset: entryOffset });
    else if (typeNumber === 6 || typeNumber === 7) raw.push({ type: 'blob', data, offset: entryOffset, baseOid, baseOffset });
    else throw new Error(`pack entry type ${typeNumber} is unknown`);
  }

  // Resolve in passes: plain entries land first, deltas once their base does.
  const byOffset = new Map<number, string>();
  const resolved: string[] = [];
  const lookup = (oid: string): GitObject | undefined => store.get(oid) ?? external?.(oid);
  let pending = raw;
  for (let pass = 0; pass <= raw.length && pending.length > 0; pass += 1) {
    const still: PackEntryRaw[] = [];
    for (const entry of pending) {
      const isDelta = entry.baseOid !== undefined || entry.baseOffset !== undefined;
      if (!isDelta) {
        const oid = storeObject(store, entry.type, entry.data);
        byOffset.set(entry.offset, oid);
        resolved.push(oid);
        continue;
      }
      let base: GitObject | undefined;
      if (entry.baseOid !== undefined) base = lookup(entry.baseOid);
      else if (entry.baseOffset !== undefined) {
        const baseOidResolved = byOffset.get(entry.baseOffset);
        if (baseOidResolved !== undefined) base = store.get(baseOidResolved);
      }
      if (base === undefined) {
        still.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.data);
      const oid = storeObject(store, base.type, data);
      byOffset.set(entry.offset, oid);
      resolved.push(oid);
    }
    pending = still;
  }
  if (pending.length > 0) throw new Error('pack holds a delta whose base never arrived');
  return resolved;
}

/** Write a pack carrying the given objects whole (no delta compression). */
export function writePack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const unique = [...new Set(oids)].filter((oid) => store.has(oid));
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(unique.length, 8);
  const parts: Buffer[] = [head];
  for (const oid of unique) {
    const object = store.get(oid) as GitObject;
    const typeNumber = TYPE_NUMBERS[object.type];
    let size = object.data.length;
    const headerBytes: number[] = [];
    let first = (typeNumber << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size = Math.floor(size / 128);
      if (size > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
