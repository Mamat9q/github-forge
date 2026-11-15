// GraphQL v4 surface for the make.fun github-core-clone-01 forge.
// Dispatches the 18 fixed documents from spec-graphql.md by operation name
// (the client never sends operationName). Shares the single in-memory Store
// with REST v3, so every mutation is immediately visible over REST.
// Node 22, stdlib only, type-stripping (no enums, no parameter properties).

import { VIEWER, nodeId, parseNodeId, fixedIso } from './store.ts';
import type { Store, Repo, Issue, Pull } from './store.ts';

export interface Ctx { store: Store; token: string | null; reqId: () => string; }
export interface Resp { status: number; headers?: Record<string, string>; body: string | Buffer; }

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };

function json(status: number, body: unknown): Resp {
  return { status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

function bearer(headers: Record<string, string | undefined>): string | null {
  const h = headers['authorization'];
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+?)\s*$/);
  return m ? m[1] : null;
}

function authed(headers: Record<string, string | undefined>, ctx: Ctx): boolean {
  const tok = bearer(headers);
  if (tok === null || tok === '') return false;
  if (ctx.token !== null && tok !== ctx.token) return false;
  return true;
}

// ------------------------------------------------------------------ ids

function repoNodeId(repo: Repo): string {
  return nodeId('Repository', repo.id, repo.id);
}
function issueNodeId(repo: Repo, issue: Issue): string {
  return nodeId('Issue', repo.id, issue.number);
}
function pullNodeId(repo: Repo, pr: Pull): string {
  return nodeId('PullRequest', repo.id, pr.number);
}

function findRepoByNodeId(store: Store, id: string): Repo | undefined {
  const p = parseNodeId(id);
  if (!p || p.kind !== 'Repository') return undefined;
  for (const r of store.repos.values()) if (r.id === p.repoId) return r;
  return undefined;
}

function findIssueByNodeId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const p = parseNodeId(id);
  if (!p || p.kind !== 'Issue') return undefined;
  for (const r of store.repos.values()) {
    if (r.id !== p.repoId) continue;
    const issue = r.issues.find((i) => i.number === p.n);
    if (issue) return { repo: r, issue };
  }
  return undefined;
}

function findPullByNodeId(store: Store, id: string): { repo: Repo; pull: Pull } | undefined {
  const p = parseNodeId(id);
  if (!p || p.kind !== 'PullRequest') return undefined;
  for (const r of store.repos.values()) {
    if (r.id !== p.repoId) continue;
    const pull = r.pulls.find((x) => x.number === p.n);
    if (pull) return { repo: r, pull };
  }
  return undefined;
}

// ------------------------------------------------------------------ views

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repoNodeId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function mergeableOf(repo: Repo, pr: Pull): string {
  const headTip = repo.branchTip(pr.headRef);
  const baseTip = repo.branchTip(pr.baseRef);
  if (headTip === '' || baseTip === '') return 'UNKNOWN';
  return 'MERGEABLE';
}

function pullView(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pullNodeId(repo, pr),
    number: pr.number,
    title: pr.title,
    state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergeable: mergeableOf(repo, pr),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
  };
}

/** Changed paths of a PR: diff of the head tip against the merge-base (or base tip). */
function changedPaths(repo: Repo, pr: Pull): string[] {
  const headTip = repo.branchTip(pr.headRef);
  if (headTip === '') return [];
  const baseTip = repo.branchTip(pr.baseRef);
  const base = repo.mergeBase(baseTip, headTip) || baseTip;
  const headFiles = repo.filesAtCommit(headTip);
  const baseFiles = repo.filesAtCommit(base);
  const paths = new Set<string>([...headFiles.keys(), ...baseFiles.keys()]);
  const out: string[] = [];
  for (const p of paths) {
    const h = headFiles.get(p);
    const b = baseFiles.get(p);
    if (!h || !b || h.sha !== b.sha || h.mode !== b.mode) out.push(p);
  }
  return out.sort();
}

/** Squash-merge: head content lands on the base branch as a real merge commit. */
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

// ------------------------------------------------------------------ introspection

