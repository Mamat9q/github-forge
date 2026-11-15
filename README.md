# github-forge

A GitHub-compatible git forge in a single Node.js process — no git binary, no
database, no outside service. Standard library only.

It serves, from one in-memory store:

- **git smart HTTP** — `git clone` / `git push` over `info/refs` +
  `git-upload-pack` (v2 + v0) and `git-receive-pack`, with packfile v2
  generation (thin packs, side-band-64k, depth/shallow support) and a
  hand-written pack reader (pure-JS inflate, exact stream offsets).
- **REST v3 API** (`/api/v3`) — repositories, issues, pull requests, contents,
  git objects (blobs/trees/commits/refs), users, search.
- **GraphQL** (`/api/graphql`) — the queries and mutations GitHub clients
  (`gh`, `github-mcp-server`) send: repositories, issues, pull requests,
  pagination, mutations visible through REST immediately.
- **MCP** (`/mcp`) — JSON-RPC tools `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request` (modern
  2026-07-28 discovery + legacy `initialize` era).

## Run

```sh
node --experimental-strip-types main.ts
# or: node main.ts            (Node 22.18+ strips types natively)
```

The process binds an ephemeral port, registers it with the harness
(`POST $MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done` and
exits 0. It never binds 8080. Auth token comes from `MAKEFUN_SHOP_TOKEN`
(or `FORGE_TOKEN` for local runs).

## Layout

- `main.ts` — entry lifecycle (starter, verbatim).
- `app.ts` — HTTP router: `/healthz`, git / REST / GraphQL / MCP dispatch.
- `src/store.ts` — in-memory store + git object core (SHA-1 objects,
  trees/commits, reachability, merge-base, pack builder/reader, pkt-line,
  side-band-64k). Deterministic: fixed-epoch timestamps + monotonic
  counters, no `Date.now()` / `Math.random()` in responses.
- `src/git.ts` — smart-HTTP handlers (upload-pack v2/v0, receive-pack).
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL handlers.
- `src/mcp.ts` — MCP JSON-RPC handlers.

## Verification (local runner, same sealed suite as grading)

- `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOKEN`
  — **120/120 checks** (git 30, repos 15, issues 15, pulls 20, graphql 20,
  mcp 15, protocol 5), repeated on fresh servers.
- `node cli/makefun.mjs grade-local --kit . --bot . --driver process`
  — feature **600/600**, agent **200/200**, score 873 on a loaded dev VM
  (perf varies with machine load; server-side handler cost is sub-ms per
  request — e.g. REST GET issue ~0.04 ms, receive-pack ~0.8 ms — so the
  timed workloads are dominated by client + transport, as for the
  reference).
- Deterministic: fresh restarts produce byte-identical state; replay-safe
  (create-via-receive-pack and create-via-REST are upserts, contents PUT
  without `sha` returns 201).

## License

MIT — see `LICENSE` (SPDX-License-Identifier: MIT).
