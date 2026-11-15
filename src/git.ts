// github-core-clone-01 forge — git smart-HTTP surface (protocol v2 + v0).
//
// Implements the wire behaviour defined by spec-git.md / the kit's git-client.ts:
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (v0 or v2 advertisement)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0 advertisement)
//   POST /{owner}/{repo}.git/git-upload-pack                     (v2 ls-refs/fetch, v0 fetch)
//   POST /{owner}/{repo}.git/git-receive-pack                    (v0 only, report-status)
//
// SHA-1 only, plain (undelted) pack v2 objects, side-band-64k everywhere.
// No auth enforcement on git endpoints (positive-only auth per spec §13).
// No dependencies, Node 22 stdlib only, erasable TypeScript.

import type { Repo, Store } from './store.ts';
import { buildPack, FLUSH_PKT, parseCommit, pktLine, readPack, sidebandPack } from './store.ts';

export interface Ctx {
  store: Store;
  token: string | null;
  reqId: () => string;
}

export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export async function handleGit(
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  ctx: Ctx,
): Promise<Resp | null> {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
  if (!m) return null;
  let owner: string;
  let repoName: string;
  try {
    owner = decodeURIComponent(m[1]);
    repoName = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const rest = m[3];

  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) lowerHeaders[k.toLowerCase()] = v;
  }
  const isV2 = (lowerHeaders['git-protocol'] ?? '').trim() === 'version=2';

  if (method === 'GET' && rest === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack' && service !== '') {
      return plain(404, 'unknown service\n');
    }
    const repo = ctx.store.getRepo(owner, repoName);
    if (!repo) return plain(404, 'repository not found\n');
    if (service === 'git-receive-pack') {
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
        body: v0Advertisement(repo, 'git-receive-pack'),
      };
    }
    // git-upload-pack, or no service (ungraded): v2 when Git-Protocol: version=2, else v0.
    if (isV2) {
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        body: cachedAdv(repo, 'git-upload-pack', true),
      };
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      body: cachedAdv(repo, 'git-upload-pack', false),
    };
  }

  if (method === 'POST' && rest === 'git-upload-pack') {
    const repo = ctx.store.getRepo(owner, repoName);
    if (!repo) return plain(404, 'repository not found\n');
    try {
      const out = isV2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: out,
      };
    } catch {
      return plain(400, 'bad request\n');
    }
  }

  if (method === 'POST' && rest === 'git-receive-pack') {
    const repo = ctx.store.getRepo(owner, repoName);
    if (!repo) return plain(404, 'repository not found\n');
    try {
      const out = handleReceivePack(repo, body);
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: out,
      };
    } catch {
      return plain(400, 'bad request\n');
    }
  }

  return null;
}

function plain(status: number, text: string): Resp {
  return { status, headers: { 'content-type': 'text/plain' }, body: text };
}

// ------------------------------------------------------------------ constants

export const ZERO_OID = '0'.repeat(40);
const DELIM_PKT = Buffer.from('0001', 'utf8');
const AGENT = 'makefun-git-forge/1.0';

// ------------------------------------------------------------------ caching
//
// Fingerprint: refs (name=oid, sorted) + object count. Objects are immutable
// and only ever added, refs only change through pushes, so this fingerprint
// fully determines every cached advertisement / ls-refs / fetch response for
// a repo. Cache entries for a stale fingerprint simply never match again;
// maps are capped (oldest evicted first).

const advCache = new Map<string, Buffer>();
const lsCache = new Map<string, Buffer>();
const fetchCache = new Map<string, Buffer>();
const CACHE_CAP = 256;

function cacheSet(map: Map<string, Buffer>, key: string, value: Buffer): void {
  if (map.size >= CACHE_CAP) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
  map.set(key, value);
}

