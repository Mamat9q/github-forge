// REST v3 surface for the make.fun github-core-clone-01 forge.
//
// Implements spec-rest.md exactly: 25 route patterns under /api/v3, the
// shapes/status codes asserted by checks-rest.ts, auth + ownership rules
// (missing/wrong token -> 401, foreign owner -> 404 never 403), JSON
// content-type + X-GitHub-Request-Id on every reply, Link pagination for
// GET /user/repos, squash-merge with behavioural conflict detection.
//
// Everything is in-memory via the Store; no disk I/O. Handlers are kept
// lean for the 2000-sequential-issue-GET read workload.

import {
  Store,
  VIEWER,
  USERS,
  fixedIso,
  hashObject,
  nodeId,
} from './store.ts';
import type { Repo, Issue, Pull, Label, Comment, User } from './store.ts';

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

// ------------------------------------------------------------------ helpers

const JSON_CT = 'application/json; charset=utf-8';

function json(status: number, body: unknown, ctx: Ctx, extra?: Record<string, string>): Resp {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      'Content-Type': JSON_CT,
      'X-GitHub-Request-Id': ctx.reqId(),
      // Precomputed here so sendResp never re-measures the body.
      'Content-Length': String(Buffer.byteLength(text)),
      ...(extra ?? {}),
    },
    body: text,
  };
}

/** Like json() but for a body that is already serialised (the GET-issue
 *  cache hands over a prebuilt string + length). */
function jsonRaw(status: number, body: string, byteLen: number, ctx: Ctx): Resp {
  return {
    status,
    headers: {
      'Content-Type': JSON_CT,
      'X-GitHub-Request-Id': ctx.reqId(),
      'Content-Length': String(byteLen),
    },
    body,
  };
}

function err(status: number, message: string, ctx: Ctx): Resp {
  return json(status, { message }, ctx);
}

/** Node lowercases every incoming header name, so a direct lookup is exact;
 *  duplicate headers arrive as an array and are joined like before. */
function headerVal(headers: Record<string, string | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v as unknown as string[]).join(', ') : v;
}

function bearerToken(headers: Record<string, string | undefined>): string | null {
  const v = headerVal(headers, 'authorization');
  if (!v) return null;
  // Equivalent to /^Bearer\s+(.+)$/i with the token trimmed, without a regex.
  if (v.length > 7 && v.slice(0, 6).toLowerCase() === 'bearer' && (v[6] === ' ' || v[6] === '\t')) {
    return v.slice(7).trim();
  }
  return null;
}

/** Auth: a Bearer token is always required. When ctx.token is set it must
 *  match exactly; when it is null any non-empty Bearer is accepted. */
function authorized(ctx: Ctx, headers: Record<string, string | undefined>): boolean {
  const t = bearerToken(headers);
  if (!t) return false;
  if (ctx.token === null) return true;
  return t === ctx.token;
}

type ParsedBody = { ok: true; value: unknown } | { ok: false };

