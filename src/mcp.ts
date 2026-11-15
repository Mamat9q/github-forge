// MCP surface for the make.fun github-core-clone-01 forge — Streamable HTTP
// POST /mcp, JSON-RPC 2.0. Serves BOTH protocol eras: modern 2026-07-28
// (server/discover, no handshake/session) and legacy (initialize +
// notifications/initialized). Shares the single in-memory Store with REST v3
// and GraphQL v4, so MCP-created objects are immediately visible over REST.
// Node 22, stdlib only, type-stripping (no enums, no parameter properties).

import { VIEWER, nodeId, fixedIso } from './store.ts';
import type { Store, Repo, Pull } from './store.ts';

export interface Ctx { store: Store; token: string | null; reqId: () => string; }
export interface Resp { status: number; headers?: Record<string, string>; body: string | Buffer; }

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

// ------------------------------------------------------------------ tools

// The tools array is built ONCE and its serialisation reused verbatim on
// every tools/list call, so two calls are byte-identical.
const TOOLS_JSON = JSON.stringify([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const CANONICAL_TOOLS = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];

// Synonym tables from spec-mcp.md §2.4 (normalised: lowercase, alphanumerics only).
const SYNONYMS: Record<string, string[]> = {
  owner: ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'],
  repo_full_name: ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'],
  title: ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text', 'comment'],
  head: ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
  base: ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  name: ['name', 'repo', 'repository', 'repository_name', 'repo_name'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalTool(name: string): string | null {
  const n = normName(name);
  for (const c of CANONICAL_TOOLS) {
    if (n === normName(c)) return c;
    // Server-prefix / alias suffix match: e.g. github__create_issue.
    if (n.length > normName(c).length && n.endsWith(normName(c))) return c;
  }
  return null;
}

/** Map the suite's semantic arguments onto our schema property names (§2.4). */
function getArg(args: Record<string, unknown>, semantic: string): unknown {
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) byNorm.set(normName(k), v);
  for (const syn of SYNONYMS[semantic] ?? [semantic]) {
    const v = byNorm.get(normName(syn));
    if (v !== undefined) return v;
  }
  return undefined;
}

function strArg(args: Record<string, unknown>, semantic: string): string {
  const v = getArg(args, semantic);
  return typeof v === 'string' ? v : '';
}

function resolveRepo(store: Store, args: Record<string, unknown>): { owner: string; name: string; repo?: Repo } {
  let owner = strArg(args, 'owner');
  let name = strArg(args, 'repo');
  if (name === '') {
    const full = strArg(args, 'repo_full_name');
    if (full !== '' && full.includes('/')) {
      const parts = full.split('/');
      owner = parts[0];
      name = parts.slice(1).join('/');
    }
  }
  if (owner === '') owner = VIEWER.login;
  const repo = name === '' ? undefined : store.getRepo(owner, name);
  return { owner, name, repo };
}

// ------------------------------------------------------------------ merge

/** Squash-merge, identical semantics to the GraphQL merge: head content lands
 *  on the base branch as a real merge commit. */
function doMerge(repo: Repo, pr: Pull): void {
  if (pr.merged) return;
  const headTip = repo.branchTip(pr.headRef);
  const baseTip = repo.branchTip(pr.baseRef);
  let mergeSha: string | null = null;
  if (headTip !== '' && baseTip !== '') {
    const tree = repo.buildTree(repo.filesAtCommit(headTip));
    mergeSha = repo.makeCommit(tree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
    repo.refs.set(repo.refName(pr.baseRef), mergeSha);
  } else if (headTip !== '') {
    mergeSha = headTip;
  } else if (baseTip !== '') {
    mergeSha = baseTip;
  }
  pr.merged = true;
  pr.state = 'closed';
  pr.merged_at = fixedIso();
  pr.merge_commit_sha = mergeSha;
  pr.closed_at = fixedIso();
  pr.updated_at = fixedIso();
}

// ------------------------------------------------------------------ JSON-RPC plumbing

function rpcResult(id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): Resp {
  return {
    status: 200,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }),
  };
}

function rpcError(id: unknown, code: number, message: string, status = 200, extraHeaders: Record<string, string> = {}): Resp {
  return {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }),
  };
}

