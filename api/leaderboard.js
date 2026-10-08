// api/leaderboard.js — Vercel Edge function that proxies the atlas-api
// locked-score leaderboard. Edge runtime has a different TLS stack.
//
// GET /api/leaderboard?playerId=2544&limit=1000

export const config = { runtime: 'edge' };

const ATLAS_URL = 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.LeaderboardService/GetLeaderboardPage';

export default async function handler(request) {
  const url = new URL(request.url);
  const playerId = url.searchParams.get('playerId');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000', 10), 1000);

  if (!playerId) {
    return new Response(JSON.stringify({ error: 'playerId required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const boardId = `nba:player:${playerId}`;

  try {
    // Fetch first page
    const firstRes = await fetch(ATLAS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: JSON.stringify({ leaderboard_id: boardId, cursor: '', limit: 100 }),
    });

    if (!firstRes.ok) {
      const text = await firstRes.text();
      return new Response(JSON.stringify({ error: `Atlas API ${firstRes.status}`, detail: text.slice(0, 200) }), {
        status: firstRes.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    let page = await firstRes.json();
    let allEntries = page.entries || [];
    let totalCount = page.totalCount || 0;
    let hasMore = page.hasMore || false;
    let nextCursor = page.nextCursor || '';

    // Fetch additional pages up to limit
    while (hasMore && allEntries.length < limit) {
      const pageRes = await fetch(ATLAS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
        },
        body: JSON.stringify({ leaderboard_id: boardId, cursor: nextCursor, limit: 100 }),
      });
      if (!pageRes.ok) break;
      const pageData = await pageRes.json();
      allEntries = allEntries.concat(pageData.entries || []);
      hasMore = pageData.hasMore || false;
      nextCursor = pageData.nextCursor || '';
    }

    allEntries = allEntries.slice(0, limit);

    const entries = allEntries.map(e => ({
      rank: Number(e.rank) || 0,
      lockedScore: e.score == null || e.score === '' || !Number.isFinite(Number(e.score)) || Number(e.score) < 0 ? null : Number(e.score),
      displayScore: Number(e.displayScore) || 0,
      username: e.user?.username || null,
      flowAddress: e.user?.flowAddress || null,
      profileImageUrl: e.user?.profileImageUrl || null,
      dapperId: e.user?.dapperId || null,
    }));

    return new Response(JSON.stringify({
      playerId,
      entries,
      totalCount,
      hasMore: allEntries.length < totalCount,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to fetch leaderboard', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