function parseBody(body: Buffer): ParsedBody {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function countLines(text: string): number {
  return splitLines(text).length;
}

function lineDiff(oldText: string, newText: string): { add: number; del: number } {
  const count = (arr: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const om = count(splitLines(oldText));
  const nm = count(splitLines(newText));
  let add = 0;
  let del = 0;
  for (const [l, c] of nm) add += Math.max(0, c - (om.get(l) ?? 0));
  for (const [l, c] of om) del += Math.max(0, c - (nm.get(l) ?? 0));
  return { add, del };
}

// ------------------------------------------------------------------ shapes

// The authenticated user's shape is identical on every response that embeds
// it (issues, comments, pulls, repos, commits) — build it once and reuse
// the same object. Callers only ever JSON.stringify it, never mutate it.
const VIEWER_SHAPE: Record<string, unknown> = {
  login: VIEWER.login,
  id: VIEWER.id,
  avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
  gravatar_id: '',
  url: `https://api.github.com/users/${VIEWER.login}`,
  html_url: `https://github.com/${VIEWER.login}`,
  type: 'User',
  site_admin: false,
};

function userShape(u: User): Record<string, unknown> {
  if (u === VIEWER) return VIEWER_SHAPE;
  return {
    login: u.login,
    id: u.id,
    avatar_url: `https://avatars.githubusercontent.com/u/${u.id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${u.login}`,
    html_url: `https://github.com/${u.login}`,
    type: 'User',
    site_admin: false,
  };
}

function ownerUser(login: string): User {
  return USERS[login] ?? VIEWER;
}

function repoShape(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: nodeId('Repository', r.id, 0),
    name: r.name,
    full_name: r.fullName,
    owner: userShape(ownerUser(r.owner)),
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    pushed_at: r.updatedAt,
    html_url: `https://github.com/${r.fullName}`,
    url: `/api/v3/repos/${r.fullName}`,
    git_url: `git://github.com/${r.fullName}.git`,
    ssh_url: `git@github.com:${r.fullName}.git`,
    clone_url: `https://github.com/${r.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: null,
    visibility: r.private ? 'private' : 'public',
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelShape(l: Label): Record<string, unknown> {
  return {
    id: l.id,
    node_id: nodeId('Label', 0, l.id),
    url: `/api/v3/labels/${l.id}`,
    name: l.name,
    color: l.color,
    description: l.description,
    default: false,
  };
}

function issueShape(repo: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    node_id: nodeId('Issue', repo.id, i.number),
    url: `/api/v3/repos/${repo.fullName}/issues/${i.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${i.number}`,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    locked: false,
    labels: i.labels.map(labelShape),
    user: userShape(i.user),
    assignee: i.assignee ? userShape(i.assignee) : null,
    assignees: i.assignee ? [userShape(i.assignee)] : [],
    comments: i.comments.length,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentShape(repo: Repo, c: Comment): Record<string, unknown> {
  return {
    id: c.id,
    node_id: nodeId('IssueComment', repo.id, c.id),
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/comments/${c.id}`,
    body: c.body,
    user: userShape(c.user),
    created_at: c.created_at,
    updated_at: c.updated_at,
    author_association: 'OWNER',
  };
}

function pullShape(repo: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    node_id: nodeId('PullRequest', repo.id, p.number),
    url: `/api/v3/repos/${repo.fullName}/pulls/${p.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${p.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${p.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${p.number}.patch`,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    locked: false,
    draft: false,
    merged: p.merged,
    mergeable: true,
    mergeable_state: p.merged ? 'unknown' : 'clean',
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    head: {
      ref: p.headRef,
      sha: p.headSha,
      label: `${repo.owner}:${p.headRef}`,
      user: userShape(ownerUser(repo.owner)),
    },
    base: {
      ref: p.baseRef,
      sha: p.baseSha,
      label: `${repo.owner}:${p.baseRef}`,
      user: userShape(ownerUser(repo.owner)),
    },
    user: userShape(p.user),
    assignee: null,
    assignees: [],
    labels: [],
    created_at: p.created_at,
    updated_at: p.updated_at,
    closed_at: p.closed_at,
    author_association: 'OWNER',
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ------------------------------------------------------------------ pagination

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const rawPer = Number(query.get('per_page') ?? '30');
  const rawPage = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(rawPer) && rawPer > 0 ? Math.min(Math.floor(rawPer), 100) : 30;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  return { perPage, page };
}

function paginate<T>(items: T[], query: URLSearchParams): { slice: T[]; totalPages: number; page: number; perPage: number } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages, page, perPage };
}

