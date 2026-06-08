# GitNexus — self-hosted shared code-graph brain (setup & replication guide)

GitNexus is a self-hosted **code knowledge graph** that indexes repositories into a
queryable graph (files · functions · classes · methods · call/import/inheritance
edges · auto-detected communities · execution-flow "processes"). It runs as a
remote **MCP server**, so any Claude Code (or other MCP-capable) session can ask
structural questions about a codebase — "who calls `resolveTenant`", "what's the
blast radius of changing this function", "trace the auth flow" — that grep and
file-reads answer poorly.

One GitNexus instance can be a **shared brain across many repos**: index several
repositories into the same service and query any of them (or across them) from a
session in any repo.

> Conventions in this guide: replace `<brain-host>` with your service's public
> host (e.g. `your-brain.onrender.com`), `<owner>/<repo>` with a real repository,
> and `<your-org>` with your GitHub org/owner.

---

## 1. Stand up the service

GitNexus ships as a Docker image, so any host that runs a container with a
persistent volume works (Render, Fly, a VM, etc.). The reference setup below uses
a managed web service, but nothing here is host-specific.

| Setting | Recommendation |
|---|---|
| Image | `mekayelanik/gitnexus-mcp:latest` (a packaged recipe around upstream [`abhigyanpatwari/GitNexus`](https://github.com/abhigyanpatwari/GitNexus)). **Pin to a digest** for reproducibility rather than a floating tag. |
| Memory | **≥ 4 GB RAM / 2 vCPU.** Indexing is memory-hungry — a 512 MB instance OOM-kills on a real repo (see Gotchas). |
| Disk | A **persistent volume mounted at `/data`** (e.g. 10 GB). The indexed graph **and** git credentials persist here across restarts. |
| Port / health | The container serves HTTP on its configured port; expose it behind TLS. The root path serves a GitNexus web UI; `/docs` and `/redoc` serve the API docs. |

After it boots you have:

| Surface | URL |
|---|---|
| Public base | `https://<brain-host>` |
| MCP endpoint | `https://<brain-host>/api/mcp` — note: **`/api/mcp`, not `/mcp`** |
| REST API | `https://<brain-host>/api/*` (analyze / repos / etc.) |

---

## 2. MCP wiring (`.mcp.json`)

Every repo that wants to query the brain carries this entry in its `.mcp.json`:

```json
{
  "mcpServers": {
    "gitnexus-remote": {
      "type": "http",
      "url": "https://<brain-host>/api/mcp"
    }
  }
}
```

- `type: http` (streamable-HTTP transport — one POST endpoint that returns SSE),
  **not** `sse`. The client handles the `Mcp-Session-Id` round-trip automatically.
- No auth header in this reference config — the server accepts unauthenticated MCP
  init. If you put the service on a public host, gate it (see "Securing it").
- **MCP servers load at session start.** Editing `.mcp.json` mid-session does
  nothing; restart the session/container for the `gitnexus-*` tools to surface.

### MCP tools exposed

`list_repos` · `query` (execution-flow search) · `context` (360° view of one
symbol) · `cypher` (raw graph query) · `impact` (blast-radius) · `detect_changes`
(map an uncommitted diff → affected flows) · `rename` (graph-aware multi-file
rename) · `route_map` · `tool_map` · `shape_check` · `api_impact` · `group_list`
· `group_sync`. (Exact set varies by GitNexus version.)

With multiple repos indexed, pass `"repo":"<name>"` to scope a call (e.g.
`"repo":"<repo>"`); `list_repos` shows what's available. You can omit `repo` only
when a single repo is indexed.

---

## 3. Indexing a repo (the analyze flow)

Indexing is a **REST call**, not an MCP tool — the MCP surface is query-only and
assumes repos are already indexed. The server clones the repo to `/data` and
builds the graph.

```bash
# 1. Kick off (returns {"jobId":"…","status":"cloning"}).
#    "embeddings":true turns on semantic search — see "Embeddings" below.
curl -X POST https://<brain-host>/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/<owner>/<repo>.git","embeddings":true}'

# 2. Poll job status until complete (DON'T use /progress — see Gotchas)
curl https://<brain-host>/api/analyze/<jobId>

# 3. Confirm it landed
curl https://<brain-host>/api/repos
```

- `POST /api/analyze` also accepts `{"path":"/data/<dir>"}` to index a directory
  already on the server's disk.
- Re-running analyze on an indexed repo **refreshes** it (idempotent). Embedding
  is incremental — only new/changed symbols are re-embedded — so a no-op refresh
  is cheap.
- The job body keeps the index fresh; to automate it, hit `/api/analyze` from a
  cron job or a per-repo "on push to main" CI workflow.

### Embeddings (semantic search)

Embeddings are **off unless you ask for them** — without `"embeddings":true` the
repo indexes at `embeddings: 0` and only structural search works. Two important
facts:

- GitNexus reads the `embeddings` flag from the **request body only**. Always send
  `{"embeddings":true}` on the analyze call; an env var won't turn it on.
- The default embedder is a **local model downloaded at runtime** (no third-party
  API key needed). The first index that needs it pulls the model over the network,
  so the host needs outbound egress on first run. Structural query / context /
  impact / cypher all work **without** embeddings.

> **Egress-locked host?** If the service can't reach the model host at runtime,
> pre-bake the model into the image at build time (run one throwaway
> `analyze --embeddings` during the Docker build so the model lands in the image's
> cache). Alternatively, point GitNexus at an OpenAI-compatible embedding endpoint
> via `GITNEXUS_EMBEDDING_URL` + `GITNEXUS_EMBEDDING_MODEL`.

### Private-repo auth (the credential helper)

GitNexus has **no `GITHUB_TOKEN` env var** — an anonymous `git clone` of a private
repo fails with `Authentication failed`. Solve it once, persistently, with a git
credential helper on the `/data` disk:

1. On the running container (a shell into the service), do a one-time setup that
   writes:
   - `/data/.git-credentials` (mode `600`, holding
     `https://x-access-token:<PAT>@github.com`), and
   - `/data/.gitconfig` with
     `credential.helper = store --file=/data/.git-credentials`.
2. Set the env var **`GIT_CONFIG_GLOBAL=/data/.gitconfig`** on the service so git
   picks up that config.

Result: `POST /api/analyze` with a **clean** `https://github.com/<owner>/<repo>.git`
URL authenticates via the on-disk credential — **no PAT ever rides in a request
body**, and it survives restarts because both files live on the mounted disk.
Use a token (PAT or GitHub App installation token) scoped to the org/repos you'll
index.

- **Rotate the PAT:** re-write `/data/.git-credentials` from the container shell.
- **Revoke:** delete that file (analyze then falls back to anonymous, which fails
  for private repos — the safe default).

---

## 4. Querying the brain from a session

Once a repo's `.mcp.json` carries the `gitnexus-remote` entry **before the session
starts**, the agent can call the tools above, scoping with `"repo":"<name>"`.

### Drop-in prompt to index a new repo

Paste this into a fresh session in any repo you want indexed (the server already
holds the git credentials, so no token plumbing is needed agent-side):

```
Index this repo into the shared GitNexus brain at https://<brain-host>.
The server already has on-disk GitHub credentials for the org, so no
PAT/token plumbing is needed on your side.

Steps:
1. Get the repo's HTTPS git URL from `git remote get-url origin`. If it's the SSH
   form (git@github.com:owner/repo.git), convert it to
   https://github.com/owner/repo.git.
2. POST https://<brain-host>/api/analyze with
   {"url":"<https URL>","embeddings":true} — returns {"jobId":"…"}.
3. Poll GET https://<brain-host>/api/analyze/<jobId> every 5s until status is
   "complete" or "failed". Don't use the /progress SSE endpoint — a load
   balancer can kill it mid-stream.
4. On success, GET https://<brain-host>/api/repos and report the new entry's
   stats (files, nodes, edges, communities, processes, embeddings, last commit).

Re-running analyze on an already-indexed repo refreshes it — that's fine, report
the new stats. If analyze takes much longer than expected or the service 5xxs,
stop and report (likely OOM — needs a bigger plan).
```

---

## 5. Gotchas (learned the hard way)

- **MCP path is `/api/mcp`, not `/mcp`.** `GET /mcp` serves the web UI and
  `POST /mcp` 404s, so a misconfigured URL makes the client silently drop the
  server at startup (no tools, no error).
- **Don't tail `/api/analyze/<job>/progress` for the outcome.** It's a long-lived
  SSE stream; a load balancer / edge TLS rotation can kill the connection
  mid-stream and return a 5xx page with zero events — even though the analyze
  *succeeded* server-side. Poll `GET /api/analyze/<job>` instead.
- **In-memory job state is lost on restart.** After a crash/redeploy, the job id
  returns `{"error":"Job not found"}` — but a *completed* index persists on
  `/data` (check `/api/repos`). Jobs are ephemeral; the graph is durable.
- **The brain serializes analyze jobs.** A second `POST /api/analyze` while one is
  still running gets `HTTP 409`. If you sweep multiple repos, wait for each job to
  reach a terminal state (or back off and retry on 409) before starting the next.
- **Small instances OOM on a real repo.** A mid-size repo can peak well past
  512 MB during indexing and crash a small instance in under a minute; the same
  repo finishes in ~20–30 s with 4 GB. Keep headroom as more/larger repos are
  added. On a `502/503/504` or OOM, **don't hammer-retry** — let it recover.
- **The persistent clone can wedge.** Because analysis writes generated artifacts
  into the on-disk clone (e.g. `CLAUDE.md` / `AGENTS.md` / `.claude/`), a later
  `git pull` can fail on the dirtied tree. Recover by deleting the brain's clone
  (`DELETE /api/repo?repo=<name>`) and re-analyzing fresh, or reset+clean the
  clone before the pull so refreshes stay incremental.

---

## 6. Securing it (if the host is public)

The reference MCP config is unauthenticated, which is fine on a private network
but not on the open internet. To lock it down:

- Put the mutating REST routes (`POST /api/analyze`, `DELETE /api/repo`) and the
  MCP endpoint behind a bearer token / reverse-proxy auth; keep read-only
  `GET /api/repos` open if you want a quick health check.
- Never put the GitHub PAT in a request body — keep it in the on-disk credential
  helper (above), which is env/disk-only.
- Restrict who can reach the service (IP allow-list, private networking, or an
  auth proxy).

---

## 7. Ops quick reference

- **Watch memory during an index** — it's the thing most likely to bite. Compare
  resident memory against the instance limit while a large repo indexes.
- **Logs** show the useful breadcrumbs: `git clone` stderr (auth failures),
  `MCP HTTP endpoints mounted at /api/mcp` (server ready), and instance restarts.
- **Shell access** into the running container (with `/data` mounted) is how you
  set up / rotate the credential helper.
- **Durability:** the graph lives on `/data` and survives restarts; in-flight jobs
  do not. After a redeploy, re-check `/api/repos` rather than old job ids.
