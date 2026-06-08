import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const GH = 'https://api.github.com';
const ghHeaders = {
  Authorization: `token ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
};

// ── Relay ─────────────────────────────────────────────────────────────────────
app.post('/api/admin/relay', async (req, res) => {
  const { adminPassword, action, ...params } = req.body;

  if (adminPassword !== process.env.ADMIN_PASSWORD)
    return res.status(403).json({ success: false, error: 'Unauthorized' });

  try {

    // Generic GET — /repos/owner/repo/contents, /repos/owner/repo/issues, etc.
    if (action === 'github-get') {
      const { path } = params;
      if (!path) return res.status(400).json({ success: false, error: 'path required' });
      const r = await fetch(`${GH}${path}`, { headers: ghHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ success: false, error: data.message });
      return res.json({ success: true, data });
    }

    // Read a single file — returns decoded utf-8 content + sha
    if (action === 'github-read') {
      const { path, branch = 'main' } = params;
      if (!path) return res.status(400).json({ success: false, error: 'path required' });
      const r = await fetch(`${GH}${path}?ref=${branch}`, { headers: ghHeaders });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ success: false, error: data.message });
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return res.json({ success: true, content, sha: data.sha, size: data.size });
    }

    // Write / update a file
    if (action === 'github-write') {
      const { path, content, message, branch = 'main' } = params;
      if (!path || !content || !message)
        return res.status(400).json({ success: false, error: 'path, content, and message required' });

      // Get current SHA if file exists
      const check = await fetch(`${GH}${path}?ref=${branch}`, { headers: ghHeaders });
      const checkData = await check.json();

      const body = { message, content: Buffer.from(content).toString('base64'), branch };
      if (check.ok) body.sha = checkData.sha;

      const r = await fetch(`${GH}${path}`, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ success: false, error: data.message });
      return res.json({ success: true, sha: data.commit.sha, url: data.commit.html_url });
    }

    // Generic POST (create issues, PRs, etc.)
    if (action === 'github-post') {
      const { path, body: postBody } = params;
      if (!path) return res.status(400).json({ success: false, error: 'path required' });
      const r = await fetch(`${GH}${path}`, {
        method: 'POST',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(postBody),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ success: false, error: data.message });
      return res.json({ success: true, data });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });

  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('Relay ready'));