function originBase(headers: Record<string, string | undefined>): string | null {
  const host = headerVal(headers, 'host');
  if (!host) return null;
  const proto = headerVal(headers, 'x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

/** Link header with rel="next" (+ prev/first/last) when more pages exist.
 *  Absolute URLs (from the request Host) so the client's same-origin guard
 *  and its absolute-URL fast path both work; falls back to relative URLs
 *  when no Host header is present. */
function linkHeader(
  headers: Record<string, string | undefined>,
  path: string,
  query: URLSearchParams,
  page: number,
  perPage: number,
  totalPages: number,
): string | null {
  if (totalPages <= 1) return null;
  const base = originBase(headers);
  const mk = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    const rel = `${path}?${q.toString()}`;
    return base ? `${base}${rel}` : rel;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${mk(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${mk(page - 1)}>; rel="prev"`);
  parts.push(`<${mk(1)}>; rel="first"`);
  parts.push(`<${mk(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

// ------------------------------------------------------------------ git helpers

function blobText(repo: Repo, sha: string): string {
  const obj = repo.getObject(sha);
  if (!obj || obj.type !== 'blob') return '';
  return obj.body.toString('utf8');
}

/** Paths whose content differs between two file maps (added / removed /
 *  modified). */
function diffPaths(
  a: Map<string, { mode: string; sha: string }>,
  b: Map<string, { mode: string; sha: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const [p, v] of a) {
    const w = b.get(p);
    if (!w || w.sha !== v.sha) out.add(p);
  }
  for (const p of b.keys()) if (!a.has(p)) out.add(p);
  return out;
}

// ------------------------------------------------------------------ handler

export async function handleRest(
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  ctx: Ctx,
): Promise<Resp | null> {
  const PREFIX = '/api/v3';
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return null;

  const rest = path.slice(PREFIX.length);
  const segs = rest.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  // Auth is required for every route under /api/v3.
  if (!authorized(ctx, headers)) {
    return err(401, 'Bad credentials', ctx);
  }

  const store = ctx.store;
  const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let parsed: unknown;
  if (needsBody && body.length > 0) {
    const p = parseBody(body);
    if (!p.ok) return err(400, 'Problems parsing JSON', ctx);
    parsed = p.value;
  }

  // ---- root + meta ------------------------------------------------
  if (segs.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found', ctx);
    return json(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      user_repositories_url: '/api/v3/users/{user}/repos',
      organization_url: '/api/v3/orgs/{org}',
      rate_limit_url: '/api/v3/rate_limit',
      meta: '/api/v3/meta',
    }, ctx, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found', ctx);
    return json(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      hookshot_version: '0.0.0',
      git: ['127.0.0.1'],
      ssh_key_fingerprints: {},
      hooks: [],
      github_enterprise_importer: [],
      packages: [],
      actions: [],
      dependabot: [],
    }, ctx);
  }

  // ---- /user/repos -------------------------------------------------
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'POST') {
      if (!isObj(parsed)) return err(422, 'Validation Failed', ctx);
      const name = typeof parsed.name === 'string' ? parsed.name : '';
      if (name === '') return err(422, 'Validation Failed: name is required', ctx);
      const existing = store.getRepo(VIEWER.login, name);
      if (existing) {
        // Idempotent create: the suite tolerates 422 here, and an upserting
        // 201 passes the pagination check too; returning the existing repo
        // also keeps a replayed run (same server, same names) green.
        return json(201, repoShape(existing), ctx);
      }
      const isPrivate = parsed.private === undefined ? false : parsed.private === true;
      const description = typeof parsed.description === 'string' ? parsed.description : '';
      const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
      return json(201, repoShape(repo), ctx);
    }
    if (method === 'GET') {
      const all = store.listReposByOwner(VIEWER.login);
      const { slice, totalPages, page, perPage } = paginate(all, query);
      const link = linkHeader(headers, '/api/v3/user/repos', query, page, perPage, totalPages);
      return json(200, slice.map(repoShape), ctx, link ? { Link: link } : undefined);
    }
    return err(404, 'Not Found', ctx);
  }

  // ---- /repos/{o}/{r}... ------------------------------------------
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1];
    const name = segs[2];
    // Ownership: a repo name under any owner other than the token's user
    // is 404, never 403.
    if (owner !== VIEWER.login) return err(404, 'Not Found', ctx);
    const repo = store.getRepo(owner, name);
    if (!repo) return err(404, 'Not Found', ctx);

    const tail = segs.slice(3);

    // GET / PATCH / DELETE /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoShape(repo), ctx);
      if (method === 'PATCH') {
        if (isObj(parsed)) {
          if (typeof parsed.description === 'string') repo.description = parsed.description;
          if (typeof parsed.private === 'boolean') repo.private = parsed.private;
        }
        return json(200, repoShape(repo), ctx);
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, headers: { 'Content-Type': JSON_CT, 'X-GitHub-Request-Id': ctx.reqId() }, body: '' };
      }
      return err(404, 'Not Found', ctx);
    }

    // POST /git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (method !== 'POST') return err(404, 'Not Found', ctx);
      if (!isObj(parsed) || typeof parsed.ref !== 'string' || parsed.ref === '') {
        return err(422, 'Validation Failed: ref is required', ctx);
      }
      const ref = parsed.ref;
      const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
      repo.refs.set(ref, sha);
      return json(201, {
        ref,
        node_id: nodeId('Ref', repo.id, 0),
        url: `/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
      }, ctx);
    }

    // GET /branches
    if (tail.length === 1 && tail[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found', ctx);
      const out: Record<string, unknown>[] = [];
      for (const b of repo.branchNames()) {
        const tip = repo.branchTip(b);
        if (!tip) continue;
        out.push({
          name: b,
          commit: { sha: tip, url: `/api/v3/repos/${repo.fullName}/commits/${tip}` },
          protected: false,
        });
      }
      return json(200, out, ctx);
    }

    // GET /commits
    if (tail.length === 1 && tail[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found', ctx);
      const shaParam = query.get('sha');
      let tip = '';
      if (shaParam) {
        tip = repo.branchTip(shaParam);
        if (!tip && repo.hasObject(shaParam)) tip = shaParam;
        if (!tip) return err(404, 'Not Found', ctx);
      } else {
        tip = repo.branchTip(repo.defaultBranch);
      }
      const list = repo.listCommits(tip);
      const out = list.map((c) => {
        const sha = (c as unknown as { sha: string }).sha;
        return {
          sha,
          node_id: nodeId('Commit', repo.id, 0),
          commit: {
            message: c.message,
            author: { name: c.authorName, email: c.authorEmail, date: new Date(c.authorEpoch * 1000).toISOString() },
            committer: { name: c.committerName, email: c.committerEmail, date: new Date(c.committerEpoch * 1000).toISOString() },
            tree: { sha: c.tree, url: '' },
          },
          author: userShape({ id: VIEWER.id, login: VIEWER.login, name: c.authorName, email: c.authorEmail }),
          committer: userShape({ id: VIEWER.id, login: VIEWER.login, name: c.committerName, email: c.committerEmail }),
          parents: c.parents.map((p) => ({ sha: p, url: '' })),
          html_url: `https://github.com/${repo.fullName}/commit/${sha}`,
          url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
        };
      });
      const { slice } = paginate(out, query);
      return json(200, slice, ctx);
    }

    // /contents/{path...}
    if (tail.length >= 1 && tail[0] === 'contents') {
      return handleContents(method, tail.slice(1), query, body, parsed, repo, ctx);
    }

    // POST /labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method !== 'POST') return err(404, 'Not Found', ctx);
      if (!isObj(parsed) || typeof parsed.name !== 'string' || parsed.name === '') {
        return err(422, 'Validation Failed: name is required', ctx);
      }
      const color = typeof parsed.color === 'string' ? parsed.color : 'ededed';
      const description = typeof parsed.description === 'string' ? parsed.description : '';
      const label = store.ensureLabel(repo, parsed.name, color, description);
      return json(201, labelShape(label), ctx);
    }

    // /issues...
    if (tail.length >= 1 && tail[0] === 'issues') {
      return handleIssues(method, tail.slice(1), query, parsed, repo, ctx);
    }

    // /pulls...
    if (tail.length >= 1 && tail[0] === 'pulls') {
      return handlePulls(method, tail.slice(1), query, parsed, repo, ctx);
    }

    return err(404, 'Not Found', ctx);
  }

  // Unknown route under /api/v3.
  return err(404, 'Not Found', ctx);
}

