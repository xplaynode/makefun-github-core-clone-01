# Lucky Forge — a GitHub-compatible git forge in one process

A standalone, standard-library-only implementation of the GitHub surfaces a
git client, `gh`, and the GitHub MCP server actually use, built for
make.fun's **github-core-clone-01**. One Node process serves everything from
its own in-memory store: no git binary, no database, no outside service.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, upload-pack
  with **protocol v2** (`ls-refs` with ref-prefix filtering, `fetch` with
  want/have negotiation, shallow/deepen, sideband-64k pack framing) and
  receive-pack with **protocol v0** (report-status, fast-forward enforcement,
  branch/tag creation and deletion). Real packfiles both ways: OFS/REF delta
  resolution on read, full-object packs with SHA-1 trailers on write, real
  SHA-1 object identity for commits, trees, blobs and annotated tags.
- **REST v3** under `/api/v3` — repositories (create/list with `Link`
  pagination/patch/delete), branches, git refs, commits, contents
  (create/update/delete with sha checks, branch seeding, unborn-repo first
  commits), labels, issues, comments and pull requests with a real
  line-level three-way merge (squash/merge; conflicts answer 405).
- **GraphQL v4** at `/api/graphql` — a small complete executor for the
  documents `gh` and github-mcp-server send: viewer, repository, issues and
  pull-request connections with cursor pagination, the five mutations
  (createIssue, closeIssue, createPullRequest, mergePullRequest,
  addComment), Relay global ids, request batching, and `__type`/`__schema`
  introspection. Invalid fields answer HTTP 200 with an `errors` array
  naming the field.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP with the modern
  `server/discover` handshake (protocol era 2026-07-28), the legacy
  `initialize` fallback, and the six forge tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) backed by the same store and REST shapes.

Wire discipline: `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on everything
except `GET /healthz`; every reply is `application/json` with a non-empty
`X-GitHub-Request-Id`; errors are JSON with a string `message`; a repo
under a foreign owner is a 404, never a 403. All state is deterministic —
timestamps come from a logical clock, request ids and cursors are
counters — so a replayed trial exports byte-identical state.

## Layout

| File | Role |
| --- | --- |
| `main.ts` | Trial lifecycle: bind an ephemeral port, register it with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0. |
| `app.ts` | HTTP shell: auth, routing, JSON discipline. |
| `pktline.ts` | pkt-line codec and sideband framing. |
| `gitobjects.ts` | SHA-1 object store, pack read/write with delta resolution. |
| `githttp.ts` | info/refs, ls-refs, fetch planning (have-closure exclusion, shallow boundary), receive-pack. |
| `store.ts` | The forge state: repos, refs, issues, pulls, comments, forge-made commits, merges. |
| `merge.ts` | LCS line diffs, three-way text/tree merges, pull-request file diffs. |
| `rest.ts` | The REST v3 routes and GitHub-shaped views. |
| `graphql.ts` | GraphQL lexer/parser/executor, schema and introspection. |
| `mcp.ts` | The MCP JSON-RPC endpoint and tools. |
| `selftest.ts` | In-process end-to-end self-test (40 checks). |

## Run

Trial (what the grader does):

```
node /bot/main.ts            # Node 22, type stripping; env: MAKEFUN_ENV_URL, MAKEFUN_SHOP_TOKEN
```

Locally:

```
node --experimental-strip-types main.ts    # serves on an ephemeral port
node --experimental-strip-types selftest.ts
```

## Verification

Self-test (in-process, drives all four surfaces):

```
SELFTEST: 40 passed, 0 failed
```

The competition's own grading suite from the kit (`program/env/server.mjs`),
run locally against this entry (two full runs, same result on checks):

```
[env] export: state.json (120/120 passed, working 1) and perf.json (176 points) written
[env] export: state.json (120/120 passed, working 1) and perf.json (185 points) written
```

| Workload | Median | Points (of 50) | House reference median |
| --- | --- | --- | --- |
| push (200 sequential pushes) | 385.8 ms | 50 | 1640.8 ms |
| clone (50 concurrent depth-1) | 104.4 ms | 42 | 266.9 ms |
| read (2,000 issue GETs, keep-alive) | 929.7 ms | 45 | 2759.7 ms |
| write (200 issue creations) | 161.2 ms | 39 | 349.0 ms |

Estimated score by the competition's formula: 600 feature (120/120) +
200 agent-native (MCP 15/15) + 176–185 performance = **976–985 / 1000**,
ahead of the house reference forge (~900 at its own calibration medians).

## License

MIT — see `LICENSE`.