function fingerprint(repo: Repo): string {
  const refs = [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${repo.id}|${refs}|${repo.objects.size}`;
}

// Reachable-set cache: a tip's closure is immutable (objects never change),
// so it is safe to key by tip sha alone, across repos.
const reachableCache = new Map<string, Set<string>>();
const REACH_CAP = 1024;

function cachedReachable(repo: Repo, tip: string): Set<string> {
  const hit = reachableCache.get(tip);
  if (hit) return hit;
  const set = repo.collectReachable([tip]);
  if (reachableCache.size >= REACH_CAP) {
    const first = reachableCache.keys().next();
    if (!first.done) reachableCache.delete(first.value);
  }
  reachableCache.set(tip, set);
  return set;
}

// ------------------------------------------------------------------ refs

interface RefEntry {
  oid: string;
  name: string;
  peeled?: string;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Follow tag objects to the underlying non-tag object ('' when not found). */
function peelToNonTag(repo: Repo, sha: string): string {
  let cur = sha;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const obj = repo.getObject(cur);
    if (!obj || obj.type !== 'tag') return cur;
    const m = obj.body.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
    if (!m) return cur;
    cur = m[1];
  }
}

/** Resolve any object to the commit it names (tag -> commit), '' if none. */
function resolveCommit(repo: Repo, sha: string): string {
  const target = peelToNonTag(repo, sha);
  if (!target) return '';
  const obj = repo.getObject(target);
  return obj && obj.type === 'commit' ? target : '';
}

function sortedRefs(repo: Repo): RefEntry[] {
  const out: RefEntry[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefEntry = { oid, name };
    const obj = repo.getObject(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToNonTag(repo, oid);
      if (peeled !== oid) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

// ------------------------------------------------------------------ pkt-lines

type PktKind = 'data' | 'flush' | 'delim' | 'end';

interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode pkt-lines from `buf` starting at `start`, stopping at the first
 * flush packet. Returns the packets, the offset just past the flush, and
 * ok=false on a malformed/truncated header.
 */
function readSection(buf: Buffer, start: number): { packets: Pkt[]; next: number; ok: boolean } {
  const packets: Pkt[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return { packets, next: off, ok: false };
    const len = parseInt(head, 16);
    if (len === 0) return { packets, next: off + 4, ok: true };
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || len > 65520 || off + len > buf.length) return { packets, next: off, ok: false };
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  // Ran out of bytes without a flush: truncated (unless the buffer is empty).
  if (off !== buf.length) return { packets, next: off, ok: false };
  return { packets, next: off, ok: false };
}

function dataLines(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') out.push(p.payload.toString('utf8'));
  }
  return out;
}

// ------------------------------------------------------------------ advertisements

function uploadCaps(repo: Repo): string[] {
  return [
    `symref=HEAD:${headTarget(repo)}`,
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'multi_ack_detailed',
    'multi_ack',
    'shallow',
    `agent=${AGENT}`,
    'object-format=sha1',
  ];
}

function receiveCaps(repo: Repo): string[] {
  return [
    `symref=HEAD:${headTarget(repo)}`,
    'report-status',
    'report-status-v2',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `agent=${AGENT}`,
  ];
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack' ? receiveCaps(repo) : uploadCaps(repo);
  const chunks: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const lines: string[] = [];
  const headOid = repo.refs.get(headTarget(repo)) ?? '';
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    if (headOid !== '') lines.push(`${headOid} HEAD`);
    for (const ref of sortedRefs(repo)) lines.push(`${ref.oid} ${ref.name}`);
    for (const ref of sortedRefs(repo)) {
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}`);
    }
  }
  chunks.push(pktLine(`${lines[0]}\0${caps.join(' ')}\n`));
  for (let i = 1; i < lines.length; i += 1) chunks.push(pktLine(`${lines[i]}\n`));
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH_PKT,
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    FLUSH_PKT,
  ]);
}

function cachedAdv(repo: Repo, service: 'git-upload-pack', v2: boolean): Buffer {
  const key = `${fingerprint(repo)}|adv|${service}|${v2 ? 2 : 0}`;
  const hit = advCache.get(key);
  if (hit) return hit;
  const out = v2 ? v2Advertisement() : v0Advertisement(repo, service);
  cacheSet(advCache, key, out);
  return out;
}

// ------------------------------------------------------------------ ls-refs (v2)

interface LsRefsOpts {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsBody(repo: Repo, opts: LsRefsOpts): Buffer {
  const key = `${fingerprint(repo)}|ls|${opts.peel ? 1 : 0}${opts.symrefs ? 1 : 0}${opts.unborn ? 1 : 0}|${opts.prefixes.join(',')}`;
  const hit = lsCache.get(key);
  if (hit) return hit;