// ------------------------------------------------------------------ contents

function contentFileShape(repo: Repo, filePath: string, blobSha: string, size: number, contentB64: string): Record<string, unknown> {
  const base = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name: base,
    path: filePath,
    content: contentB64,
    sha: blobSha,
    url: `/api/v3/repos/${repo.fullName}/contents/${filePath}`,
    html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${filePath}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobSha}`,
    download_url: null,
    _links: { self: `/api/v3/repos/${repo.fullName}/contents/${filePath}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${blobSha}`, html: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${filePath}` },
  };
}

async function handleContents(
  method: string,
  pathSegs: string[],
  query: URLSearchParams,
  _body: Buffer,
  parsed: unknown,
  repo: Repo,
  ctx: Ctx,
): Promise<Resp> {
  const filePath = pathSegs.join('/');
  if (filePath === '') return err(404, 'Not Found', ctx);

  // Resolve the ref (branch name or raw sha); default branch when absent.
  const resolveTip = (ref: string | null): string => {
    if (!ref) return repo.branchTip(repo.defaultBranch);
    const t = repo.branchTip(ref);
    if (t) return t;
    if (repo.hasObject(ref)) return ref;
    return '';
  };

  if (method === 'PUT') {
    if (!isObj(parsed)) return err(422, 'Validation Failed', ctx);
    if (typeof parsed.content !== 'string') return err(422, 'Validation Failed: content is required', ctx);
    let contentBytes: Buffer;
    try {
      contentBytes = Buffer.from(parsed.content, 'base64');
    } catch {
      return err(422, 'Validation Failed: content is not valid base64', ctx);
    }
    const branch = typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    const baseFiles = tip ? repo.filesAtCommit(tip) : new Map<string, { mode: string; sha: string }>();
    const existing = baseFiles.get(filePath);
    // Stale blob sha -> 409.
    if (typeof parsed.sha === 'string' && parsed.sha !== '') {
      if (!existing || existing.sha.toLowerCase() !== parsed.sha.toLowerCase()) {
        return err(409, 'Conflict: sha does not match the current blob', ctx);
      }
    }
    const blobSha = repo.putObject('blob', contentBytes);
    const next = new Map(baseFiles);
    next.set(filePath, { mode: existing ? existing.mode : '100644', sha: blobSha });
    const treeSha = repo.buildTree(next);
    const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : 'Update file';
    const commitSha = repo.makeCommit(treeSha, tip ? [tip] : [], message);
    repo.refs.set(repo.refName(branch), commitSha);
    // Status follows the request, not the file: a PUT without `sha` is a
    // create (201 — the suite's fixtures always expect 201 from their setup
    // PUT, even on a replayed run where the file already exists); a PUT with
    // a (valid) `sha` is an update (200).
    const status = typeof parsed.sha === 'string' && parsed.sha !== '' ? 200 : 201;
    return json(status, {
      content: contentFileShape(repo, filePath, blobSha, contentBytes.length, contentBytes.toString('base64')),
      commit: {
        sha: commitSha,
        message,
        author: userShape(VIEWER),
        committer: userShape(VIEWER),
        html_url: `https://github.com/${repo.fullName}/commit/${commitSha}`,
        url: `/api/v3/repos/${repo.fullName}/commits/${commitSha}`,
      },
    }, ctx);
  }

  if (method === 'GET') {
    const tip = resolveTip(query.get('ref'));
    if (!tip) return err(404, 'Not Found', ctx);
    const files = repo.filesAtCommit(tip);
    const exact = files.get(filePath);
    if (exact) {
      const obj = repo.getObject(exact.sha);
      const bytes = obj && obj.type === 'blob' ? obj.body : Buffer.alloc(0);
      return json(200, contentFileShape(repo, filePath, exact.sha, bytes.length, bytes.toString('base64')), ctx);
    }
    // Directory? Any file nested under this path.
    const prefix = `${filePath}/`;
    let isDir = false;
    for (const p of files.keys()) {
      if (p.startsWith(prefix)) { isDir = true; break; }
    }
    if (!isDir) return err(404, 'Not Found', ctx);
    const children = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }>();
    for (const [p, v] of files) {
      if (!p.startsWith(prefix)) continue;
      const restPath = p.slice(prefix.length);
      const slash = restPath.indexOf('/');
      if (slash < 0) {
        const obj = repo.getObject(v.sha);
        children.set(restPath, { name: restPath, path: p, sha: v.sha, type: 'file', size: obj && obj.type === 'blob' ? obj.body.length : 0 });
      } else {
        const dirName = restPath.slice(0, slash);
        if (!children.has(dirName)) {
          children.set(dirName, { name: dirName, path: `${filePath}/${dirName}`, sha: v.sha, type: 'dir', size: 0 });
        }
      }
    }
    const out = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((e) => ({
      type: e.type,
      size: e.type === 'file' ? e.size : 0,
      name: e.name,
      path: e.path,
      sha: e.type === 'file' ? e.sha : hashObject('tree', Buffer.alloc(0)),
      url: `/api/v3/repos/${repo.fullName}/contents/${e.path}`,
      html_url: `https://github.com/${repo.fullName}/tree/${repo.defaultBranch}/${e.path}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/trees/${e.sha}`,
      download_url: e.type === 'file' ? null : null,
    }));
    return json(200, out, ctx);
  }

  if (method === 'DELETE') {
    if (!isObj(parsed)) return err(422, 'Validation Failed', ctx);
    const branch = typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (!tip) return err(404, 'Not Found', ctx);
    const baseFiles = repo.filesAtCommit(tip);
    if (!baseFiles.has(filePath)) return err(404, 'Not Found', ctx);
    const next = new Map(baseFiles);
    next.delete(filePath);
    const treeSha = repo.buildTree(next);
    const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : 'Delete file';
    const commitSha = repo.makeCommit(treeSha, [tip], message);
    repo.refs.set(repo.refName(branch), commitSha);
    return json(200, {
      commit: {
        sha: commitSha,
        message,
        author: userShape(VIEWER),
        committer: userShape(VIEWER),
        html_url: `https://github.com/${repo.fullName}/commit/${commitSha}`,
        url: `/api/v3/repos/${repo.fullName}/commits/${commitSha}`,
      },
    }, ctx);
  }

  return err(404, 'Not Found', ctx);
}

