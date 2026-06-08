## Sending your research to Pitch Box

When you have finished researching an account, push it to Pitch Box with **one**
HTTPS POST. This is the only way your work reaches the board — do it once per
completed account, server-side (curl / HTTP tool), never from a browser.

### The request
```bash
curl -sS -X POST "$PITCHBOX_BASE_URL/api/research" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d @payload.json
```
- `PITCHBOX_BASE_URL` and `INGEST_TOKEN` come from the environment. **Never hardcode
  or print the token.**

### The JSON payload
```json
{
  "account":  "<canonical company name>",
  "title":    "<Company> — account research, <YYYY-MM>",
  "summary":  "<2–3 sentence TL;DR; this is what shows collapsed on the card>",
  "body":     "<full research as Markdown — see structure below>",
  "sources":  ["https://…", "https://…"]
}
```
- **`account`** must be the company's clean, canonical name (e.g. `Mercury`, not
  `mercury financial inc.`). Pitch Box matches it case-insensitively to an existing
  account, or creates one as a `prospect` if it's new. Using the canonical name
  avoids duplicate accounts.
- **`body`** is the full briefing as Markdown — **ship everything, do not truncate.**
  The field holds ~2 MB; density is the goal, not brevity. Use your own natural
  structure (Snapshot, Buyer Surface, Pain & Triggers, Signals, ICP, Angle,
  Sources — and the full **Activation Plan** if you produced one: target universe,
  event-by-event plan, persona×message matrix, partner levers, measurement).

  ```markdown
  ## Snapshot
  What they do, stage, size, category — 3–5 lines.

  ## Buyer surface
  Who to reach (names + roles where known), and who actually owns the budget.

  ## Pain & triggers
  What keeps them up; what makes *now* the moment (launches, hiring, mandates).

  ## Signals
  Recent, dated facts: funding, momentum, press, product moves. Cite in Sources.

  ## Angle
  The candidate hook for Sandbox-XM — why we're the only ones who can pitch this.
  ```
- **`sources`** = the URLs behind your Signals/claims. http/https only.

- **`summary`** is the *only* short field — a 2–3 sentence teaser shown collapsed.
  Put ALL the depth in `body`.

### Handling the response — do NOT retry-loop
| Response | Meaning | What to do |
|---|---|---|
| `200 { ok:true, account_id, research_id, account_created }` | Saved. | Done. Note the ids; move on. |
| `400` | Missing `account` or `body`. | Fix the payload, send **once** more. |
| `403` | Bad/missing token. | **Stop.** Report to Brian — don't retry. |
| `503` | Ingestion disabled (`INGEST_TOKEN` not set on the service). | **Stop.** Report to Brian. |
| network error / 5xx | Transient. | Retry **at most twice**, with a short backoff, then stop and report. |

Never hammer the endpoint. One successful POST per account is the goal; re-running
research later simply adds a new dated entry (it's a log, not an overwrite).

"One POST" means **don't retry-loop on errors** — it does NOT mean send less.
If your research has two natural layers (a briefing *and* an activation plan),
send them as **two entries for the same account** — Pitch Box logs multiple
research entries per account, so nothing has to be compressed to fit one shot.
