# Render + Neon SQL Relay

A single authenticated HTTP endpoint that runs ad-hoc SQL against your Neon
Postgres database. It's the pragmatic answer to "I need to inspect or patch
production data right now" without opening a psql tunnel or shipping a one-off
script — you `curl` parameterized SQL and get JSON rows back.

It is also a **loaded gun**: it executes arbitrary SQL with full DB privileges.
Treat the endpoint and its secret accordingly (see Security). The version below
is hardened past the naïve "compare a password and run the query" first draft —
constant-time auth, disabled-by-default when the secret is unset, a payload cap,
and a light audit line.

---

## The endpoint (Express + node-postgres)

```js
import express from 'express';
import { timingSafeEqual } from 'crypto';
import pkg from 'pg';
const { Pool } = pkg;

// One shared pool. On Render + Neon, point at the POOLER connection string
// (…-pooler.…). Never hardcode it — env only.
const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });

// Constant-time secret compare. Returns false on any length/secret mismatch and
// never throws — avoids leaking length via timing and avoids 500s on bad input.
function validAdmin(provided) {
  const expected = process.env.ADMIN_RELAY_PASSWORD;
  if (!expected) return false;            // disabled when unset (see gate below)
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

// POST /api/admin/relay
//   body: { adminPassword: string, query: string, values?: any[] }
//   resp: { success: true, rows, rowCount } | { success: false, error }
export function mountRelay(app) {
  app.post('/api/admin/relay', express.json({ limit: '500kb' }), async (req, res) => {
    // Disabled-when-unset gate: if no secret is configured, the relay does not
    // exist. Prevents an unconfigured deploy from exposing an open SQL endpoint.
    if (!process.env.ADMIN_RELAY_PASSWORD) {
      return res.status(503).json({ success: false, error: 'Relay disabled (ADMIN_RELAY_PASSWORD not set)' });
    }

    const { adminPassword, query, values } = req.body || {};
    if (!validAdmin(adminPassword)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'query (string) required' });
    }

    try {
      const result = await pool.query(query, Array.isArray(values) ? values : []);
      // Light audit — enough to reconstruct "what ran when", without dumping the
      // full statement or parameter values (which may contain secrets/PII).
      console.log(`[RELAY] ${new Date().toISOString()} rows=${result.rowCount} sql="${query.slice(0, 120).replace(/\s+/g, ' ')}"`);
      return res.json({ success: true, rows: result.rows, rowCount: result.rowCount });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });
}
```

Mount it once during app setup:

```js
mountRelay(app);
```

> Minimal/naïve variant (what this hardens past): drop `validAdmin` + the
> disabled gate and inline `if (adminPassword !== process.env.ADMIN_RELAY_PASSWORD)`.
> It works, but it's a plain (timing-leaky) compare with no off-switch. Prefer the
> hardened version above for anything reused across sites.

---

## Environment

```bash
# Neon pooled connection string (Render dashboard → Environment).
NEON_DATABASE_URL=postgres://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/DB?sslmode=require

# The relay secret. Long + random. If unset, the relay returns 503 (disabled).
ADMIN_RELAY_PASSWORD=<48+ random chars>
```

Generate a secret: `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`

On Render: set both in the service's Environment (or a linked Environment Group).
**Never** use Render's bulk env-var `PUT` API — it replaces ALL vars; use the
dashboard or single-key updates.

---

## Usage

```bash
# Inspect
curl -sS https://yourapp.com/api/admin/relay \
  -H 'Content-Type: application/json' \
  -d '{
    "adminPassword": "'"$ADMIN_RELAY_PASSWORD"'",
    "query": "SELECT id, status FROM jobs WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 20",
    "values": ["abc-123"]
  }'
```

Always use **parameterized** SQL (`$1, $2, …` + `values`) rather than string
interpolation — it's safer and avoids quoting headaches.

---

## Security & operating rules

- **Treat the secret like a root DB password.** Anyone with it can read/modify/drop
  anything. Rotate it if it ever touches a log, a screenshot, or a shared terminal.
- **Never call the relay from client-side code.** Server-to-server or your own
  terminal only — the secret must never reach a browser.
- **Destructive ops are a two-step.** For `UPDATE`/`DELETE`/`DROP`, run a `SELECT`
  first to confirm the row count and target, then run the mutation as a separate
  explicit call. A missing `WHERE` is unrecoverable.
- **Prefer JSONB merge over overwrite.** Use `||` or `jsonb_set()` so you don't
  clobber concurrent writes.
- **Consider hardening further for higher-stakes apps:**
  - A dedicated **read-only DB role** for an inspect-only relay.
  - An **IP allowlist** (Render does not provide this natively; do it in-handler
    against `req.headers['x-forwarded-for']`, or front with a proxy).
  - Persisted audit rows (who/when/sql) instead of just a console line.
  - Block multi-statement queries if you only ever need one statement.
- **Keep it out of `git`.** Only the code is committed; the secret is env-only.

---

## Why this exists (vs. alternatives)

| Need | Relay | psql tunnel | one-off script |
|---|---|---|---|
| Speed for a quick read/patch | ✅ instant | ⚠️ setup | ⚠️ write + deploy |
| Works from anywhere with the secret | ✅ | ⚠️ creds/SSL | ✅ |
| Parameterized + JSON out | ✅ | ⚠️ manual | ✅ |
| Safe by default | ⚠️ only if gated + disciplined | ✅ | ✅ |

The relay wins on speed; it loses on safety unless you keep the secret tight and
follow the destructive-op discipline above. That trade is the whole point — know
it going in.