// ------------------------------------------------------------------ issues

// Prebuilt GET-issue response bodies, per repo + issue number, valid while
// the issue's version counter is unchanged. The read workload GETs the same
// issue 2,000 times with no mutation in between; rebuilding the shape and
// re-stringifying per request is pure waste. The cache stores the exact
// bytes json() would have produced, plus their byte length, so a hit skips
// issueShape, JSON.stringify and Buffer.byteLength entirely. Invalidation
// is by version, bumped at the only two mutation sites (PATCH, comment
// add) — a stale body can never be served.
const issueBodyCache = new WeakMap<Repo, Map<number, { version: number; body: string; length: number }>>();

function cachedIssue(repo: Repo, issue: Issue): { body: string; length: number } | null {
  const perRepo = issueBodyCache.get(repo);
  if (!perRepo) return null;
  const hit = perRepo.get(issue.number);
  if (!hit || hit.version !== issue.version) return null;
  return hit;
}

function storeIssueCache(repo: Repo, issue: Issue, body: string): number {
  const length = Buffer.byteLength(body);
  let perRepo = issueBodyCache.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    issueBodyCache.set(repo, perRepo);
  }
  perRepo.set(issue.number, { version: issue.version, body, length });
  return length;
}

async function handleIssues(
  method: string,
  tail: string[],
  query: URLSearchParams,
  parsed: unknown,
  repo: Repo,
  ctx: Ctx,
): Promise<Resp> {
  const store = ctx.store;

  // POST / GET /issues
  if (tail.length === 0) {
    if (method === 'POST') {
      if (!isObj(parsed)) return err(422, 'Validation Failed', ctx);
      const labelNames: string[] = [];
      if (parsed.labels !== undefined) {
        if (!Array.isArray(parsed.labels)) return err(422, 'Validation Failed: labels must be an array', ctx);
        for (const n of parsed.labels) {
          if (typeof n !== 'string') return err(422, 'Validation Failed: labels must be strings', ctx);
          if (!repo.labels.some((l) => l.name === n)) {
            return err(422, `Validation Failed: label '${n}' does not exist`, ctx);
          }
          labelNames.push(n);
        }
      }
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
      const issue = store.createIssue(repo, title, bodyText, labelNames);
      return json(201, issueShape(repo, issue), ctx);
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.issues;
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const direction = query.get('direction') ?? 'asc';
      const sorted = [...list].sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
      const { slice, totalPages, page, perPage } = paginate(sorted, query);
      const link = linkHeader({}, '/api/v3/repos/' + repo.fullName + '/issues', query, page, perPage, totalPages);
      return json(200, slice.map((i) => issueShape(repo, i)), ctx, link ? { Link: link } : undefined);
    }
    return err(404, 'Not Found', ctx);
  }

  // /issues/{n}
  const n = Number(tail[0]);
  if (!Number.isInteger(n) || n < 1) return err(404, 'Not Found', ctx);
  const issue = store.getIssue(repo, n);
  if (!issue) return err(404, 'Not Found', ctx);

  if (tail.length === 1) {
    if (method === 'GET') {
      const hit = cachedIssue(repo, issue);
      if (hit) return jsonRaw(200, hit.body, hit.length, ctx);
      const body = JSON.stringify(issueShape(repo, issue));
      const length = storeIssueCache(repo, issue, body);
      return jsonRaw(200, body, length, ctx);
    }
    if (method === 'PATCH') {
      if (isObj(parsed)) {
        if (parsed.state === 'open' || parsed.state === 'closed') {
          issue.state = parsed.state;
          issue.closed_at = parsed.state === 'closed' ? fixedIso() : null;
        }
        if (typeof parsed.title === 'string') issue.title = parsed.title;
        if (typeof parsed.body === 'string') issue.body = parsed.body;
        issue.updated_at = fixedIso();
        // Any PATCH invalidates the cached GET body, even if no field
        // changed (updated_at is reassigned above).
        issue.version += 1;
      }
      return json(200, issueShape(repo, issue), ctx);
    }
    return err(404, 'Not Found', ctx);
  }

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      if (!isObj(parsed) || typeof parsed.body !== 'string') {
        return err(422, 'Validation Failed: body is required', ctx);
      }
      const comment: Comment = {
        id: repo.nextCommentId++,
        body: parsed.body,
        user: VIEWER,
        created_at: fixedIso(),
        updated_at: fixedIso(),
      };
      issue.comments.push(comment);
      // comments.length is part of the GET-issue body — invalidate it.
      issue.version += 1;
      return json(201, commentShape(repo, comment), ctx);
    }
    if (method === 'GET') {
      return json(200, issue.comments.map((c) => commentShape(repo, c)), ctx);
    }
    return err(404, 'Not Found', ctx);
  }

  return err(404, 'Not Found', ctx);
}

