// ── AI Relay — device-independent Claude access ──────────────────────────────
app.post('/api/admin/relay', async (req, res) => {
  const { adminPassword, action, ...params } = req.body;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  try {
    if (action === 'sql') {
      const { query, values = [] } = params;
      const result = await pool.query(query, values);
      return res.json({ success: true, rows: result.rows, rowCount: result.rowCount });
    }
    if (action === 'github-read') {
      const { path, branch = 'main' } = params;
      const r = await fetch(`https://api.github.com/repos/BrianBMorgan/repo/contents/${path}?ref=${branch}`, {
        headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ success: false, error: data.message });
      return res.json({ success: true, content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha, size: data.size });
    }
    if (action === 'github-write') {
      const { path, content, message, branch = 'main' } = params;
      const check = await fetch(`https://api.github.com/repos/repos/BrianBMorgan/repo/contentss/${path}?ref=${branch}`, {
        headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
      });
      const checkData = await check.json();
      const body = { message, content: Buffer.from(content).toString('base64'), branch };
      if (check.ok) body.sha = checkData.sha;
      const r = await fetch(`https://api.github.com/repos/repos/BrianBMorgan/repo/contents/${path}`, {
        method: 'PUT',
        headers: { Authorization: `token ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github.v3+json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ success: false, error: data.message });
      return res.json({ success: true, sha: data.commit.sha, url: data.commit.html_url });
    }
    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});
