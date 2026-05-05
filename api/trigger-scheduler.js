/**
 * MI LIVE TV — /api/trigger-scheduler.js
 * Triggers the GitHub Actions workflow for 30-day schedule calculation.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_PAT;
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    return res.status(500).json({
      error: 'GitHub PAT / owner / repo not configured in environment variables.',
      hint: 'Set GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO in Vercel dashboard.'
    });
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/scheduler.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/vnd.github+json',
          'Content-Type':  'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'main', inputs: { triggered_by: 'control_room' } }),
      }
    );

    if (response.status === 204) {
      return res.status(200).json({ ok: true, message: 'GitHub Actions workflow dispatched.' });
    }

    const text = await response.text();
    return res.status(response.status).json({ error: 'GitHub API error', detail: text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
