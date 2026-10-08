// Explicit provenance and ranking state. No network calls or analytics here.
(function (root) {
  function score(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function applyRanking(player, response) {
    const entries = response && Array.isArray(response.entries) ? response.entries : null;
    const valid = entries && entries.every(e => e && typeof e.flowAddress === 'string' && e.flowAddress.length > 0 && score(e.lockedScore) !== null)
      && new Set(entries.map(e => e.flowAddress.toLowerCase())).size === entries.length;
    const byAddress = new Map(valid ? entries.map(e => [e.flowAddress.toLowerCase(), e]) : []);
    const owners = player.owners || [];
    const matched = owners.filter(o => byAddress.has(String(o.flowAddress).toLowerCase())).length;
    // An empty result or a result with no matching holders cannot rank this collection.
    const mode = valid && matched > 0 ? 'locked' : 'holdings';
    owners.forEach(o => {
      const entry = mode === 'locked' ? byAddress.get(String(o.flowAddress).toLowerCase()) : null;
      o.lockedScore = entry ? score(entry.lockedScore) : null;
      o.lockedRank = entry && Number.isInteger(entry.rank) && entry.rank > 0 ? entry.rank : null;
    });
    owners.sort((a, b) => mode === 'locked'
      ? (b.lockedScore === null ? -1 : b.lockedScore) - (a.lockedScore === null ? -1 : a.lockedScore) || b.holdings - a.holdings
      : b.holdings - a.holdings);
    owners.forEach((o, i) => { o.globalRank = i + 1; });
    player.rankingMode = mode;
    player.rankingMatched = matched;
    player.lockedLeaderboardCount = mode === 'locked' ? response.totalCount : null;
    player.lockedTotalScore = mode === 'locked' ? entries.reduce((sum, e) => sum + e.lockedScore, 0) : null;
    player.numberContext = {
      mode, matched, returned: mode === 'locked' ? entries.length : 0,
      source: player._source || 'Source not recorded',
      updatedAt: player.generatedAt || player.updatedAt || null,
      partial: player.partial === true,
      owners: owners.length
    };
    return player.numberContext;
  }
  function render(player) {
    const host = typeof document !== 'undefined' && document.getElementById('number-context');
    if (!host) return;
    const c = player.numberContext;
    host.hidden = false;
    while (host.firstChild) host.removeChild(host.firstChild);
    const summary = document.createElement('summary');
    summary.textContent = c.mode === 'locked' ? 'About these numbers · Locked score' : 'About these numbers · Ownership view';
    host.appendChild(summary);
    const fields = [
      ['Ranking', c.mode === 'locked' ? 'Loaded holders ordered by available locked score. Numbers are positions in this loaded subset, not official leaderboard ranks.' : 'Locked-score ranking unavailable. Loaded holders are ordered by Moments owned; this is not the locked-score leaderboard.'],
      ['Scores', c.mode === 'locked' ? c.matched.toLocaleString() + ' holders matched in ' + c.returned.toLocaleString() + ' returned entries. A dash means unknown, not zero. The API is capped at 1,000 entries.' : 'Locked scores are unknown. No score total is inferred from ownership.'],
      ['Collection source', c.source],
      ['Snapshot updated', c.updatedAt ? String(c.updatedAt) : 'Not provided by this dataset. Loading it now does not make it a live snapshot.'],
      ['Coverage', c.partial ? 'Dataset marks itself partial. Observed edition matches are not proof of missing ownership.' : 'Dataset is not marked partial. This is a source declaration, not an independent completeness guarantee.'],
      ['Filtering', 'Known system addresses and the existing large unnamed-wallet heuristic are excluded. The graph shows a subset of loaded holders.']
    ];
    const list = document.createElement('dl');
    fields.forEach(([label, value]) => {
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      list.appendChild(dt); list.appendChild(dd);
    });
    host.appendChild(list);
  }
  const api = { score, applyRanking, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NumberContext = api;
})(typeof window !== 'undefined' ? window : globalThis);