function fieldNames(names: string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'author', 'assignee', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'headRefOid', 'baseRefOid', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'url', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'isPrivate', 'createdAt', 'updatedAt', 'defaultBranch', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI'];

// ------------------------------------------------------------------ cursors

function encodeCursor(offset: number): string {
  return Buffer.from(`c:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const s = Buffer.from(after, 'base64url').toString('utf8');
    const m = s.match(/^c:(\d+)$/);
    if (m) return Number(m[1]);
  } catch {
    // fall through
  }
  return 0;
}

// ------------------------------------------------------------------ execution

type GqlResult = { data: unknown; errors?: Array<{ message: string }> };

function gqlError(message: string, data: unknown = null): GqlResult {
  return { data, errors: [{ message }] };
}

function execOp(query: string, variables: Record<string, unknown>, ctx: Ctx): GqlResult {
  const store = ctx.store;
  const norm = query.replace(/#[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

  // The one invalid-field document: HTTP 200 + errors naming the field.
  if (norm.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: VIEWER.login } },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }],
    };
  }

  const opMatch = norm.match(/^(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  const op = opMatch ? opMatch[1] : '';
  const v = variables ?? {};

  const owner = typeof v['owner'] === 'string' ? (v['owner'] as string) : '';
  const name = typeof v['name'] === 'string' ? (v['name'] as string) : '';
  const repo = owner !== '' || name !== '' ? store.getRepo(owner, name) : undefined;

  switch (op) {
    case 'ViewerLogin': {
      return { data: { viewer: { login: VIEWER.login } } };
    }

    case 'RepositoryFields': {
      if (!repo) return { data: { repository: null } };
      return { data: { repository: repoView(repo) } };
    }

    case 'Issue_fields': {
      return { data: { Issue: { fields: fieldNames(ISSUE_FIELDS) } } };
    }

    case 'PullRequestAndRepositoryFields': {
      return {
        data: {
          PullRequest: { fields: fieldNames(PULL_REQUEST_FIELDS) },
          Repository: { fields: fieldNames(REPOSITORY_FIELDS) },
        },
      };
    }

    case 'SearchType_enumValues': {
      return { data: { SearchType: { enumValues: fieldNames(SEARCH_TYPE_VALUES) } } };
    }

    case 'OpenIssues': {
      if (!repo) return { data: { repository: null } };
      const first = typeof v['first'] === 'number' ? (v['first'] as number) : 10;
      const nodes = repo.issues
        .filter((i) => i.state === 'open')
        .sort((a, b) => b.number - a.number)
        .slice(0, first)
        .map((i) => issueView(repo, i));
      return { data: { repository: { issues: { nodes } } } };
    }

    case 'IssueByNumber': {
      if (!repo) return { data: { repository: null } };
      const n = typeof v['number'] === 'number' ? (v['number'] as number) : 0;
      const issue = repo.issues.find((i) => i.number === n);
      return { data: { repository: { issue: issue ? issueView(repo, issue) : null } } };
    }

    case 'PullRequests': {
      if (!repo) return { data: { repository: null } };
      const first = typeof v['first'] === 'number' ? (v['first'] as number) : 5;
      const nodes = repo.pulls.slice(0, first).map((p) => pullView(repo, p));
      return { data: { repository: { pullRequests: { nodes } } } };
    }

    case 'PullRequestFiles': {
      if (!repo) return { data: { repository: null } };
      const n = typeof v['number'] === 'number' ? (v['number'] as number) : 0;
      const pr = repo.pulls.find((p) => p.number === n);
      if (!pr) return { data: { repository: { pullRequest: null } } };
      const nodes = changedPaths(repo, pr).map((path) => ({ path }));
      return { data: { repository: { pullRequest: { number: pr.number, files: { nodes } } } } };
    }

    case 'PullRequestId': {
      if (!repo) return { data: { repository: null } };
      const n = typeof v['number'] === 'number' ? (v['number'] as number) : 0;
      const pr = repo.pulls.find((p) => p.number === n);
      if (!pr) return { data: { repository: { pullRequest: null } } };
      return { data: { repository: { pullRequest: { id: pullNodeId(repo, pr), number: pr.number } } } };
    }

    case 'IssuesPage': {
      if (!repo) return { data: { repository: null } };
      const first = typeof v['first'] === 'number' ? (v['first'] as number) : 5;
      const offset = decodeCursor(v['after']);
      const sorted = [...repo.issues].sort((a, b) => b.number - a.number);
      const page = sorted.slice(offset, offset + first);
      const end = offset + page.length;
      const nodes = page.map((i) => ({ number: i.number }));
      return {
        data: {
          repository: {
            issues: {
              nodes,
              pageInfo: { hasNextPage: end < sorted.length, endCursor: encodeCursor(end) },
            },
          },
        },
      };
    }

    case 'NodeRepository': {
      const id = typeof v['id'] === 'string' ? (v['id'] as string) : '';
      const found = findRepoByNodeId(store, id);
      if (!found) return { data: { node: null } };
      return { data: { node: { id, name: found.name, nameWithOwner: found.fullName } } };
    }

    case 'IssueCreate': {
      const input = (v['input'] ?? {}) as Record<string, unknown>;
      const repoId = typeof input['repositoryId'] === 'string' ? (input['repositoryId'] as string) : '';
      const target = findRepoByNodeId(store, repoId);
      if (!target) return gqlError(`Could not resolve to a Repository with the id of '${repoId}'.`, { createIssue: null });
      const title = typeof input['title'] === 'string' ? (input['title'] as string) : '';
      const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
      const issue = store.createIssue(target, title, body, [], VIEWER);
      return { data: { createIssue: { issue: { number: issue.number, id: issueNodeId(target, issue) } } } };
    }

    case 'IssueClose': {
      const input = (v['input'] ?? {}) as Record<string, unknown>;
      const issueId = typeof input['issueId'] === 'string' ? (input['issueId'] as string) : '';
      const found = findIssueByNodeId(store, issueId);
      if (!found) return gqlError(`Could not resolve to an Issue with the id of '${issueId}'.`, { closeIssue: null });
      found.issue.state = 'closed';
      found.issue.closed_at = fixedIso();
      found.issue.updated_at = fixedIso();
      return {
        data: {
          closeIssue: {
            issue: { number: found.issue.number, id: issueNodeId(found.repo, found.issue), state: 'CLOSED' },
          },
        },
      };
    }

    case 'PullRequestCreate': {
      const input = (v['input'] ?? {}) as Record<string, unknown>;
      const repoId = typeof input['repositoryId'] === 'string' ? (input['repositoryId'] as string) : '';
      const target = findRepoByNodeId(store, repoId);
      if (!target) return gqlError(`Could not resolve to a Repository with the id of '${repoId}'.`, { createPullRequest: null });
      const title = typeof input['title'] === 'string' ? (input['title'] as string) : '';
      const baseRef = typeof input['baseRefName'] === 'string' ? (input['baseRefName'] as string) : target.defaultBranch;
      const headRef = typeof input['headRefName'] === 'string' ? (input['headRefName'] as string) : '';
      const pr = store.createPull(target, title, '', headRef, baseRef, VIEWER);
      return {
        data: {
          createPullRequest: {
            pullRequest: { number: pr.number, id: pullNodeId(target, pr), state: 'OPEN', headRefName: pr.headRef, baseRefName: pr.baseRef },
          },
        },
      };
    }

    case 'MergePullRequest': {
      const input = (v['input'] ?? {}) as Record<string, unknown>;
      const prId = typeof input['pullRequestId'] === 'string' ? (input['pullRequestId'] as string) : '';
      const found = findPullByNodeId(store, prId);
      if (!found) return gqlError(`Could not resolve to a PullRequest with the id of '${prId}'.`, { mergePullRequest: null });
      doMerge(found.repo, found.pull);
      return {
        data: {
          mergePullRequest: {
            pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' },
          },
        },
      };
    }

    case 'AddComment': {
      const input = (v['input'] ?? {}) as Record<string, unknown>;
      const subjectId = typeof input['subjectId'] === 'string' ? (input['subjectId'] as string) : '';
      const body = typeof input['body'] === 'string' ? (input['body'] as string) : '';
      const found = findIssueByNodeId(store, subjectId);
      if (!found) return gqlError(`Could not resolve to an Issue with the id of '${subjectId}'.`, { addComment: null });
      const comment = {
        id: found.repo.nextCommentId++,
        body,
        user: VIEWER,
        created_at: fixedIso(),
        updated_at: fixedIso(),
      };
      found.issue.comments.push(comment);
      return {
        data: {
          addComment: {
            commentEdge: {
              node: { id: nodeId('IssueComment', found.repo.id, comment.id), body },
            },
          },
        },
      };
    }

    default: {
      return gqlError(`Unknown operation '${op || 'anonymous'}'.`);
    }
  }
}

function envelope(result: GqlResult): Record<string, unknown> {
  const out: Record<string, unknown> = { data: result.data ?? null };
  if (result.errors && result.errors.length > 0) out['errors'] = result.errors;
  else out['errors'] = [];
  return out;
}

export function handleGraphQL(
  method: string,
  path: string,
  _query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  ctx: Ctx,
): Resp | null {
  if (path !== '/api/graphql' || method !== 'POST') return null;
  if (!authed(headers, ctx)) {
    return json(401, { message: 'Requires authentication' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return json(200, { data: null, errors: [{ message: 'Request body is not valid JSON.' }] });
  }
  if (Array.isArray(parsed)) {
    const out = parsed.map((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>)['query'] !== 'string') {
        return { data: null, errors: [{ message: 'Batched entry is not a valid GraphQL operation.' }] };
      }
      const e = entry as Record<string, unknown>;
      const vars = (e['variables'] ?? {}) as Record<string, unknown>;
      return envelope(execOp(e['query'] as string, vars, ctx));
    });
    return json(200, out);
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>)['query'] !== 'string') {
    return json(200, { data: null, errors: [{ message: 'Request body must be a GraphQL operation object.' }] });
  }
  const p = parsed as Record<string, unknown>;
  const vars = (p['variables'] ?? {}) as Record<string, unknown>;
  return json(200, envelope(execOp(p['query'] as string, vars, ctx)));
}