function toolResult(id: unknown, obj: Record<string, unknown>): Resp {
  const text = JSON.stringify(obj);
  return rpcResult(id, {
    content: [{ type: 'text', text }],
    structuredContent: obj,
  });
}

function toolIsError(id: unknown, message: string): Resp {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function bearer(headers: Record<string, string | undefined>): string | null {
  const h = headers['authorization'];
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+?)\s*$/);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ tools/call

function callTool(ctx: Ctx, id: unknown, name: string, args: Record<string, unknown>): Resp {
  const canonical = canonicalTool(name);
  if (canonical === null) {
    // Unknown tool: JSON-RPC error -32601, never HTTP 500, never isError.
    return rpcError(id, -32601, `Unknown tool: ${name}`);
  }
  const store = ctx.store;

  switch (canonical) {
    case 'create_repo': {
      const repoName = strArg(args, 'name');
      if (repoName === '') return rpcError(id, -32602, 'create_repo requires a non-empty name argument.');
      const owner = strArg(args, 'owner') || VIEWER.login;
      const description = strArg(args, 'description');
      const privRaw = getArg(args, 'private');
      const isPrivate = privRaw === true;
      const existing = store.getRepo(owner, repoName);
      const repo = existing ?? store.createRepo(owner, repoName, description, isPrivate);
      const obj: Record<string, unknown> = {
        full_name: repo.fullName,
        name: repo.name,
        owner: repo.owner,
        id: repo.id,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      };
      return toolResult(id, obj);
    }

    case 'get_repo': {
      const { owner, name, repo } = resolveRepo(store, args);
      if (!repo) return rpcError(id, -32602, `Repository not found: ${owner}/${name}`);
      const obj: Record<string, unknown> = {
        full_name: repo.fullName,
        name: repo.name,
        owner: repo.owner,
        id: repo.id,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      };
      return toolResult(id, obj);
    }

    case 'create_issue': {
      const title = strArg(args, 'title');
      const { owner, name, repo } = resolveRepo(store, args);
      if (title === '' || !repo) {
        return rpcError(id, -32602, 'create_issue requires owner, repo and a non-empty title.');
      }
      const body = strArg(args, 'body');
      const issue = store.createIssue(repo, title, body, [], VIEWER);
      const obj: Record<string, unknown> = {
        number: issue.number,
        id: nodeId('Issue', repo.id, issue.number),
        title: issue.title,
        body: issue.body,
        state: 'open',
        full_name: repo.fullName,
        owner,
        repo: name,
      };
      return toolResult(id, obj);
    }

    case 'list_issues': {
      const { owner, name, repo } = resolveRepo(store, args);
      if (!repo) return rpcError(id, -32602, `Repository not found: ${owner}/${name}`);
      const state = strArg(args, 'state').toLowerCase();
      const issues = repo.issues
        .filter((i) => state === '' || state === 'all' || i.state === state)
        .map((i) => ({
          number: i.number,
          id: nodeId('Issue', repo.id, i.number),
          title: i.title,
          body: i.body,
          state: i.state,
        }));
      return toolResult(id, { issues, full_name: repo.fullName, owner, repo: name });
    }

    case 'create_pull_request': {
      const title = strArg(args, 'title');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      const { owner, name, repo } = resolveRepo(store, args);
      if (title === '' || head === '' || base === '' || !repo) {
        return rpcError(id, -32602, 'create_pull_request requires owner, repo, title, head and base.');
      }
      const body = strArg(args, 'body');
      const pr = store.createPull(repo, title, body, head, base, VIEWER);
      const obj: Record<string, unknown> = {
        number: pr.number,
        pull_number: pr.number,
        id: nodeId('PullRequest', repo.id, pr.number),
        title: pr.title,
        body: pr.body,
        state: 'open',
        head,
        base,
        head_ref: head,
        base_ref: base,
        full_name: repo.fullName,
        owner,
        repo: name,
      };
      return toolResult(id, obj);
    }

    case 'merge_pull_request': {
      const raw = getArg(args, 'pull_number');
      const num = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      const { owner, name, repo } = resolveRepo(store, args);
      if (!repo || Number.isNaN(num)) {
        return rpcError(id, -32602, 'merge_pull_request requires owner, repo and pull_number.');
      }
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) return rpcError(id, -32602, `Pull request not found: ${owner}/${name}#${num}`);
      doMerge(repo, pr);
      const obj: Record<string, unknown> = {
        number: pr.number,
        pull_number: pr.number,
        id: nodeId('PullRequest', repo.id, pr.number),
        title: pr.title,
        state: 'closed',
        merged: true,
        head: pr.headRef,
        base: pr.baseRef,
        full_name: repo.fullName,
        owner,
        repo: name,
      };
      return toolResult(id, obj);
    }

    default:
      return rpcError(id, -32601, `Unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------------ handler

export function handleMcp(
  method: string,
  path: string,
  _query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  ctx: Ctx,
): Resp | null {
  if (path !== '/mcp' || method !== 'POST') return null;

  const text = body.toString('utf8');
  let req: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object.', 400);
    }
    req = parsed as Record<string, unknown>;
  } catch {
    // Parse error. Modern era (2026-07-28): HTTP 400 + -32700.
    return rpcError(null, -32700, 'Parse error: request body is not valid JSON.', 400);
  }

  const id: unknown = 'id' in req ? req['id'] : null;
  const rpcMethod = typeof req['method'] === 'string' ? (req['method'] as string) : '';
  const params = (req['params'] ?? {}) as Record<string, unknown>;

  // Mirror the modern-era transport headers back on the response.
  const mirror: Record<string, string> = {};
  const protoVersion = headers['mcp-protocol-version'];
  if (protoVersion) mirror['mcp-protocol-version'] = protoVersion;
  else mirror['mcp-protocol-version'] = MODERN_REVISION;
  if (rpcMethod !== '') mirror['mcp-method'] = rpcMethod;

  // Notifications carry no id and get no JSON-RPC response (202, empty).
  if (id === null && !('id' in req)) {
    if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
      return { status: 202, headers: { ...JSON_HEADERS, ...mirror }, body: '' };
    }
    return rpcError(null, -32600, 'Invalid Request: missing id.', 400, mirror);
  }

  switch (rpcMethod) {
    case 'server/discover': {
      return rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        instructions: 'GitHub-compatible git forge: repositories, issues and pull requests over REST, GraphQL and MCP.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }, mirror);
    }

    case 'initialize': {
      const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
      const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : MODERN_REVISION;
      // Legacy era: hand out a session id the client may echo back.
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }, { ...mirror, 'mcp-session-id': 'sess-1' });
    }

    case 'ping': {
      return rpcResult(id, {}, mirror);
    }

    case 'tools/list': {
      // Byte-identical tools array on every call: the frozen serialisation.
      return {
        status: 200,
        headers: { ...JSON_HEADERS, ...mirror },
        body: `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":{"tools":${TOOLS_JSON}}}`,
      };
    }

    case 'tools/call': {
      // Auth is probed ONLY here: missing Authorization -> HTTP 401.
      const tok = bearer(headers);
      if (tok === null || tok === '') {
        return rpcError(id, -32000, 'Unauthorized: missing Authorization header.', 401, mirror);
      }
      if (ctx.token !== null && tok !== ctx.token) {
        return rpcError(id, -32000, 'Unauthorized: invalid token.', 401, mirror);
      }
      const toolName = typeof params['name'] === 'string' ? (params['name'] as string) : '';
      const args = (params['arguments'] ?? {}) as Record<string, unknown>;
      if (toolName === '') return rpcError(id, -32602, 'tools/call requires a tool name.', 200, mirror);
      return callTool(ctx, id, toolName, args);
    }

    default: {
      // Unknown method (incl. resources/prompts/sampling, never exercised):
      // -32601, never HTTP 500. A discover refusal of -32601 is what lets a
      // pre-discover client fall back to legacy initialize; we implement
      // discover, so this path is only reached for other unknown methods.
      return rpcError(id, -32601, `Method not found: ${rpcMethod}`, 200, mirror);
    }
  }
}