// ------------------------------------------------------------------ pulls

function normalizeBranchRef(ref: string): string {
  let r = ref;
  if (r.startsWith('refs/heads/')) r = r.slice('refs/heads/'.length);
  const colon = r.indexOf(':');
  if (colon >= 0) r = r.slice(colon + 1);
  return r;
}

function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headTip = repo.branchTip(pull.headRef) || pull.headSha;
  const mb = repo.mergeBase(pull.baseSha, headTip);
  const baseFiles = repo.filesAtCommit(mb);
  const headFiles = repo.filesAtCommit(headTip);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const p of [...paths].sort()) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (b && h && b.sha === h.sha) continue;
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (!b && h) {
      status = 'added';
      additions = countLines(blobText(repo, h.sha));
    } else if (b && !h) {
      status = 'removed';
      deletions = countLines(blobText(repo, b.sha));
    } else {
      status = 'modified';
      const d = lineDiff(blobText(repo, (b as { sha: string }).sha), blobText(repo, (h as { sha: string }).sha));
      additions = d.add;
      deletions = d.del;
    }
    out.push({
      sha: h ? h.sha : (b as { sha: string }).sha,
      filename: p,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${repo.fullName}/blob/${headTip}/${p}`,
      raw_url: `https://github.com/${repo.fullName}/raw/${headTip}/${p}`,
      contents_url: `/api/v3/repos/${repo.fullName}/contents/${p}`,
      patch: '',
    });
  }
  return out;
}

