// Git smart HTTP: the /{owner}/{repo}.git surface. Advertisement and fetch
// speak protocol v2 (with a v0 advertisement for clients that ask), and
// receive-pack speaks v0, as the rules settle. Everything is served from the
// repository's own object store; refs are answered from the same map the
// REST contents API commits into, so the surfaces never disagree.

import {
  closure,
  isAncestor,
  isOid,
  peelToCommit,
  readPack,
  treeClosure,
  writePack,
  parseCommit,
  ZERO_OID,
  type ObjectStore,
} from './gitobjects.ts';
import { pkt, pktLines, PKT_FLUSH, sidebandWrap, unpkt, unpktPrefix, type Packet } from './pktline.ts';
import type { RepoRec } from './store.ts';

export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0';

function jsonAnswer(status: number, message: string): GitAnswer {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headRefOf(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// Advertisements

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headRefOf(repo)}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    lines.push(PKT_FLUSH);
    return Buffer.concat(lines);
  }
  const headOid = repo.refs.get(headRefOf(repo)) ?? ZERO_OID;
  lines.push(pkt(`${headOid} HEAD\0${caps}\n`));
  for (const [name, oid] of refs) {
    lines.push(pkt(`${oid} ${name}\n`));
    const peeled = peelToCommit(repo.objects, oid);
    if (peeled !== null && peeled !== oid) lines.push(pkt(`${peeled} ${name}^{}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n']),
    PKT_FLUSH,
  ]);
}

export function infoRefs(repo: RepoRec | undefined, service: 'git-upload-pack' | 'git-receive-pack', wantsV2: boolean): GitAnswer {
  if (repo === undefined) return jsonAnswer(404, 'Not Found');
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split a v2 command body into the lines before the delimiter and the arguments after it. */
function splitCommand(packets: readonly Packet[]): { head: string[]; args: string[] } {
  const head: string[] = [];
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    (afterDelim ? args : head).push(line);
  }
  return { head, args };
}

function lsRefs(repo: RepoRec, body: Buffer): GitAnswer {
  const { args } = splitCommand(unpkt(body));
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headRef = headRefOf(repo);
  if (matches('HEAD')) {
    const tip = repo.refs.get(headRef);
    if (tip !== undefined) lines.push(`${tip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    else if (unborn) lines.push(`unborn HEAD symref-target:${headRef}\n`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat([pktLines(lines), PKT_FLUSH]),
  };
}

// ---------------------------------------------------------------------------
// Fetch planning

interface FetchPlan {
  /** Every object id to pack. */
  send: Set<string>;
  /** Included commits whose parents were not sent: the shallow boundary. */
  boundary: Set<string>;
  /** Commits actually included (for unshallow computation). */
  includedCommits: Set<string>;
}

function planFetch(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // What the client provably holds: full closures of ordinary haves; for a
  // shallow have, the commit and its trees only — its parents are exactly
  // what the client does not have.
  const excluded = new Set<string>();
  const shallowRoots = new Set<string>();
  for (const have of haves) {
    const object = store.get(have);
    if (object === undefined) continue;
    if (shallowSet.has(have) && object.type === 'commit') {
      excluded.add(have);
      shallowRoots.add(have);
      treeClosure(store, parseCommit(object.data).tree, excluded);
    } else {
      for (const oid of closure(store, [have])) excluded.add(oid);
    }
  }

  const includedCommits = new Set<string>();
  const tagOids = new Set<string>();
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagOids.add(want);
      const commit = peelToCommit(store, want);
      if (commit !== null) queue.push({ oid: commit, gen: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    } else {
      tagOids.add(want); // a direct tree/blob want: send it as-is
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (includedCommits.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const mayExpand = depth === null || gen < depth - 1;
    if (excluded.has(oid)) {
      // A shallow have used as the walk's root: the client holds this commit
      // but not its parents, so the walk continues through it (deepen).
      // Any other excluded commit ends the walk: the client holds its past.
      if (shallowRoots.has(oid) && mayExpand) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
      }
      continue;
    }
    includedCommits.add(oid);
    if (mayExpand) {
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
    }
  }

  const boundary = new Set<string>();
  for (const oid of includedCommits) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (store.has(parent) && !includedCommits.has(parent)) boundary.add(oid);
    }
  }

  const send = new Set<string>([...includedCommits, ...tagOids]);
  for (const oid of includedCommits) {
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') treeClosure(store, parseCommit(object.data).tree, send);
  }
  for (const oid of excluded) send.delete(oid);
  return { send, boundary, includedCommits };
}

function fetchV2(repo: RepoRec, body: Buffer): GitAnswer {
  const { args } = splitCommand(unpkt(body));
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let shallowAspect = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) {
      clientShallow.push(arg.slice(8).trim());
      shallowAspect = true;
    } else if (arg.startsWith('deepen ')) {
      depth = Number.parseInt(arg.slice(7).trim(), 10);
      shallowAspect = true;
    } else if (arg.startsWith('deepen-since ') || arg.startsWith('deepen-not ')) {
      shallowAspect = true;
    }
  }
  if (depth !== null && Number.isFinite(depth)) shallowAspect = true;
  const plan = planFetch(repo.objects, wants, haves, clientShallow, depth !== null && Number.isFinite(depth) ? depth : null);

  const parts: Buffer[] = [];
  const commonHaves = haves.filter((have) => repo.objects.has(have));
  parts.push(pkt('acknowledgments\n'));
  if (commonHaves.length === 0) parts.push(pkt('NAK\n'));
  else {
    for (const have of commonHaves) parts.push(pkt(`ACK ${have}\n`));
    parts.push(pkt('ready\n'));
  }
  parts.push(PKT_FLUSH);

  if (shallowAspect) {
    const shallowLines: string[] = [];
    for (const oid of plan.boundary) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of clientShallow) {
      if (plan.includedCommits.has(oid) && !plan.boundary.has(oid)) shallowLines.push(`unshallow ${oid}\n`);
    }
    if (shallowLines.length > 0) {
      parts.push(pkt('shallow-info\n'), pktLines(shallowLines), PKT_FLUSH);
    }
  }

  const pack = writePack(repo.objects, plan.send);
  parts.push(pkt('packfile\n'), sidebandWrap(pack), PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(repo: RepoRec, body: Buffer): GitAnswer {
  const lines = dataLines(unpkt(body));
  const wants: string[] = [];
  const haves: string[] = [];
  let sideband = false;
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const [oid, caps] = rest.split(' ', 2) as [string, string | undefined];
      wants.push(oid);
      if (caps !== undefined && caps.includes('side-band-64k')) sideband = true;
      if (caps !== undefined && caps.includes('side-band')) sideband = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  const plan = planFetch(repo.objects, wants, haves, [], depth);
  const pack = writePack(repo.objects, plan.send);
  const parts: Buffer[] = [pkt('NAK\n')];
  if (sideband) parts.push(sidebandWrap(pack), PKT_FLUSH);
  else parts.push(pack);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** POST git-upload-pack: a v2 command (ls-refs / fetch) or a v0 fetch negotiation. */
export function uploadPack(repo: RepoRec | undefined, body: Buffer): GitAnswer {
  if (repo === undefined) return jsonAnswer(404, 'Not Found');
  try {
    const packets = unpkt(body);
    const firstData = packets.find((packet) => packet.kind === 'data');
    const firstLine = firstData !== undefined && firstData.kind === 'data' ? firstData.payload.toString('utf8') : '';
    if (firstLine.startsWith('command=ls-refs')) return lsRefs(repo, body);
    if (firstLine.startsWith('command=fetch')) return fetchV2(repo, body);
    return fetchV0(repo, body);
  } catch (err) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`error: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8') };
  }
}

// ---------------------------------------------------------------------------
// Receive-pack (protocol v0)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: unpack the pack, judge each ref update, report. */
export function receivePack(repo: RepoRec | undefined, body: Buffer): GitAnswer {
  if (repo === undefined) return jsonAnswer(404, 'Not Found');
  let commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let pack = Buffer.alloc(0);
  try {
    const { packets, rest } = unpktPrefix(body);
    pack = rest;
    packets.forEach((packet, index) => {
      if (packet.kind !== 'data') return;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean));
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length === 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
      }
    });
  } catch (err) {
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`error: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8') };
  }

  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      readPack(repo.objects, pack);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [`unpack ${unpackError === null ? 'ok' : unpackError}\n`];
  for (const command of commands) {
    if (unpackError !== null) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      reportLines.push(`ng ${command.ref} unreachable\n`);
      continue;
    }
    if (current === ZERO_OID) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (current === command.newOid) {
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const currentCommit = peelToCommit(repo.objects, current);
    const newCommit = peelToCommit(repo.objects, command.newOid);
    if (currentCommit !== null && newCommit !== null && isAncestor(repo.objects, currentCommit, newCommit)) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }

  const wantsReport = capabilities.has('report-status') || capabilities.has('report-status-v2');
  if (!wantsReport) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportStream = Buffer.concat([pktLines(reportLines), PKT_FLUSH]);
  if (capabilities.has('side-band-64k')) {
    // The report stream travels inside band-1 frames; a raw flush ends it.
    const framed = Buffer.concat([sidebandWrap(reportStream), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: framed };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStream };
}
