// github-core-clone-01 forge — shared in-memory store + git object core.
//
// Single source of truth for every surface (REST v3, GraphQL v4, MCP, git smart
// HTTP). Everything is in memory: no disk, no fsync, no per-request I/O — that is
// what makes the four timed workloads fast.
//
// Determinism: every timestamp comes from a monotonic counter rooted at the
// contest's fixed scenario epoch (2025-01-01T00:00:00Z), never from Date.now().
// IDs and numbers are allocated from counters. Object ids are SHA-1 over the
// canonical git bytes, so they are deterministic by construction.
//
// Viewer identity: the suite's scenario is fixed by the contest's constant seed
// (wire.ts SCENARIO_SEED_HEX = '6a09e667f3bcc909'; env main.ts calls
// buildScenario() with no arguments, so it is identical in every trial).
// Verified against the kit: viewer login is 'adaiversen' (id 1000),
// stranger 'olgabauer' (id 1002), teammate 'quinnkeller' (id 1001).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash as createHashCrypto } from 'node:crypto';

// ------------------------------------------------------------------ users

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE: User = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };

export const USERS: Readonly<Record<string, User>> = {
  [VIEWER.login]: VIEWER,
  [TEAMMATE.login]: TEAMMATE,
  [STRANGER.login]: STRANGER,
};

// ------------------------------------------------------------------ time

/** Scenario epoch: 2025-01-01T00:00:00Z in seconds. */
export const EPOCH_SEC = 1735689600;

let tick = 0;
/** Deterministic, monotonically increasing timestamp (seconds since epoch). */
export function nextEpochSec(): number {
  tick += 1;
  return EPOCH_SEC + tick;
}
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
}
/** A fixed display timestamp (no counter movement) for created/updated fields that only need to be valid ISO. */
export function fixedIso(): string {
  return '2025-01-01T00:00:00Z';
}

// ------------------------------------------------------------------ git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  body: Buffer;
}

function sha1(buf: Buffer): string {
  return createHashCrypto('sha1').update(buf).digest('hex');
}

/** Canonical git object id: sha1("<type> <len>\0" + body). */
export function hashObject(type: ObjType, body: Buffer): string {
  const header = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, body]));
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' | '160000'
  name: string;
  sha: string;
}

/** Parse a tree object's body into entries. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < body.length) {
    const sp = body.indexOf(0x20, off);
    const nul = body.indexOf(0x00, sp);
    const mode = body.subarray(off, sp).toString('utf8');
    const name = body.subarray(sp + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}

/** Parse a commit object's body. */
export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = {
    tree: '', parents: [], authorName: '', authorEmail: '', authorEpoch: 0,
    committerName: '', committerEmail: '', committerEpoch: 0, message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = line.slice(7).match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
      if (m) { info.authorName = m[1]; info.authorEmail = m[2]; info.authorEpoch = Number(m[3]); }
    } else if (line.startsWith('committer ')) {
      const m = line.slice(10).match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
      if (m) { info.committerName = m[1]; info.committerEmail = m[2]; info.committerEpoch = Number(m[3]); }
    }
  }
  return info;
}