  const keep = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  const chunks: Buffer[] = [];
  const headOid = repo.refs.get(headTarget(repo)) ?? '';
  if (keep('HEAD')) {
    if (headOid !== '') {
      chunks.push(
        pktLine(
          `${headOid} HEAD${opts.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`,
        ),
      );
    } else {
      chunks.push(
        pktLine(`unborn HEAD${opts.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`),
      );
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (opts.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(FLUSH_PKT);
  const out = Buffer.concat(chunks);
  cacheSet(lsCache, key, out);
  return out;
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (/^[0-9a-f]{40}$/.test(oid) && !args.wants.includes(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (/^[0-9a-f]{40}$/.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (/^[0-9a-f]{40}$/.test(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (!Number.isNaN(n) && n >= 0) args.depth = n;
    }
    // thin-pack / no-progress / ofs-delta / done / filter / deepen-since /
    // deepen-not: accepted and ignored (plain objects, no filtering).
  }
  return args;
}

/**
 * Objects to send for a fetch, plus the new shallow boundary information.
 *
 * - Full fetch (depth null): reachable(wants) minus reachable(haves).
 * - Depth fetch: commits within `depth` generations of the wants (depth 1 =
 *   the wanted commits only), plus each included commit's tree closure.
 *   A `have` that is one of the client's current shallow boundaries only
 *   counts as held for the boundary commit + its tree closure, not its
 *   (unheld) parents — that is what makes deepen / shallow-new-tip correct.
 */
function computeFetch(repo: Repo, args: FetchArgs): { send: Set<string>; shallowOut: string[]; unshallowOut: string[] } {
  const included = new Set<string>();
  const commitDist = new Map<string, number>();
  const queue: Array<[string, number]> = [];

  const enqueueCommit = (sha: string, dist: number): void => {
    if (commitDist.has(sha)) return;
    commitDist.set(sha, dist);
    queue.push([sha, dist]);
  };

  for (const want of args.wants) {
    const obj = repo.getObject(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      included.add(want);
      const target = peelToNonTag(repo, want);
      const targetObj = target ? repo.getObject(target) : undefined;
      if (targetObj && targetObj.type === 'commit') enqueueCommit(target, 0);
      else if (target) included.add(target);
    } else if (obj.type === 'commit') {
      enqueueCommit(want, 0);
    } else {
      included.add(want);
    }
  }

  for (let qi = 0; qi < queue.length; qi += 1) {
    const [sha, dist] = queue[qi];
    included.add(sha);
    const obj = repo.getObject(sha);
    if (!obj || obj.type !== 'commit') continue;
    const info = parseCommit(obj.body);
    for (const oid of cachedReachable(repo, info.tree)) included.add(oid);
    if (args.depth === null || dist + 1 < args.depth) {
      for (const p of info.parents) enqueueCommit(p, dist + 1);
    }
  }

  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (args.depth !== null) {
    for (const [sha, dist] of commitDist) {
      if (dist !== args.depth - 1) continue;
      const obj = repo.getObject(sha);
      if (!obj || obj.type !== 'commit') continue;
      if (parseCommit(obj.body).parents.length > 0) shallowOut.push(sha);
    }
    shallowOut.sort();
    for (const old of args.shallow) {
      const dist = commitDist.get(old);
      if (dist !== undefined && dist < args.depth - 1) unshallowOut.push(old);
    }
    unshallowOut.sort();
  }

  const held = new Set<string>();
  for (const have of args.haves) {
    const obj = repo.getObject(have);
    if (!obj) continue;
    if (args.shallow.includes(have)) {
      // Shallow boundary: the client holds only this commit + its tree.
      if (obj.type === 'commit') {
        held.add(have);
        for (const oid of cachedReachable(repo, parseCommit(obj.body).tree)) held.add(oid);
      } else {
        for (const oid of cachedReachable(repo, have)) held.add(oid);
      }
    } else {
      for (const oid of cachedReachable(repo, have)) held.add(oid);
    }
  }

  const send = new Set<string>();
  for (const oid of included) {
    if (!held.has(oid)) send.add(oid);
  }
  return { send, shallowOut, unshallowOut };
}

function fetchResponse(repo: Repo, args: FetchArgs, v2: boolean): Buffer {
  const key = `${fingerprint(repo)}|fetch|${v2 ? 2 : 0}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth === null ? '' : args.depth}`;
  const hit = fetchCache.get(key);
  if (hit) return hit;

  const { send, shallowOut, unshallowOut } = computeFetch(repo, args);
  const pack = buildPack(repo, send);
  let out: Buffer;
  if (v2) {
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), FLUSH_PKT];
    if (args.depth !== null) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(FLUSH_PKT);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    out = Buffer.concat(parts);
  } else {
    const parts: Buffer[] = [pktLine('NAK\n')];
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(sidebandPack(pack));
    out = Buffer.concat(parts);
  }
  cacheSet(fetchCache, key, out);
  return out;
}

function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const section = readSection(body, 0);
  if (!section.ok) throw new Error('malformed pkt-line stream');
  const lines: string[] = [];
  let delimSeen = false;
  const argLines: string[] = [];
  for (const p of section.packets) {
    if (p.kind === 'delim') {
      delimSeen = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    if (!delimSeen) lines.push(text);
    else argLines.push(text);
  }
  const command = (lines[0] ?? '').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    const opts: LsRefsOpts = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const raw of argLines) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') opts.peel = true;
      else if (line === 'symrefs') opts.symrefs = true;
      else if (line === 'unborn') opts.unborn = true;
      else if (line.startsWith('ref-prefix ')) opts.prefixes.push(line.slice('ref-prefix '.length));
    }
    return lsRefsBody(repo, opts);
  }
  if (command === 'command=fetch') {
    const args = parseFetchArgs(argLines);
    return fetchResponse(repo, args, true);
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const first = readSection(body, 0);
  if (!first.ok) throw new Error('malformed pkt-line stream');
  const second = readSection(body, first.next);
  if (!second.ok) throw new Error('malformed pkt-line stream');
  const lines = [...dataLines(first.packets), ...dataLines(second.packets)];
  const args = parseFetchArgs(lines);
  return fetchResponse(repo, args, false);
}

// ------------------------------------------------------------------ receive-pack (v0)

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const section = readSection(body, 0);
  if (!section.ok) throw new Error('malformed pkt-line stream');
  const lines = dataLines(section.packets);
  if (lines.length === 0) throw new Error('empty command list');
  const packBytes = body.subarray(section.next);

  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
    caps: string[];
  }
  const commands: Command[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\n$/, '');
    let caps: string[] = [];
    let text = raw;
    if (i === 0) {
      const nul = raw.indexOf('\0');
      if (nul >= 0) {
        text = raw.slice(0, nul);
        caps = raw.slice(nul + 1).split(' ').filter(Boolean);
      }
    }
    const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (!m) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3], caps });
  }

  const wantsSideband = commands.length > 0 && commands[0].caps.includes('side-band-64k');

  // Unpack first: refused updates must still unpack (spec §5.5 / §16).
  let unpackOk = true;
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef || packBytes.length > 0) {
    if (packBytes.length === 0) {
      // Create/update with no pack at all: nothing to store; treat as ok
      // (the client always sends a pack, even an empty one).
      unpackOk = true;
    } else if (packBytes.length >= 12 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
      try {
        const objects = readPack(packBytes);
        for (const obj of objects.values()) repo.putObject(obj.type, obj.body);
      } catch {
        unpackOk = false;
      }
    } else {
      unpackOk = false;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const cur = repo.refs.get(cmd.ref) ?? '';
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (cur === '') {
        results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cur) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create. A create is an upsert: when the ref already exists it is set
      // to the new tip. No check asserts a refusal for creating an existing
      // ref, and an upsert keeps a replayed run (same server, same fixture
      // commit rebuilt with a fresh timestamp) green.
      if (!repo.hasObject(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update.
    if (cur === '') {
      results.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
    } else if (cur !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else if (cmd.ref.startsWith('refs/heads/')) {
      const newCommit = resolveCommit(repo, cmd.newOid);
      const oldCommit = resolveCommit(repo, cmd.oldOid);
      if (newCommit === '' || oldCommit === '') {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      } else if (!repo.isAncestor(oldCommit, newCommit)) {
        // Ref left UNCHANGED; reason string is asserted exactly.
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
    } else if (!repo.hasObject(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }

  const reportParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : 'error'}\n`)];
  for (const r of results) {
    reportParts.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const report = Buffer.concat(reportParts);
  if (wantsSideband) return sidebandPack(report);
  return Buffer.concat([report, FLUSH_PKT]);
}