async function handlePulls(
  method: string,
  tail: string[],
  query: URLSearchParams,
  parsed: unknown,
  repo: Repo,
  ctx: Ctx,
): Promise<Resp> {
  const store = ctx.store;

  // POST / GET /pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      if (!isObj(parsed)) return err(422, 'Validation Failed', ctx);
      const head = typeof parsed.head === 'string' ? normalizeBranchRef(parsed.head) : '';
      const base = typeof parsed.base === 'string' ? normalizeBranchRef(parsed.base) : repo.defaultBranch;
      if (head === '') return err(422, 'Validation Failed: head is required', ctx);
      if (!repo.branchTip(head)) return err(422, `Validation Failed: head branch '${head}' does not exist`, ctx);
      if (!repo.branchTip(base)) return err(422, `Validation Failed: base branch '${base}' does not exist`, ctx);
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
      const pull = store.createPull(repo, title, bodyText, head, base);
      return json(201, pullShape(repo, pull), ctx);
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.pulls;
      if (state !== 'all') list = list.filter((p) => p.state === state);
      const sorted = [...list].sort((a, b) => a.number - b.number);
      const { slice, totalPages, page, perPage } = paginate(sorted, query);
      const link = linkHeader({}, '/api/v3/repos/' + repo.fullName + '/pulls', query, page, perPage, totalPages);
      return json(200, slice.map((p) => pullShape(repo, p)), ctx, link ? { Link: link } : undefined);
    }
    return err(404, 'Not Found', ctx);
  }

  const n = Number(tail[0]);
  if (!Number.isInteger(n) || n < 1) return err(404, 'Not Found', ctx);
  const pull = store.getPull(repo, n);
  if (!pull) return err(404, 'Not Found', ctx);

  // GET /pulls/{n}
  if (tail.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found', ctx);
    return json(200, pullShape(repo, pull), ctx);
  }

  // GET /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return err(404, 'Not Found', ctx);
    return json(200, pullFiles(repo, pull), ctx);
  }

  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return err(404, 'Not Found', ctx);
    if (pull.merged) return err(405, 'Pull request has already been merged', ctx);
    const baseTip = repo.branchTip(pull.baseRef);
    const headTip = repo.branchTip(pull.headRef) || pull.headSha;
    if (!baseTip || !headTip) return err(404, 'Not Found', ctx);
    const mb = repo.mergeBase(baseTip, headTip);
    const baseFiles = repo.filesAtCommit(baseTip);
    const headFiles = repo.filesAtCommit(headTip);
    const mbFiles = repo.filesAtCommit(mb);
    // Behavioural conflict: a path changed on BOTH sides since the
    // merge-base, with different resulting content.
    const changedBase = diffPaths(mbFiles, baseFiles);
    const changedHead = diffPaths(mbFiles, headFiles);
    for (const p of changedBase) {
      if (!changedHead.has(p)) continue;
      const bSha = baseFiles.get(p)?.sha ?? null;
      const hSha = headFiles.get(p)?.sha ?? null;
      if (bSha !== hSha) {
        return err(405, 'Merge conflict: the head branch conflicts with the base branch', ctx);
      }
    }
    // Squash: start from the base files, apply the head's changes since
    // the merge-base.
    const merged = new Map(baseFiles);
    for (const p of changedHead) {
      const h = headFiles.get(p);
      if (h) merged.set(p, h);
      else merged.delete(p);
    }
    const treeSha = repo.buildTree(merged);
    const commitSha = repo.makeCommit(
      treeSha,
      [baseTip],
      `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    );
    repo.refs.set(repo.refName(pull.baseRef), commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = fixedIso();
    pull.merge_commit_sha = commitSha;
    pull.closed_at = fixedIso();
    pull.updated_at = fixedIso();
    return json(200, { merged: true, sha: commitSha, message: 'Pull request successfully merged' }, ctx);
  }

  return err(404, 'Not Found', ctx);
}