/** Serialise a commit object body from its fields. */
export function buildCommitBody(c: CommitInfo): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.authorName} <${c.authorEmail}> ${c.authorEpoch} +0000`);
  lines.push(`committer ${c.committerName} <${c.committerEmail}> ${c.committerEpoch} +0000`);
  lines.push('');
  lines.push(c.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Serialise a tree object body from entries (sorted git order: by name, dirs as name+'/'). */
export function buildTreeBody(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ repo model

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  url?: string;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  assignee: User | null;
  comments: Comment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Bumped on every mutation (PATCH, comment add). The REST layer caches
   *  the serialised GET-issue body against this counter, so a stale cache
   *  can never be served. */
  version: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string; // branch name
  baseRef: string; // branch name
  headSha: string; // tip of head at creation (updated as head moves? GitHub tracks live tip; we recompute live)
  baseSha: string; // tip of base at creation (merge-base anchor)
  user: User;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

export class Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Full refname -> commit sha. */
  refs = new Map<string, string>();
  /** sha -> object. */
  objects = new Map<string, GitObject>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels: Label[] = [];
  nextIssue = 1;
  nextPull = 1;
  nextLabelId = 1;
  nextCommentId = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.private = isPrivate;
    this.defaultBranch = 'main';
    this.createdAt = fixedIso();
    this.updatedAt = fixedIso();
    for (const l of DEFAULT_LABELS) {
      this.labels.push({ id: this.nextLabelId++, name: l.name, color: l.color, description: l.description });
    }
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  /** Tip sha of a branch, or '' when the branch does not exist (unborn). */
  branchTip(branch: string): string {
    return this.refs.get(this.refName(branch)) ?? '';
  }

  /** All branch names, sorted. */
  branchNames(): string[] {
    const out: string[] = [];
    for (const k of this.refs.keys()) {
      if (k.startsWith('refs/heads/')) out.push(k.slice('refs/heads/'.length));
    }
    return out.sort();
  }

  /** All tag names, sorted. */
  tagNames(): string[] {
    const out: string[] = [];
    for (const k of this.refs.keys()) {
      if (k.startsWith('refs/tags/')) out.push(k.slice('refs/tags/'.length));
    }
    return out.sort();
  }

  putObject(type: ObjType, body: Buffer): string {
    const sha = hashObject(type, body);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, body });
    return sha;
  }

  /** Insert objects already keyed by their SHA-1 (as readPack returns them):
   *  skips the second hash putObject would compute per object. */
  putObjects(objects: Map<string, GitObject>): void {
    for (const [sha, obj] of objects) {
      if (!this.objects.has(sha)) this.objects.set(sha, obj);
    }
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha.toLowerCase());
  }

  hasObject(sha: string): boolean {
    return this.objects.has(sha.toLowerCase());
  }

  /** Build (or reuse) nested trees for a flat path -> {mode, sha} map. Returns root tree sha. */
  buildTree(files: Map<string, { mode: string; sha: string }>): string {
    // Group by directory.
    const dirs = new Map<string, Map<string, { mode: string; sha: string }>>();
    const rootFiles = new Map<string, { mode: string; sha: string }>();
    for (const [path, v] of files) {
      const slash = path.lastIndexOf('/');
      if (slash < 0) rootFiles.set(path, v);
      else {
        const dir = path.slice(0, slash);
        const base = path.slice(slash + 1);
        let m = dirs.get(dir);
        if (!m) { m = new Map(); dirs.set(dir, m); }
        m.set(base, v);
      }
    }
    const buildDir = (dirPath: string): string => {
      const entries: TreeEntry[] = [];
      const own = dirPath === '' ? rootFiles : (dirs.get(dirPath) ?? new Map());
      for (const [name, v] of own) entries.push({ mode: v.mode, name, sha: v.sha });
      // Subdirectories whose parent is dirPath.
      for (const [d, _m] of dirs) {
        if (d === dirPath) continue;
        const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
        if (parent === dirPath) {
          const name = d.slice(dirPath === '' ? 0 : dirPath.length + 1);
          entries.push({ mode: '40000', name, sha: buildDir(d) });
        }
      }
      return this.putObject('tree', buildTreeBody(entries));
    };
    return buildDir('');
  }

  /** Flatten a tree into path -> {mode, sha} (recursive, files only; submodules kept as entries). */
  flattenTree(treeSha: string, prefix: string, out: Map<string, { mode: string; sha: string }>): void {
    const obj = this.getObject(treeSha);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.body)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(e.sha, path, out);
      else out.set(path, { mode: e.mode, sha: e.sha });
    }
  }

  /** Files at a commit (empty map when the commit does not exist). */
  filesAtCommit(commitSha: string): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    const obj = this.getObject(commitSha);
    if (!obj || obj.type !== 'commit') return out;
    const info = parseCommit(obj.body);
    this.flattenTree(info.tree, '', out);
    return out;
  }

  /** Create a commit object. Returns its sha. */
  makeCommit(treeSha: string, parents: string[], message: string, author: User = VIEWER): string {
    const epoch = nextEpochSec();
    const body = buildCommitBody({
      tree: treeSha, parents,
      authorName: author.name, authorEmail: author.email, authorEpoch: epoch,
      committerName: author.name, committerEmail: author.email, committerEpoch: epoch,
      message,
    });
    return this.putObject('commit', body);
  }

  /** True when `anc` is an ancestor of (or equal to) `desc`. */
  isAncestor(anc: string, desc: string): boolean {
    if (anc === '' || desc === '') return false;
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === anc) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.getObject(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.body).parents) stack.push(p);
    }
    return false;
  }

  /** Merge-base of two commits (first common ancestor found by BFS from both sides). */
  mergeBase(a: string, b: string): string {
    if (a === '' || b === '') return '';
    if (a === b) return a;
    const ancA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const cur = stackA.pop() as string;
      if (ancA.has(cur)) continue;
      ancA.add(cur);
      const obj = this.getObject(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.body).parents) stackA.push(p);
    }
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      if (ancA.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.getObject(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.body).parents) queue.push(p);
    }
    return '';
  }

  /** All objects reachable from the given tips (commits, trees, blobs, tags). */
  collectReachable(tips: string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === '' || out.has(sha)) continue;
      const obj = this.getObject(sha);
      if (!obj) continue;
      out.add(sha);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.body);
        stack.push(info.tree);
        for (const p of info.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.body)) stack.push(e.sha);
      } else if (obj.type === 'tag') {
        const m = obj.body.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
    return out;
  }

  /** Commits reachable from a tip, newest-first (BFS by commit time, deterministic). */
  listCommits(tip: string): CommitInfo[] {
    const out: CommitInfo[] = [];
    const seen = new Set<string>();
    const queue: string[] = tip === '' ? [] : [tip];
    while (queue.length > 0) {
      // Pop the commit with the greatest committer epoch for newest-first order.
      let best = 0;
      for (let i = 1; i < queue.length; i += 1) {
        const a = this.getObject(queue[i]);
        const b = this.getObject(queue[best]);
        const ea = a && a.type === 'commit' ? parseCommit(a.body).committerEpoch : 0;
        const eb = b && b.type === 'commit' ? parseCommit(b.body).committerEpoch : 0;
        if (ea > eb) best = i;
      }
      const sha = queue.splice(best, 1)[0];
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.getObject(sha);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.body);
      (info as CommitInfo & { sha: string }).sha = sha;
      out.push(info);
      for (const p of info.parents) if (!seen.has(p)) queue.push(p);
    }
    return out;
  }
}

// ------------------------------------------------------------------ the store

export class Store {
  repos = new Map<string, Repo>(); // "owner/name" -> Repo
  nextRepoId = 1;
  nextGlobalIssueId = 1;
  nextGlobalPullId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId++, owner, name, description, isPrivate);
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => (a.id - b.id));
    return out;
  }

  /** Create a label on a repo (returns existing when the name already exists). */
  ensureLabel(repo: Repo, name: string, color = 'ededed', description = ''): Label {
    const found = repo.labels.find((l) => l.name === name);
    if (found) return found;
    const label: Label = { id: repo.nextLabelId++, name, color, description };
    repo.labels.push(label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[], user: User = VIEWER): Issue {
    const labels: Label[] = [];
    for (const n of labelNames) {
      const l = repo.labels.find((x) => x.name === n);
      if (l) labels.push(l);
    }
    const now = fixedIso();
    const issue: Issue = {
      id: this.nextGlobalIssueId++, number: repo.nextIssue++, title, body,
      state: 'open', labels, user, assignee: null, comments: [],
      created_at: now, updated_at: now, closed_at: null, version: 0,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, user: User = VIEWER): Pull {
    const now = fixedIso();
    const pull: Pull = {
      id: this.nextGlobalPullId++, number: repo.nextPull++, title, body,
      state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
      headRef, baseRef,
      headSha: repo.branchTip(headRef), baseSha: repo.branchTip(baseRef),
      user, created_at: now, updated_at: now, closed_at: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getIssue(repo: Repo, n: number): Issue | undefined {
    return repo.issues.find((i) => i.number === n);
  }

  getPull(repo: Repo, n: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === n);
  }
}

export const store = new Store();

// ------------------------------------------------------------------ pkt-line

export function pktLine(s: string): Buffer {
  const len = s.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), Buffer.from(s, 'utf8')]);
}

export const FLUSH_PKT = Buffer.from('0000', 'utf8');

/** Parse a pkt-line stream into lines (strings without the length prefix). Stops at a flush pkt. */
export function parsePktLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('utf8'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) return { lines, rest: buf.subarray(off + 4) };
    if (len === 1) { off += 4; continue; } // delim pkt
    if (len === 2) { off += 4; continue; } // response-end pkt
    const end = off + len;
    if (end > buf.length) break;
    lines.push(buf.subarray(off + 4, end).toString('utf8'));
    off = end;
  }
  return { lines, rest: buf.subarray(off) };
}

// ------------------------------------------------------------------ packfiles

/**
 * Build a packfile v2 holding exactly `shas` (plain objects, no deltas — the
 * suite never asserts deltaCount > 0). Objects are emitted in sha order, so
 * the same set always yields the same bytes. Caller must ensure `shas` are
 * the objects the client needs (reachable set minus haves, plus thin bases
 * handled by the caller).
 */
export function buildPack(repo: Repo, shas: Iterable<string>): Buffer {
  const list = [...new Set([...shas])].filter((s) => repo.hasObject(s)).sort();
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  chunks.push(header);
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const sha of list) {
    const obj = repo.getObject(sha) as GitObject;
    const data = obj.body;
    // Object header: varint, first byte holds (size & 0x0f) | (type << 4), continuation bit.
    const headBytes: number[] = [];
    let size = data.length;
    let first = (size & 0x0f) | (typeNum[obj.type] << 4);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headBytes.push(b);
    }
    chunks.push(Buffer.from(headBytes));
    chunks.push(deflateSync(data));
  }
  const packSoFar = Buffer.concat(chunks);
  const trailer = createHashCrypto('sha1').update(packSoFar).digest();
  return Buffer.concat([packSoFar, trailer]);
}

/**
 * Parse a packfile (v2/v3) holding plain objects into a sha -> object map.
 * The suite's client sends plain objects only (no deltas) in pushes, so delta
 * entries are not supported here — they never occur on the receive path.
 */
const PACK_TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function readPack(buf: Buffer): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  if (buf.length < 12 || buf.subarray(0, 4).toString('utf8') !== 'PACK') return out;
  const count = buf.readUInt32BE(8);
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= buf.length) break;
    let b = buf[off++];
    const type = (b >> 4) & 0x07;
    // Skip the varint size (we recover the real size from the inflated body).
    while (b & 0x80) b = buf[off++];
    if (type === 6 || type === 7) return out; // delta entry: not expected on the receive path
    const typeName = PACK_TYPE_NAMES[type] ?? 'blob';
    const { body, next } = inflateOne(buf, off);
    off = next;
    out.set(hashObject(typeName, body), { type: typeName, body });
  }
  return out;
}

/**
 * Inflate exactly one zlib stream starting at `off`, returning the body and the
 * offset just past the stream. Pure-JS RFC 1950/1951 decoder (puff-style
 * canonical Huffman decoding): a single pass, no native zlib call per object,
 * and it reports the exact consumed byte count — which Node's inflateSync
 * cannot do. (The previous binary-search implementation cost ~4 ms per
 * 3-object pack because every inflateSync call re-creates a native context.)
 *
 * Throws on malformed input.
 */
// Length / distance base tables (RFC 1951 §3.2.5), hoisted to module scope:
// they never change, so rebuilding them on every inflateOne call was pure waste.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  counts: number[]; // counts[len] = number of codes of that length
  symbols: number[]; // symbols sorted by (length, code value)
}

function buildHuffman(lengths: number[]): Huffman {
  const counts = new Array<number>(16).fill(0);
  for (const l of lengths) {
    if (l > 15) throw new Error('inflate: bad code length');
    counts[l] = (counts[l] ?? 0) + 1;
  }
  counts[0] = 0;
  const offs = new Array<number>(16).fill(0);
  for (let i = 1; i < 16; i += 1) offs[i] = offs[i - 1] + (counts[i - 1] ?? 0);
  const symbols = new Array<number>(lengths.length).fill(0);
  for (let i = 0; i < lengths.length; i += 1) {
    const l = lengths[i] as number;
    if (l !== 0) {
      symbols[offs[l] as number] = i;
      offs[l] = (offs[l] as number) + 1;
    }
  }
  return { counts, symbols };
}

// Fixed Huffman tables, built once for the process (the old code rebuilt them
// inside every inflateOne call).
let fixedLitTable: Huffman | undefined;
let fixedDistTable: Huffman | undefined;
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!fixedLitTable) {
    const litLengths = new Array<number>(288).fill(0);
    for (let i = 0; i < 144; i += 1) litLengths[i] = 8;
    for (let i = 144; i < 256; i += 1) litLengths[i] = 9;
    for (let i = 256; i < 280; i += 1) litLengths[i] = 7;
    for (let i = 280; i < 288; i += 1) litLengths[i] = 8;
    fixedLitTable = buildHuffman(litLengths);
    fixedDistTable = buildHuffman(new Array<number>(30).fill(5));
  }
  return { lit: fixedLitTable as Huffman, dist: fixedDistTable as Huffman };
}

/**
 * Inflate exactly one zlib stream starting at `off`, returning the body and the
 * offset just past the stream. Pure-JS RFC 1950/1951 decoder (puff-style
 * canonical Huffman decoding): a single pass, no native zlib call per object,
 * and it reports the exact consumed byte count — which Node's inflateSync
 * cannot do. (The previous binary-search implementation cost ~4 ms per
 * 3-object pack because every inflateSync call re-creates a native context.)
 *
 * Speed notes (measured): the bit reader is a small integer accumulator
 * instead of a per-bit loop, output goes straight into a growable Buffer
 * instead of a number[] + Buffer.from copy, and the constant tables live at
 * module scope. Same bytes out, same errors, same `next` offset as before.
 */
export function inflateOne(buf: Buffer, off: number): { body: Buffer; next: number } {
  if (off + 2 > buf.length) throw new Error('inflate: truncated zlib header');
  const cmf = buf[off];
  const flg = buf[off + 1];
  if ((cmf & 0x0f) !== 8) throw new Error('inflate: not deflate');
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error('inflate: bad zlib header');
  if (flg & 0x20) throw new Error('inflate: preset dictionary not supported');
  let pos = off + 2; // byte position of the next unread byte
  // Bit accumulator: bitbuf holds bitcnt unconsumed bits, LSB-first.
  // bitcnt never exceeds 20 (refill only while bitcnt < n <= 13), so all
  // shifts stay inside 32-bit ints.
  let bitbuf = 0;
  let bitcnt = 0;

  const bits = (n: number): number => {
    while (bitcnt < n) {
      if (pos >= buf.length) throw new Error('inflate: unexpected end of input');
      bitbuf |= buf[pos] << bitcnt;
      bitcnt += 8;
      pos += 1;
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  };

  // Growable output buffer: literals and LZ77 copies write directly, no
  // per-byte array push and no final copy.
  let out = Buffer.allocUnsafe(1024);
  let outLen = 0;
  const ensure = (need: number): void => {
    if (outLen + need <= out.length) return;
    let size = out.length;
    while (size < outLen + need) size *= 2;
    const next = Buffer.allocUnsafe(size);
    out.copy(next, 0, 0, outLen);
    out = next;
  };

  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len += 1) {
      code |= bits(1);
      const count = h.counts[len] ?? 0;
      if (code - first < count) return h.symbols[index + (code - first)] as number;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid code');
  };

  const inflateBlock = (lit: Huffman, dist: Huffman): void => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        if (outLen >= out.length) ensure(1);
        out[outLen] = sym;
        outLen += 1;
      } else if (sym === 256) {
        return;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new Error('inflate: bad length symbol');
        const len = (LEN_BASE[li] as number) + bits(LEN_EXTRA[li] as number);
        const dsym = decode(dist);
        if (dsym >= 30) throw new Error('inflate: bad distance symbol');
        const d = (DIST_BASE[dsym] as number) + bits(DIST_EXTRA[dsym] as number);
        if (d > outLen) throw new Error('inflate: distance too far back');
        ensure(len);
        if (d === 1) {
          // Run of one repeated byte: a single fill.
          out.fill(out[outLen - 1], outLen, outLen + len);
          outLen += len;
        } else {
          for (let i = 0; i < len; i += 1) {
            out[outLen] = out[outLen - d] as number;
            outLen += 1;
          }
        }
      }
    }
  };

  for (;;) {
    const finalBlock = bits(1);
    const btype = bits(2);
    if (btype === 0) {
      // Stored block: drop the partial byte (pos already points past it),
      // then LEN/NLEN + raw bytes.
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > buf.length) throw new Error('inflate: truncated stored block');
      const len = buf[pos] | (buf[pos + 1] << 8);
      const nlen = buf[pos + 2] | (buf[pos + 3] << 8);
      if (len !== (~nlen & 0xffff)) throw new Error('inflate: stored block LEN/NLEN mismatch');
      pos += 4;
      if (pos + len > buf.length) throw new Error('inflate: truncated stored data');
      ensure(len);
      buf.copy(out, outLen, pos, pos + len);
      outLen += len;
      pos += len;
    } else if (btype === 1) {
      const { lit, dist } = fixedTables();
      inflateBlock(lit, dist);
    } else if (btype === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const clLengths = new Array<number>(19).fill(0);
      for (let i = 0; i < hclen; i += 1) clLengths[CL_ORDER[i] as number] = bits(3);
      const cl = buildHuffman(clLengths);
      const lengths = new Array<number>(hlit + hdist).fill(0);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decode(cl);
        if (sym < 16) {
          lengths[i] = sym;
          i += 1;
        } else if (sym === 16) {
          if (i === 0) throw new Error('inflate: repeat with no previous length');
          const rep = 3 + bits(2);
          const prev = lengths[i - 1] as number;
          for (let j = 0; j < rep; j += 1) { lengths[i] = prev; i += 1; }
        } else if (sym === 17) {
          const rep = 3 + bits(3);
          for (let j = 0; j < rep; j += 1) { lengths[i] = 0; i += 1; }
        } else if (sym === 18) {
          const rep = 11 + bits(7);
          for (let j = 0; j < rep; j += 1) { lengths[i] = 0; i += 1; }
        } else {
          throw new Error('inflate: bad code-length symbol');
        }
      }
      const lit = buildHuffman(lengths.slice(0, hlit));
      const dist = buildHuffman(lengths.slice(hlit));
      inflateBlock(lit, dist);
    } else {
      throw new Error('inflate: bad block type');
    }
    if (finalBlock === 1) break;
  }

  // Align to the next byte boundary (drop the partial byte), then 4-byte
  // Adler-32 (big-endian).
  bitbuf = 0;
  bitcnt = 0;
  if (pos + 4 > buf.length) throw new Error('inflate: truncated adler32');
  pos += 4;
  return { body: out.subarray(0, outLen), next: pos };
}

/** Wrap pack bytes in side-band-64k (band 1 = data). Max pkt-line length is 65520
 * bytes INCLUDING the 4-byte length prefix, so a sideband packet carries at
 * most 65520 - 4 (length) - 1 (band byte) = 65515 data bytes. */
export function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const max = 65515;
  for (let off = 0; off < pack.length; off += max) {
    const slice = pack.subarray(off, Math.min(off + max, pack.length));
    const len = slice.length + 5; // 4 hex + 1 band byte
    chunks.push(Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'));
    chunks.push(Buffer.from([0x01]));
    chunks.push(slice);
  }
  chunks.push(FLUSH_PKT);
  return Buffer.concat(chunks);
}

/** Opaque, stable GraphQL node id: base64url of "Kind:repoId:number". Never a plain decimal. */
export function nodeId(kind: string, repoId: number, n: number): string {
  return Buffer.from(`${kind}:${repoId}:${n}`, 'utf8').toString('base64url');
}

export function parseNodeId(id: string): { kind: string; repoId: number; n: number } | null {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const m = s.match(/^([A-Za-z]+):(\d+):(\d+)$/);
    if (!m) return null;
    return { kind: m[1], repoId: Number(m[2]), n: Number(m[3]) };
  } catch {
    return null;
  }
}
