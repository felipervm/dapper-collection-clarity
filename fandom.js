// Fandom Graph — 3D pride engine for NBA Top Shot collectors.
//
// WHAT THIS FILE IS
//   The client-side visualization that turns per-player Top Shot ownership data into a
//   navigable 3D universe. A collector lands on a player picker, clicks one, and their
//   "fandom universe" materializes: the player at the center, an edition ring around them,
//   and collector nodes arranged in concentric tiered rings out to the edges.
//
// ARCHITECTURE
//   Picker → Player Universe Graph
//     Player center node (the sun)
//       → Edition ring (moment sets, sized by market value, tier-colored)
//         → Collector nodes (owners, tiered gold/teal/silver/grey by holdings rank)
//
//   Drill-down levels:
//     L2 Player (default)    — player center + editions + all collectors
//     L3 Edition              — one edition center + its top holders + serial beads
//     L4 Collector-Universe   — spotlight mode: one collector center + players they
//                                collect + their top moments (entered via drawer CTA)
//
// DATA CONTRACT
//   Consumes /data/{playerId}.json via window.DataLayer (data-layer.js, SPEC-002 shape).
//   Each payload: { name, team, teamSlug, teamColors, totalMintedMomentCount,
//                   editions[], owners[] } with editions[].serialsSampled[] linking
//   serials to ownerFlowAddress. The DataLayer handles fetch + cache + progress events.
//
// RENDERING PIPELINE
//   3d-force-graph (ForceGraph3D) drives the scene graph + layout engine.
//   Three.js sprites (makeAvatarSprite, makeMomentCard, makeTextSprite) render nodes as
//   canvas-textured billboards — avatar circles, moment cards, and labels.
//   UnrealBloomPass + film-grain/chromatic-aberration ShaderPass chain on the post-
//   processing composer for the cinematic glow + filmic finish.
//   Backdrop rings, a 3500-star spherical shell, and depth fog frame the data.
//
// URL ROUTER
//   window.fandomRouter (router.js) drives deep links:
//     ?player=<name>              → L2 Player view
//     ?player=<name>&spotlight=<addr>  → L2 + collector spotlight overlay
//     ?collector=<addr>           → L4 Collector-Universe
//     ?player=<name>&edition=<key>     → L3 Edition view
//   ESC / back-button pops one level. The picker is the lander — no URL param = picker.
//
// BOOT SEQUENCE
//   1. Render picker from bundled DataLayer.PLAYERS (fast first paint)
//   2. Async-merge /data/index.json (full top-40 roster with mint counts)
//   3. On click or deep-link: loadAndRoutePlayer → DataLayer.loadPlayer → buildGraph →
//      showGraphFor → ensureGraph (lazy ForceGraph3D instance) → cinematic camera intro
(async function () {
  // Enrich picker counts from index.json in background (non-blocking)
  if (window.DataLayer?.initIndex) DataLayer.initIndex().catch(() => {});
  // data.players is empty at boot; populated per-player on demand.
  let data = { players: [] };

  function esc(v) {
    if (v == null) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ======================= Helpers =======================
  function mediaUrl(flowId, type = 'hero', opts = {}) {
    const params = new URLSearchParams();
    if (opts.width) params.set('width', opts.width);
    if (opts.format) params.set('format', opts.format);
    if (opts.quality) params.set('quality', opts.quality);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return `https://assets.nbatopshot.com/media/${flowId}/${type}${qs}`;
  }
  function tierColor(tier) {
    if (!tier) return '#9ea0aa';
    return tier.includes('ULTIMATE') ? '#ff2d80'
      : tier.includes('LEGENDARY') ? '#ff4a78'
      : tier.includes('ANTHOLOGY') ? '#f5b840'
      : tier.includes('RARE') ? '#5b9fff'
      : tier.includes('FANDOM') ? '#14d8c4'
      : '#9ea0aa';
  }
  function tierLabel(tier) {
    if (!tier) return 'Unknown';
    return tier.replace('MOMENT_TIER_', '').toLowerCase()
      .replace(/^./, c => c.toUpperCase());
  }
  function tierKey(tier) {
    if (!tier) return 'common';
    return tier.replace('MOMENT_TIER_', '').toLowerCase();
  }
  function tierWeight(tier) {
    if (!tier) return 3;
    return tier.includes('ULTIMATE') ? 15
      : tier.includes('LEGENDARY') ? 10
      : tier.includes('ANTHOLOGY') ? 8
      : tier.includes('RARE') ? 6
      : tier.includes('FANDOM') ? 4
      : 3;
  }
  // Market-value proxy per serial, USD. Placeholder estimates until BigQuery data lands.
  function tierUnitValue(tier) {
    if (!tier) return 8;
    return tier.includes('ULTIMATE') ? 8000
      : tier.includes('LEGENDARY') ? 1800
      : tier.includes('ANTHOLOGY') ? 700
      : tier.includes('RARE') ? 200
      : tier.includes('FANDOM') ? 40
      : 8;
  }
  function editionMarketValue(e) {
    return tierUnitValue(e.tier) * (e.edition?.circulationCount || e.serialsSampled?.length || 1);
  }
  function fmtUSDShort(v) {
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
  }
  function fmtLockedScore(score) {
    if (score == null || !Number.isFinite(score)) return '—';
    if (score <= 0) return '0';
    // Top Shot Score is in points (not cents, not currency).
    // The atlas API returns the raw points value. Display as-is with K/M suffixes.
    if (score >= 1e6) return (score / 1e6).toFixed(2) + 'M';
    if (score >= 1e3) return (score / 1e3).toFixed(1) + 'K';
    return Math.round(score).toLocaleString();
  }
  function shortAddr(a) { if (!a) return '—'; return a.length > 10 ? a.slice(0, 6) + '…' + a.slice(-4) : a; }
  function initials(name) { return (name || '').split(' ').map(p => p[0] || '').slice(0, 2).join('').toUpperCase(); }
  function ownerLabel(o) { return o.username || shortAddr(o.flowAddress); }
  function ownerKey(o) { return o.flowAddress || o.dapperID || o.username; }

  // Percentile for a given rank in a collection
  function percentileRank(rank, total) {
    if (!total) return 0;
    // Top 1 is top 1/total — so higher rank means LOWER percentile
    return Math.max(0.01, (rank - 1) / total * 100);
  }
  function topPercentLabel(rank, total) {
    const p = percentileRank(rank, total);
    if (p < 0.1) return 'Top 0.1%';
    if (p < 1) return `Top ${p.toFixed(2)}%`;
    if (p < 5) return `Top ${p.toFixed(1)}%`;
    return `Top ${Math.ceil(p)}%`;
  }

  // ======================= Cross-player index =======================
  // Only ever holds 1 player's data at a time (data.players.length <= 1),
  // but we keep the same index shape so downstream code (crossPlayerCount,
  // ownerMasterData reads) doesn't change.
  let ownerPlayerMap = new Map(); // key -> Set<playerName>
  let ownerMasterData = new Map(); // key -> {owner object, totalHoldings across all players}
  function rebuildOwnerIndexes() {
    ownerPlayerMap = new Map();
    ownerMasterData = new Map();
    for (const p of data.players) {
      for (const o of p.owners) {
        const k = ownerKey(o);
        if (!ownerPlayerMap.has(k)) ownerPlayerMap.set(k, new Set());
        ownerPlayerMap.get(k).add(p.name);
        const master = ownerMasterData.get(k) || { ...o, totalAcrossPlayers: 0, playersSet: new Set() };
        master.totalAcrossPlayers += o.holdings;
        master.playersSet.add(p.name);
        if (o.profileImageUrl && !master.profileImageUrl) master.profileImageUrl = o.profileImageUrl;
        if (o.username && !master.username) master.username = o.username;
        ownerMasterData.set(k, master);
      }
    }
  }
  function crossPlayerCount(owner) {
    return ownerPlayerMap.get(ownerKey(owner))?.size || 1;
  }

  // ======================= Picker (searchable autocomplete, spec-004) =======================
  // The picker reads the 100-player roster from window.DataLayer.PLAYERS after
  // initIndex() resolves. Search + team chips + keyboard nav replace the flat grid.
  let PLAYERS_META = (window.DataLayer && window.DataLayer.PLAYERS) ? window.DataLayer.PLAYERS.slice() : [];
  const searchInput = document.getElementById('player-search-input');
  const resultsEl = document.getElementById('player-results');
  const teamChipsEl = document.getElementById('team-chips');
  const pickerErrorEl = document.getElementById('picker-error');
  const pickerCountEl = document.getElementById('picker-count');
  let allPlayers = [];      // full 100-player list from index.json
  let filteredPlayers = []; // current filtered view
  let activeTeams = new Set(); // active team filter chips (union)
  let highlightIdx = -1;    // keyboard nav index
  let selectionTime = 0;    // for Plausible picker_to_graph timing

  // Debounce helper
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // Short form: "Los Angeles Lakers" → "Lakers"
  function shortTeam(team) {
    return (team || '').replace('Los Angeles ', '').replace('Golden State ', '')
      .replace('Oklahoma City ', '').replace('San Antonio ', '')
      .replace('Minnesota ', '').replace('New Orleans ', '')
      .replace('Memphis ', '').replace('Philadelphia ', '');
  }

  // Render team filter chips (one per unique team, plus "All").
  function renderTeamChips() {
    const teams = [...new Set(allPlayers.map(p => p.team))].sort();
    teamChipsEl.innerHTML = '';
    // "All" chip — clears every team filter.
    const allChip = document.createElement('button');
    allChip.type = 'button';
    allChip.className = 'team-chip active';
    allChip.textContent = 'All';
    allChip.dataset.team = '';
    allChip.setAttribute('aria-pressed', 'true');
    allChip.addEventListener('click', () => {
      activeTeams.clear();
      updateChipStates();
      filterAndRender();
    });
    teamChipsEl.appendChild(allChip);
    for (const team of teams) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'team-chip';
      const colors = (allPlayers.find(p => p.team === team) || {}).teamColors || ['#777', '#333'];
      chip.innerHTML = `<span class="chip-dot" style="background:${colors[0]}"></span>${shortTeam(team)}`;
      chip.dataset.team = team;
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => {
        if (activeTeams.has(team)) activeTeams.delete(team);
        else activeTeams.add(team);
        updateChipStates();
        filterAndRender();
      });
      teamChipsEl.appendChild(chip);
    }
  }

  function updateChipStates() {
    teamChipsEl.querySelectorAll('.team-chip').forEach(c => {
      const isActive = c.dataset.team === '' ? activeTeams.size === 0 : activeTeams.has(c.dataset.team);
      c.classList.toggle('active', isActive);
      c.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  // Filter players by search query + active team filters (union).
  function filterPlayers(query) {
    const q = (query || '').trim().toLowerCase();
    let results = allPlayers;
    if (activeTeams.size > 0) {
      results = results.filter(p => activeTeams.has(p.team));
    }
    if (q) {
      results = results.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.team.toLowerCase().includes(q));
    }
    // Sort by minted-moment count descending (empty query → popular first).
    results = [...results].sort((a, b) => (b.totalMintedMomentCount || 0) - (a.totalMintedMomentCount || 0));
    return results;
  }

  // Highlight matched substring (case-insensitive). Escapes nothing — index.json
  // names/teams are trusted catalog strings, not user input.
  function highlightMatch(text, query) {
    if (!query) return text;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text;
    return text.slice(0, idx) + '<strong class="match">' + text.slice(idx, idx + query.length) + '</strong>' + text.slice(idx + query.length);
  }

  function fmtCount(n) {
    n = n || 0;
    return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  }

  // Render results listbox.
  function renderResults(players, query) {
    resultsEl.innerHTML = '';
    if (players.length === 0) {
      resultsEl.innerHTML = '<div class="no-results" role="status" aria-live="polite">No players found</div>';
      searchInput.setAttribute('aria-expanded', 'false');
      searchInput.removeAttribute('aria-activedescendant');
      highlightIdx = -1;
      return;
    }
    searchInput.setAttribute('aria-expanded', 'true');
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const opt = document.createElement('div');
      opt.className = 'player-result';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', 'false');
      opt.id = 'player-result-' + i;
      const colors = p.teamColors || ['#777', '#333'];
      const teamShort = shortTeam(p.team);
      const teamQ = query && teamShort.toLowerCase().includes(query.toLowerCase()) ? query : '';
      opt.innerHTML =
        `<span class="result-accent" style="background:linear-gradient(135deg,${colors[0]},${colors[1]})"></span>` +
        `<span class="result-name">${highlightMatch(p.name, query)}</span>` +
        `<span class="result-team">${highlightMatch(teamShort, teamQ)}</span>` +
        `<span class="result-count">${fmtCount(p.totalMintedMomentCount)} Moments</span>`;
      opt.addEventListener('click', () => selectPlayer(p));
      opt.addEventListener('mouseenter', () => { highlightIdx = i; updateHighlight(); });
      resultsEl.appendChild(opt);
    }
    highlightIdx = -1;
    searchInput.removeAttribute('aria-activedescendant');
  }

  function updateHighlight() {
    const opts = resultsEl.querySelectorAll('.player-result');
    opts.forEach((opt, i) => {
      const selected = i === highlightIdx;
      opt.classList.toggle('highlighted', selected);
      opt.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) {
        opt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        searchInput.setAttribute('aria-activedescendant', opt.id);
      }
    });
  }

  function selectPlayer(p) {
    selectionTime = performance.now();
    searchInput.value = '';
    resultsEl.innerHTML = '';
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
    highlightIdx = -1;
    loadAndRoutePlayer(p.playerId || p.player_id || p.name);
  }

  // Debounced filter+render (150ms).
  const filterAndRender = debounce(() => {
    filteredPlayers = filterPlayers(searchInput.value);
    renderResults(filteredPlayers, searchInput.value.trim());
    if (pickerCountEl) {
      pickerCountEl.textContent = allPlayers.length + ' players · ' + filteredPlayers.length + ' shown';
    }
  }, 150);

  if (searchInput) {
    searchInput.addEventListener('input', filterAndRender);
    searchInput.addEventListener('focus', () => {
      if (allPlayers.length > 0) {
        filteredPlayers = filterPlayers(searchInput.value);
        renderResults(filteredPlayers, searchInput.value.trim());
      }
    });
    // Keyboard navigation (WAI-ARIA combobox pattern).
    searchInput.addEventListener('keydown', (e) => {
      const opts = resultsEl.querySelectorAll('.player-result');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (opts.length === 0) return;
        highlightIdx = Math.min(highlightIdx + 1, opts.length - 1);
        updateHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (opts.length === 0) return;
        highlightIdx = Math.max(highlightIdx - 1, 0);
        updateHighlight();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIdx >= 0 && filteredPlayers[highlightIdx]) {
          selectPlayer(filteredPlayers[highlightIdx]);
        } else if (filteredPlayers.length > 0) {
          selectPlayer(filteredPlayers[0]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        searchInput.value = '';
        filteredPlayers = filterPlayers('');
        renderResults(filteredPlayers, '');
        if (pickerCountEl) pickerCountEl.textContent = allPlayers.length + ' players';
        searchInput.focus();
      }
    });
  }

  // '/' focuses the search bar (preserves existing shortcut).
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      if (searchInput) searchInput.focus();
    }
  });

  // Initialize the picker from index.json via DataLayer.initIndex().
  async function initPicker() {
    try {
      if (!window.DataLayer || typeof window.DataLayer.initIndex !== 'function') {
        throw new Error('DataLayer.initIndex unavailable');
      }
      await window.DataLayer.initIndex();
      allPlayers = window.DataLayer.PLAYERS || [];
      if (!Array.isArray(allPlayers) || allPlayers.length === 0) {
        throw new Error('No players in index');
      }
      // Keep PLAYERS_META in sync so loadAndRoutePlayer() can resolve by id/name.
      PLAYERS_META = allPlayers.slice();
      if (pickerErrorEl) pickerErrorEl.style.display = 'none';
      renderTeamChips();
      filteredPlayers = filterPlayers('');
      renderResults(filteredPlayers, '');
      if (pickerCountEl) pickerCountEl.textContent = allPlayers.length + ' players';
    } catch (err) {
      console.error('[picker] Failed to load index:', err);
      if (pickerErrorEl) {
        pickerErrorEl.style.display = 'flex';
        const retryBtn = document.getElementById('picker-retry');
        if (retryBtn) {
          retryBtn.onclick = () => { pickerErrorEl.style.display = 'none'; initPicker(); };
        }
      }
      if (typeof window.plausible === 'function') {
        window.plausible('data_fetch_error', { props: { player_id: 'index', error_type: 'load_failed' } });
      }
    }
  }
  initPicker();

  // ======================= Per-player loading UI =======================
  const loadingEl = document.getElementById('player-loading');
  const loadingMsg = document.getElementById('player-loading-msg');
  const loadingSub = document.getElementById('player-loading-sub');
  const loadingRetry = document.getElementById('player-loading-retry');

  let _loadingMsgTimer = null;
  let _loadingMsgIdx = 0;
  const LOADING_MESSAGES = [
    "Loading {name}'s universe…",
    'Warping through the Flow Network…',
    'Asking the blockchain nicely…',
    'Untangling {editions} editions…',
    'Finding the real fans (not the exchange wallets)…',
    'Calculating locked scores…',
    'Did you know {name} has {moments} Moments?',
    'Rendering collector nodes in 3D space…',
    'Almost there… the graph is forming…',
    'Connecting the dots (literally)…'
  ];
  function _setLoadingProgress(pct) {
    const fill = document.getElementById('loading-progress-fill');
    if (fill) fill.style.width = pct + '%';
  }
  function showPlayerLoading(name) {
    if (!loadingEl) return;
    loadingEl.classList.remove('error');
    loadingEl.style.display = 'flex';
    loadingRetry.style.display = 'none';
    // Player initials glow in the background
    const initialsEl = document.getElementById('loading-initials');
    if (initialsEl && name) {
      initialsEl.textContent = name.split(' ').map(p => p[0] || '').slice(0, 2).join('').toUpperCase();
    }
    // Start message rotation with crossfade every 1.8s
    _loadingMsgIdx = 0;
    loadingMsg.textContent = `Loading ${name}'s universe…`;
    loadingSub.textContent = '';
    if (_loadingMsgTimer) { clearInterval(_loadingMsgTimer); _loadingMsgTimer = null; }
    _loadingMsgTimer = setInterval(() => {
      _loadingMsgIdx++;
      const template = LOADING_MESSAGES[_loadingMsgIdx % LOADING_MESSAGES.length];
      const msg = template
        .replace('{name}', name || 'player')
        .replace('{editions}', '92')
        .replace('{moments}', '300K+')
        .replace('{collectors}', '9,000+');
      loadingMsg.textContent = msg;
      // Re-trigger crossfade animation
      loadingMsg.style.animation = 'none';
      void loadingMsg.offsetHeight;
      loadingMsg.style.animation = 'msg-crossfade 0.5s ease';
    }, 1800);
    // Initialize progress bar
    _setLoadingProgress(5);
    const empty = document.getElementById('graph-empty');
    if (empty) empty.style.display = 'none';
  }
  function updatePlayerLoadingProgress(evt) {
    if (!loadingEl || loadingEl.style.display === 'none') return;
    if (evt.phase === 'fetching') {
      loadingSub.textContent = evt.cached ? 'cache hit' : `fetching…`;
    } else if (evt.phase === 'parsing') {
      loadingSub.textContent = `parsing ${evt.momentsSoFar.toLocaleString()} serials`;
    }
  }
  function hidePlayerLoading() {
    if (loadingEl) {
      _setLoadingProgress(100);
      if (_loadingMsgTimer) { clearInterval(_loadingMsgTimer); _loadingMsgTimer = null; }
      // Brief pause so the completed bar is visible before fade-out
      setTimeout(() => { loadingEl.style.display = 'none'; }, 300);
    }
  }
  function showPlayerError(name, err, onRetry) {
    if (!loadingEl) return;
    loadingEl.classList.add('error');
    if (_loadingMsgTimer) { clearInterval(_loadingMsgTimer); _loadingMsgTimer = null; }
    loadingEl.style.display = 'flex';
    const rate = err && err.name === 'RateLimitError';
    const notFound = err && err.name === 'NotFoundError';
    loadingMsg.textContent = rate ? 'Slow down — try again.' :
      notFound ? `Player not found.` :
      `Couldn't load ${name}.`;
    loadingSub.textContent = err && err.message ? err.message : '';
    loadingRetry.style.display = 'inline-flex';
    loadingRetry.onclick = () => { loadingRetry.onclick = null; onRetry(); };
  }

  if (window.DataLayer) {
    window.DataLayer.onProgress = updatePlayerLoadingProgress;
  }

  // Guarded load: shows loading UI, awaits data-layer, mounts into `data`,
  // rebuilds indexes, then invokes the existing router.go('player', ...) path.
  let _pendingLoadToken = 0;
  async function loadAndRoutePlayer(idOrName, spotlight) {
    if (!window.DataLayer) {
      console.error('[fandom] window.DataLayer missing — data-layer.js did not load');
      return;
    }
    const key = String(idOrName ?? '').trim();
    let meta = PLAYERS_META.find(p => p.playerId === key)
            || PLAYERS_META.find(p => p.name === key);
    // Fallback: numeric id we don't have in the local roster yet — try direct fetch
    if (!meta && /^\d+$/.test(key)) {
      try {
        const payload = await window.DataLayer.loadPlayer(key);
        meta = {
          playerId: key,
          name: payload.name || key,
          team: payload.team || '',
          teamSlug: payload.teamSlug || null,
          teamColors: payload.teamColors || ['#666', '#222']
        };
        // Cache the just-fetched meta so future clicks hit the fast path
        const exists = PLAYERS_META.some(p => p.playerId === key);
        if (!exists) PLAYERS_META.push(meta);
      } catch (e) { /* fall through to warn */ }
    }
    if (!meta) {
      console.warn('[fandom] unknown player id/name in picker:', idOrName);
      return;
    }
    const playerName = meta.name;
    const token = ++_pendingLoadToken;
    showPlayerLoading(playerName);
    // Show the graph-area immediately so the loading overlay is visible.
    // Previously this was set after data loaded — meaning the loading spinner
    // was inside a display:none container and the user saw nothing.
    document.body.classList.add('viewing-player');
    document.querySelector('.player-picker').style.display = 'none';
    try {
      loadingSub.textContent = 'fetching moments…';
      _setLoadingProgress(15);
      const payload = await window.DataLayer.loadPlayer(meta.playerId);
      if (token !== _pendingLoadToken) return; // superseded by a later click
      loadingSub.textContent = `loaded ${payload.owners?.length?.toLocaleString() || ''} collectors`;
      _setLoadingProgress(40);
      // Strip pack/minter/system wallets at the boundary so nothing downstream sees them.
      const SYSTEM_ADDRS = new Set(['b6f2481eba4df97b', '0xb6f2481eba4df97b']);
      const isSystem = (o) => {
        if (!o || !o.flowAddress) return false;
        if (SYSTEM_ADDRS.has(String(o.flowAddress).toLowerCase())) return true;
        const noUsername = !o.username || o.username === '?' || o.username === '';
        return noUsername && (o.holdings || 0) > 1500;
      };
      if (Array.isArray(payload.owners)) {
        const before = payload.owners.length;
        payload.owners = payload.owners.filter(o => !isSystem(o));
        const removed = before - payload.owners.length;
        if (removed) console.log(`[fandom] filtered ${removed} system account(s) from ${payload.name}`);
      }
      if (Array.isArray(payload.editions)) {
        for (const ed of payload.editions) {
          if (Array.isArray(ed.serialsSampled)) {
            ed.serialsSampled = ed.serialsSampled.filter(s => !SYSTEM_ADDRS.has(String(s.ownerFlowAddress || '').toLowerCase()));
          }
        }
      }
      data.players = [payload];
      loadingSub.textContent = 'fetching locked scores…';
      _setLoadingProgress(60);
      try {
        const lockedData = await window.DataLayer.loadLockedLeaderboard(meta.playerId);
        window.NumberContext.applyRanking(payload, lockedData);
      } catch (e) {
        console.warn('[fandom] locked leaderboard fetch failed, falling back to ownership ranking:', e);
        window.NumberContext.applyRanking(payload, null);
      }
      window.NumberContext.render(payload);
      loadingSub.textContent = 'building graph…';
      _setLoadingProgress(90);
      rebuildOwnerIndexes();
      hidePlayerLoading();
      // body.viewing-player already set at the start of loadAndRoutePlayer
      // New player — clear stale spotlight + drawer state from the previous player.
      if (window.__clearCollectorSpotlight) window.__clearCollectorSpotlight();
      const _drawer = document.getElementById('drawer');
      if (_drawer) _drawer.classList.remove('open');
      window.fandomRouter.go('player', { player: playerName, spotlight: spotlight || null });
    } catch (err) {
      if (token !== _pendingLoadToken) return;
      console.error('[fandom] loadPlayer failed:', err);
      showPlayerError(playerName, err, () => loadAndRoutePlayer(playerName, spotlight));
    }
  }
  // Expose for router-driven initial load + any external trigger
  window.__fandom = { loadAndRoutePlayer };

  // ======================= Three.js sprite helpers =======================
  const THREE = window.THREE;
  const imgCache = new Map();

  // Load an HTMLImageElement directly (bypasses Three.js TextureLoader quirks)
  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    if (imgCache.has(url)) return imgCache.get(url);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imgCache.set(url, p);
    return p;
  }

  // Draw a radial-gradient glow texture (kills the square-halo artifact)
  let _glowTex = null;
  function glowTexture() {
    if (_glowTex) return _glowTex;
    const S = 256;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);
    _glowTex = new THREE.CanvasTexture(canvas);
    _glowTex.needsUpdate = true;
    return _glowTex;
  }
  function glowSprite(color, size, opacity = 0.35) {
    const mat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(size, size, 1);
    return sp;
  }

  // Build a sprite with rendered text on a canvas (for always-visible labels)
  function makeTextSprite(text, opts = {}) {
    const {
      fontSize = 44,
      fontFamily = "'Sofia Sans Extra Condensed', system-ui, sans-serif",
      fontWeight = 800,
      color = '#ffffff',
      bg = 'rgba(0,0,0,0.9)',
      borderColor = 'rgba(255,255,255,0.3)',
      paddingX = 14,
      paddingY = 6,
      scale = 14
    } = opts;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    const metrics = ctx.measureText(text);
    const w = Math.ceil(metrics.width) + paddingX * 2;
    const h = fontSize + paddingY * 2;
    const DPR = 2;
    canvas.width = w * DPR;
    canvas.height = h * DPR;
    ctx.scale(DPR, DPR);
    ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
    // Rounded rect background
    const r = 6;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.fill();
    if (borderColor) {
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, paddingX, h / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(w / scale, h / scale, 1);
    return sprite;
  }

  // Build a circular avatar sprite — directly loads image, composites to canvas, creates CanvasTexture
  async function makeAvatarSprite(url, size = 18, ringColor = '#f5b840', fallbackText = '') {
    const img = url ? await loadImage(url) : null;
    const S = 256;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, S, S);

    // Outer ring
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = ringColor;
    ctx.fill();

    // Inner clip + fill
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2);
    ctx.clip();
    if (img && img.width > 0) {
      const iw = img.width, ih = img.height;
      const scale = Math.max((S - 20) / iw, (S - 20) / ih);
      const dw = iw * scale, dh = ih * scale;
      ctx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
    } else {
      const grad = ctx.createLinearGradient(0, 0, S, S);
      grad.addColorStop(0, '#2a2a3a'); grad.addColorStop(1, '#0b0b10');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, S, S);
      if (fallbackText) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 110px "Sofia Sans Extra Condensed", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fallbackText, S / 2, S / 2);
      }
    }
    ctx.restore();

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(size, size, 1);
    return sprite;
  }

  // Build a rounded-square "moment card" sprite with hero image textured on it
  async function makeMomentCard(url, size = 28, tierColor = '#ff4a78', setName = '') {
    const img = url ? await loadImage(url) : null;
    const W = 300, H = 300;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Rounded rect mask
    const r = 24;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r);
    ctx.lineTo(W, H - r); ctx.quadraticCurveTo(W, H, W - r, H);
    ctx.lineTo(r, H); ctx.quadraticCurveTo(0, H, 0, H - r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    // Hero image
    if (img && img.width > 0) {
      const iw = img.width, ih = img.height;
      const scale = Math.max(W / iw, H / ih);
      const dw = iw * scale, dh = ih * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#1a1a2e');
      grad.addColorStop(1, '#0b0b10');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
    // Gradient overlay at bottom for label readability
    const overlay = ctx.createLinearGradient(0, H * 0.5, 0, H);
    overlay.addColorStop(0, 'rgba(0,0,0,0)');
    overlay.addColorStop(1, 'rgba(0,0,0,0.82)');
    ctx.fillStyle = overlay;
    ctx.fillRect(0, H * 0.5, W, H * 0.5);
    ctx.restore();

    // Border
    ctx.beginPath();
    ctx.moveTo(r, 1.5); ctx.lineTo(W - r, 1.5); ctx.quadraticCurveTo(W - 1.5, 1.5, W - 1.5, r);
    ctx.lineTo(W - 1.5, H - r); ctx.quadraticCurveTo(W - 1.5, H - 1.5, W - r, H - 1.5);
    ctx.lineTo(r, H - 1.5); ctx.quadraticCurveTo(1.5, H - 1.5, 1.5, H - r);
    ctx.lineTo(1.5, r); ctx.quadraticCurveTo(1.5, 1.5, r, 1.5);
    ctx.lineWidth = 3;
    ctx.strokeStyle = tierColor;
    ctx.stroke();

    // Set name label at bottom
    if (setName) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 26px "Sofia Sans Extra Condensed", system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      const maxWidth = W - 32;
      let text = setName.toUpperCase();
      if (ctx.measureText(text).width > maxWidth) {
        while (ctx.measureText(text + '…').width > maxWidth && text.length > 3) {
          text = text.slice(0, -1);
        }
        text += '…';
      }
      ctx.fillText(text, 16, H - 14);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(size, size, 1);
    return sprite;
  }

  // ======================= Build graph for a player =======================
  function buildGraph(playerName) {
    const p = data.players.find(x => x.name === playerName);
    if (!p) return null;

    const nodes = [];
    const links = [];

    // Player center
    nodes.push({
      id: 'player:' + p.name,
      type: 'player',
      name: p.name,
      team: p.team,
      teamColors: p.teamColors,
      val: 34,
      color: p.teamColors[1] || '#ffd96b',
      fx: 0, fy: 0, fz: 0
    });

    // Edition nodes — pinned on a deterministic inner ring, sized by market value
    const editionNodes = new Map();
    const editionCount = p.editions.length;
    const EDITION_RADIUS = 105;

    // Compute edition market values for this player, normalize for node sizing
    const editionValues = p.editions.map(editionMarketValue);
    const maxEditionValue = Math.max(1, ...editionValues);

    p.editions.forEach((e, idx) => {
      const mediaFlowId = e.serialsSampled[0]?.flowId;
      const angle = (idx / Math.max(1, editionCount)) * Math.PI * 2;
      const tilt = (idx % 3 === 0) ? 0.35 : (idx % 3 === 1) ? -0.35 : 0;
      const marketValue = editionValues[idx];
      // Size range: 8 (smallest) to 38 (largest) — cube-root scale so visual area grows ~linearly with value
      const valScaled = 8 + Math.cbrt(marketValue / maxEditionValue) * 30;
      const momentNode = {
        id: 'moment:' + e.editionKey,
        type: 'moment',
        edition: e,
        name: e.set?.flowName || 'Moment',
        setName: e.set?.flowName || 'Moment',
        tier: e.tier,
        tierLabel: tierLabel(e.tier),
        circulation: e.edition?.circulationCount || 0,
        totalSampled: e.serialsSampled.length,
        mediaFlowId,
        heroUrl: mediaFlowId ? mediaUrl(mediaFlowId, 'hero', { width: 320, format: 'webp', quality: 85 }) : null,
        marketValue,
        val: valScaled,
        color: tierColor(e.tier),
        fx: Math.cos(angle) * EDITION_RADIUS,
        fy: Math.sin(angle * 2) * 14 + tilt * 18,
        fz: Math.sin(angle) * EDITION_RADIUS
      };
      editionNodes.set(e.editionKey, momentNode);
      nodes.push(momentNode);
      links.push({
        source: 'player:' + p.name,
        target: momentNode.id,
        kind: 'player-moment',
        value: tierWeight(e.tier) * 0.3
      });
    });

    // ---- Honest top-N rendering (spec-003 Task 6) ----
    // The graph no longer reconstructs owners from the first 100 sampled serials
    // of each edition (that was silent sampling — only owners who happened to
    // appear in serialsSampled[0..100] surfaced). Instead we consume the full
    // owners[] array, which SPEC-002 guarantees is ranked by holdings DESC and
    // capped at the top-1000. The top 200 become full interactive collector
    // nodes; 201-1000 are rendered as a faint THREE.Points hint annulus so the
    // user can see the universe continues beyond the rendered set.
    const FULL_NODE_LIMIT = 200;

    // Filter out pack/minter/system accounts first. These hold thousands of
    // moments before distribution and dwarf real collectors. Heuristic: known
    // denylist + outlier holdings (>1500 in a single player AND no username =
    // system wallet, not a fan). Filtering happens before the top-200 cap so a
    // system wallet can never steal a rendered slot.
    const SYSTEM_ADDRESSES = new Set([
      'b6f2481eba4df97b',  // Top Shot pack distribution wallet (verified across all 6 players)
      '0xb6f2481eba4df97b' // (with 0x prefix variant just in case)
    ]);
    function isSystemAccount(o) {
      if (!o || !o.flowAddress) return false;
      if (SYSTEM_ADDRESSES.has(o.flowAddress) || SYSTEM_ADDRESSES.has(String(o.flowAddress).toLowerCase())) return true;
      // Heuristic fallback: if no username and holds an absurd amount, likely system
      const noUsername = !o.username || o.username === '?' || o.username === '';
      if (noUsername && o.holdings > 1500) return true;
      return false;
    }

    // owners[] is already ranked by holdings DESC (SPEC-002 guarantee). Use that
    // order directly — no re-sort — so globalRank is the owner's true leaderboard
    // position in the full dataset, not a sampled approximation.
    const rankedOwners = p.owners.filter(o => !isSystemAccount(o));
    rankedOwners.forEach((o, i) => { o.__rank = i + 1; });

    // Estimated value held per collector. We no longer have a per-owner sampled
    // tier mix (sampling is gone), so valueHeld is the player-average unit value
    // times the owner's true holdings. This keeps node sizing honest to the real
    // holdings count; tier mix only affected the now-removed extrapolation.
    const playerTotalValue = editionValues.reduce((a, v) => a + v, 0);
    const playerTotalMinted = p.editions.reduce((a, e) => a + (e.edition?.circulationCount || 0), 0);
    const playerAvgUnit = playerTotalValue / Math.max(1, playerTotalMinted);

    // Cross-reference momentsOwned from serialsSampled where available — purely
    // for the leaderboard sparkline / detail drawer, NOT for owner discovery.
    const ownerMoments = new Map(); // flowAddress -> [{editionKey,serial,flowId,edition}]
    for (const e of p.editions) {
      for (const s of e.serialsSampled) {
        if (!s.ownerFlowAddress) continue;
        if (!ownerMoments.has(s.ownerFlowAddress)) ownerMoments.set(s.ownerFlowAddress, []);
        ownerMoments.get(s.ownerFlowAddress).push({ editionKey: e.editionKey, serial: s.serial, flowId: s.flowId, edition: e });
      }
    }

    // Build full collector nodes for the top FULL_NODE_LIMIT (or fewer if the
    // player has fewer owners). These get sprites, avatars, labels, click
    // handlers — the whole existing treatment via the downstream node decorators.
    const ownerArr = [];
    for (let i = 0; i < Math.min(FULL_NODE_LIMIT, rankedOwners.length); i++) {
      const owner = rankedOwners[i];
      const k = ownerKey(owner);
      if (!k) continue;
      const cross = crossPlayerCount(owner);
      const master = ownerMasterData.get(k) || owner;
      const momentsOwned = ownerMoments.get(owner.flowAddress) || [];
      // Collector-moment links only for the moments we actually saw them own in
      // the sample (cross-reference, not the source of truth for who exists).
      const node = {
        id: 'collector:' + k,
        type: 'collector',
        name: ownerLabel(owner),
        flowAddress: owner.flowAddress,
        username: owner.username,
        dapperID: owner.dapperID,
        profileImageUrl: owner.profileImageUrl || master.profileImageUrl,
        topshotScore: owner.topshotScore,
        crossPlayerFan: cross > 1,
        crossPlayerCount: cross,
        holdings: owner.holdings,         // true count from data, not sampled tally
        fullHoldings: owner.holdings,
        globalRank: owner.__rank,
        lockedScore: owner.lockedScore,
        lockedRank: owner.lockedRank || null,
        momentsOwned,
        valueHeld: owner.holdings * playerAvgUnit
      };
      ownerArr.push(node);
      for (const m of momentsOwned) {
        links.push({
          source: node.id, target: 'moment:' + m.editionKey,
          kind: 'collector-moment',
          serial: m.serial,
          value: 0.6
        });
      }
    }
    // ownerArr is already in holdings-DESC order (we walked rankedOwners in
    // order), and globalRank is already assigned — no sort or re-rank needed.

    // Inner circle: top 10 by full-dataset rank
    const INNER_N = Math.min(10, ownerArr.length);
    const INNER_RADIUS = 185;
    for (let i = 0; i < INNER_N; i++) {
      const o = ownerArr[i];
      const angle = (i / INNER_N) * Math.PI * 2;
      // Sphere-like distribution around the player at fixed radius
      const tilt = (i % 2 === 0) ? 0.25 : -0.25;
      o.fx = Math.cos(angle) * INNER_RADIUS;
      o.fy = Math.sin(angle * 2) * 25 + tilt * 30;
      o.fz = Math.sin(angle) * INNER_RADIUS;
      o.isInnerCircle = true;
      o.rankBadge = o.globalRank;
    }
    // Pre-bucket for deterministic ring layout. Layout is stable across reloads.
    const tealOwners = ownerArr.filter(o => o.globalRank > 10 && o.globalRank <= 50);
    const silverOwners = ownerArr.filter(o => o.globalRank > 50 && o.globalRank <= 200);
    const TEAL_RADIUS = 310;
    const SILVER_RADIUS = 430;
    const GREY_RADIUS_INNER = 510;
    const GREY_RADIUS_OUTER = 600;
    let tealIdx = 0, silverIdx = 0;

    // Max value for normalizing collector node sizes
    const maxValueHeld = Math.max(1, ...ownerArr.map(o => o.valueHeld || 0));

    // Tier tagging + deterministic ring pinning; size by market value held
    for (const o of ownerArr) {
      const rank = o.globalRank;
      const total = p.owners.length;
      o.tier = rank <= 10 ? 'gold' : rank <= 50 ? 'teal' : rank <= 200 ? 'silver' : 'grey';
      o.isTop10 = rank <= 10;
      o.pctLabel = topPercentLabel(rank, total) + ' of loaded holders';
      // Size is driven by market value held (cube root for visual-area-linear scaling)
      const valueRatio = Math.cbrt((o.valueHeld || 0) / maxValueHeld);
      const baseSize = rank <= 10 ? 6 + valueRatio * 10
        : rank <= 50 ? 3.5 + valueRatio * 4.5
        : o.crossPlayerFan ? 3.0 + valueRatio * 2 : 1.8 + valueRatio * 1.5;
      o.val = baseSize;
      o.color = o.tier === 'gold' ? '#f5b840'
        : o.tier === 'teal' ? '#14d8c4'
        : o.tier === 'silver' ? '#d4d4d9'
        : o.crossPlayerFan ? '#ff9a4a'
        : 'rgba(240,242,253,0.42)';

      // Pin by tier ring (gold already pinned above in inner-circle loop)
      if (o.tier === 'teal') {
        const i = tealIdx++;
        const angle = (i / Math.max(1, tealOwners.length)) * Math.PI * 2 + 0.13;
        const tilt = (i % 2 === 0) ? 0.3 : -0.3;
        o.fx = Math.cos(angle) * TEAL_RADIUS;
        o.fy = Math.sin(angle * 2) * 22 + tilt * 24;
        o.fz = Math.sin(angle) * TEAL_RADIUS;
      } else if (o.tier === 'silver') {
        const i = silverIdx++;
        const angle = (i / Math.max(1, silverOwners.length)) * Math.PI * 2 + 0.27;
        const tilt = (i % 2 === 0) ? 0.2 : -0.2;
        o.fx = Math.cos(angle) * SILVER_RADIUS;
        o.fy = Math.sin(angle * 3) * 18 + tilt * 22;
        o.fz = Math.sin(angle) * SILVER_RADIUS;
      } else if (o.tier === 'grey') {
        // Faint far-ring — deterministic by rank so reload-stable
        const seed = (rank * 9301 + 49297) % 233280;
        const r01 = seed / 233280;
        const angle = r01 * Math.PI * 2;
        const r = GREY_RADIUS_INNER + ((rank * 37) % 100) / 100 * (GREY_RADIUS_OUTER - GREY_RADIUS_INNER);
        o.fx = Math.cos(angle) * r;
        o.fy = (((rank * 13) % 40) - 20);
        o.fz = Math.sin(angle) * r;
        o.val = Math.max(0.8, o.val * 0.55);
      }
      nodes.push(o);
    }

    // ---- Hint annulus for owners 201-1000 (spec-003 Task 6) ----
    // Owners ranked beyond FULL_NODE_LIMIT are not rendered as interactive
    // nodes (that would overwhelm the scene), but we don't hide them silently:
    // a faint THREE.Points annulus just outside the grey ring makes the rest of
    // the collector universe visible as a glow. This is the honest rendering —
    // the user can SEE that the graph continues beyond the top-200.
    const hintOwners = rankedOwners.slice(FULL_NODE_LIMIT, Math.min(1000, rankedOwners.length));
    let hintPoints = null;
    if (hintOwners.length > 0) {
      const hintGeom = new THREE.BufferGeometry();
      const hintPos = new Float32Array(hintOwners.length * 3);
      const hintCol = new Float32Array(hintOwners.length * 3);
      // Annulus just outside the grey ring (GREY_RADIUS_OUTER=600 → 610-700)
      const HINT_RADIUS_INNER = 610;
      const HINT_RADIUS_OUTER = 700;
      for (let i = 0; i < hintOwners.length; i++) {
        const rank = FULL_NODE_LIMIT + 1 + i;
        // Deterministic placement (mirrors the grey-ring seeding) so reloads are stable
        const seed = (rank * 9301 + 49297) % 233280;
        const r01 = seed / 233280;
        const angle = r01 * Math.PI * 2;
        const r = HINT_RADIUS_INNER + ((rank * 37) % 100) / 100 * (HINT_RADIUS_OUTER - HINT_RADIUS_INNER);
        hintPos[i * 3]     = Math.cos(angle) * r;
        hintPos[i * 3 + 1] = (((rank * 13) % 40) - 20);
        hintPos[i * 3 + 2] = Math.sin(angle) * r;
        // Gold (#f5b840) with per-point intensity variation for a natural glow
        const intensity = 0.7 + ((rank * 17) % 30) / 100;
        hintCol[i * 3]     = 0.96 * intensity;
        hintCol[i * 3 + 1] = 0.72 * intensity;
        hintCol[i * 3 + 2] = 0.25 * intensity;
      }
      hintGeom.setAttribute('position', new THREE.BufferAttribute(hintPos, 3));
      hintGeom.setAttribute('color', new THREE.BufferAttribute(hintCol, 3));
      const hintMat = new THREE.PointsMaterial({
        size: 2.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true
      });
      hintPoints = new THREE.Points(hintGeom, hintMat);
    }

    // ---- Coverage disclosure (spec-003 Task 6) ----
    // S = fully-simulated collector nodes; M = total owners in the dataset.
    // These drive the "Showing top S of M collectors" affordance and the
    // window.__fandomCoverage hook for the smoke test.
    const coverageS = ownerArr.length;
    const coverageM = p.owners.length;
    const lockedTotalScore = p.lockedTotalScore;

    return {
      player: p,
      nodes, links,
      editionNodes,
      ownerArr,
      hintPoints,
      coverage: { S: coverageS, M: coverageM, locked: p.rankingMode === 'locked' },
      stats: {
        editions: p.editions.length,
        totalMinted: p.totalMintedMomentCount,
        collectors: coverageM,
        whales: Math.min(10, ownerArr.length),
        totalOwnerCount: p.owners.length,
        lockedTotalScore,
        topCollector: ownerArr[0]
      }
    };
  }

  // ======================= Graph instance =======================
  const container = document.getElementById('graph');
  let Graph = null;
  let autoRotate = false;
  let currentPlayer = null;
  let currentData = null;
  let backdropMeshes = []; // concentric rings

  let starfieldMesh = null;
  let fogApplied = false;
  let hintAnnulusMesh = null; // THREE.Points annulus for owners 201-1000 (honest top-N rendering)

  function addBackdropRings(scene) {
    for (const m of backdropMeshes) scene.remove(m);
    backdropMeshes = [];
    // Inner circle marker (radius 130)
    const innerGeo = new THREE.RingGeometry(128, 134, 128);
    const innerMat = new THREE.MeshBasicMaterial({ color: 0xf5b840, transparent: true, opacity: 0.18, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const inner = new THREE.Mesh(innerGeo, innerMat);
    inner.rotation.x = Math.PI / 2;
    scene.add(inner);
    backdropMeshes.push(inner);
    // Outer ring (radius 260)
    const outerGeo = new THREE.RingGeometry(258, 262, 128);
    const outerMat = new THREE.MeshBasicMaterial({ color: 0x14d8c4, transparent: true, opacity: 0.09, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const outer = new THREE.Mesh(outerGeo, outerMat);
    outer.rotation.x = Math.PI / 2;
    scene.add(outer);
    backdropMeshes.push(outer);
  }

  function addStarfield(scene) {
    if (starfieldMesh) return; // already added
    const geom = new THREE.BufferGeometry();
    // 3500 stars (less visual clutter behind the data)
    const count = 3500;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const palette = [
      [1.0, 0.85, 0.42],   // gold
      [0.08, 0.85, 0.77],  // teal
      [0.35, 0.44, 1.0],   // blue
      [1.0, 0.18, 0.5],    // pink
      [1.0, 1.0, 1.0]      // white
    ];
    for (let i = 0; i < count; i++) {
      // Distribute stars in a spherical shell 800-1800 units out
      const r = 800 + Math.random() * 1000;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      const c = palette[Math.floor(Math.random() * palette.length)];
      const intensity = 0.3 + Math.random() * 0.7;
      col[i * 3]     = c[0] * intensity;
      col[i * 3 + 1] = c[1] * intensity;
      col[i * 3 + 2] = c[2] * intensity;
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    });
    starfieldMesh = new THREE.Points(geom, mat);
    scene.add(starfieldMesh);
  }

  function addFog(scene) {
    if (fogApplied) return;
    // Fog pushed way back so nodes stay visible at any zoom.
    // Near at 4000 (well past typical orbit), Far at 14000 (past maxDistance).
    scene.fog = new THREE.Fog(0x05060c, 4000, 14000);
    fogApplied = true;
  }

  // Post-processing: bloom pass — one UnrealBloomPass on the 3d-force-graph composer.
  let bloomInstalled = false;
  function installBloom(Graph) {
    if (bloomInstalled) return;
    if (typeof THREE.UnrealBloomPass !== 'function') {
      console.warn('[bloom] UnrealBloomPass not loaded — bloom disabled');
      return;
    }
    if (typeof Graph.postProcessingComposer !== 'function') {
      console.warn('[bloom] postProcessingComposer() unavailable — bloom disabled');
      return;
    }
    const composer = Graph.postProcessingComposer();
    if (!composer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Subtle glow, not blown out (strength 0.4, radius 0.5, threshold 0.55)
    const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.5, 0.55);
    composer.addPass(bloom);
    bloomInstalled = true;
    window.__fandomBloom = bloom;
    window.addEventListener('resize', () => {
      bloom.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // Post-processing: film grain + radial chromatic aberration ShaderPass (chained after bloom).
  // Subtle filmic finish: per-frame random noise + RGB channel offset radiating from screen edges.
  let grainCAInstalled = false;
  function installGrainCA(Graph) {
    if (grainCAInstalled) return;
    try {
      if (typeof THREE.ShaderPass !== 'function') {
        console.warn('[grain] ShaderPass not loaded — grain+CA disabled');
        return;
      }
      if (typeof Graph.postProcessingComposer !== 'function') return;
      const composer = Graph.postProcessingComposer();
      if (!composer) return;
      const FilmGrainCAShader = {
        uniforms: {
          tDiffuse:   { value: null },
          time:       { value: 0 },
          grainAmt:   { value: 0.018 },
          caStrength: { value: 1.5 },
          resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
        },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: [
          'uniform sampler2D tDiffuse;',
          'uniform float time;',
          'uniform float grainAmt;',
          'uniform float caStrength;',
          'uniform vec2 resolution;',
          'varying vec2 vUv;',
          'float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898, 78.233)) + time) * 43758.5453); }',
          'void main(){',
          '  vec2 uv = vUv;',
          '  vec2 dir = uv - 0.5;',
          '  float dist = length(dir);',
          '  float caAmt = caStrength * pow(dist, 2.5) / resolution.x;',
          '  vec2 offset = dist > 0.0001 ? normalize(dir) * caAmt : vec2(0.0);',
          '  float r = texture2D(tDiffuse, uv + offset).r;',
          '  float g = texture2D(tDiffuse, uv).g;',
          '  float b = texture2D(tDiffuse, uv - offset).b;',
          '  vec3 color = vec3(r, g, b);',
          '  float n = rand(uv * 1000.0) - 0.5;',
          '  color += n * grainAmt;',
          '  gl_FragColor = vec4(color, 1.0);',
          '}'
        ].join('\n')
      };
      const pass = new THREE.ShaderPass(FilmGrainCAShader);
      pass.renderToScreen = true;
      composer.addPass(pass);
      grainCAInstalled = true;
      window.__fandomGrainCA = pass;
      const tick = () => {
        if (pass.uniforms && pass.uniforms.time) pass.uniforms.time.value = performance.now() / 1000;
        requestAnimationFrame(tick);
      };
      tick();
      window.addEventListener('resize', () => {
        if (pass.uniforms && pass.uniforms.resolution) {
          pass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
        }
      });
    } catch (e) {
      console.warn('[grain] install failed', e);
    }
  }

  function ensureGraph() {
    if (Graph) return Graph;
    Graph = ForceGraph3D()(container)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeLabel(n => {
        if (n.type === 'collector-hint') return '';
        if (n.type === 'collector-center') {
          return `<div style="font-family:Sofia Sans Extra Condensed,sans-serif; background:rgba(0,0,0,0.92); padding:10px 14px; border-radius:6px; color:#fff; border:2px solid #f5b840; font-size:13px;"><b style="font-size:18px; text-transform:uppercase; letter-spacing:0.02em;">${esc(n.name)}</b><br/><span style="color:#f5b840; font-size:11px; letter-spacing:0.12em; text-transform:uppercase;">Your universe · ${n.totalHoldings.toLocaleString()} serials</span></div>`;
        }
        if (n.type === 'collector-player') {
          return `<div style="font-family:Sofia Sans Extra Condensed,sans-serif; background:rgba(0,0,0,0.92); padding:10px 14px; border-radius:6px; color:#fff; border:2px solid ${esc(n.teamColorPrimary)}; font-size:13px;"><b style="font-size:16px; text-transform:uppercase; letter-spacing:0.02em;">${esc(n.name)}</b> · <span style="color:${esc(n.teamColorSecondary || n.teamColorPrimary)}; font-weight:700;">${n.holdings.toLocaleString()} serials</span><br/><span style="color:#9aa; font-size:10px; letter-spacing:0.12em; text-transform:uppercase;">${esc(n.team)} · click to enter</span></div>`;
        }
        if (n.type === 'collector-moment') {
          return `<div style="background:rgba(0,0,0,0.92); padding:10px 14px; border-radius:6px; color:#fff; border:1px solid ${esc(tierColor(n.tier))}; font-size:12px;"><b style="font-size:14px; font-family:Sofia Sans Extra Condensed,sans-serif; text-transform:uppercase;">${esc(n.setName)}</b> · <span style="color:${esc(tierColor(n.tier))}; font-weight:700;">${esc(tierLabel(n.tier))}</span><br/><span style="color:#9aa; font-size:11px;">${esc(n.playerName)} · Serial #${n.serialNumber || '?'}</span></div>`;
        }
        if (n.type === 'player') {
          return `<div style="font-family:Sofia Sans Extra Condensed,sans-serif; font-weight:900; font-size:22px; text-transform:uppercase; background:rgba(0,0,0,0.9); padding:10px 14px; border-radius:6px; color:#fff; border:2px solid ${esc(n.teamColors[0])};">${esc(n.name)}<br/><span style="font-size:11px; font-weight:500; color:#aaa; letter-spacing:0.1em; text-transform:uppercase;">${esc(n.team)}</span></div>`;
        }
        if (n.type === 'moment') {
          const e = n.edition;
          const desc = (e.play?.description || '').slice(0, 160);
          return `<div style="background:rgba(0,0,0,0.92); padding:12px 16px; border-radius:8px; color:#fff; border:1px solid ${esc(n.color)}; font-size:12px; max-width:360px;"><b style="font-size:15px; font-family:Sofia Sans Extra Condensed,sans-serif; text-transform:uppercase; letter-spacing:0.02em;">${esc(n.setName)}</b> · <span style="color:${esc(n.color)}; font-weight:700;">${esc(n.tierLabel)}</span><br/><span style="color:#9aa; font-size:11px;">Circulation of ${n.circulation.toLocaleString()}</span>${desc ? '<br/><span style="color:#ccc; font-size:11px; display:block; margin-top:6px;">' + esc(desc) + '...</span>' : ''}</div>`;
        }
        if (n.type === 'collector') {
          const rankBadge = n.globalRank <= 10 ? `<span style="color:#f5b840; font-weight:800;">#${n.globalRank}</span>` : `<span style="color:#9aa;">#${n.globalRank}</span>`;
          const badges = [];
          if (n.isTop10) badges.push('<b style="color:#f5b840;">TOP 10 LOCKED</b>');
          if (n.crossPlayerFan) badges.push(`<b style="color:#ff9a4a;">MULTI-PLAYER (${n.crossPlayerCount})</b>`);
          return `<div style="background:rgba(0,0,0,0.92); padding:12px 16px; border-radius:8px; color:#fff; border:1px solid ${esc(n.color)}; font-size:12px; min-width:220px;">${rankBadge} <span style="font-weight:700; font-size:14px;">${esc(n.name)}</span>${badges.length ? '<br/>' + badges.join(' · ') : ''}<br/><span style="color:#9aa; font-size:11px;">${fmtLockedScore(n.lockedScore)} locked score · ${n.fullHoldings.toLocaleString()} moments owned · ${esc(n.pctLabel)}</span></div>`;
        }
      })
      .nodeThreeObject(n => {
        // L4 Collector-Universe node types
        if (n.type === 'collector-hint') {
          // Faint gold outer-annulus particle hinting at more moments
          const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.5, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0xf5b840, transparent: true, opacity: 0.55 })
          );
          const g = new THREE.Group();
          g.add(mesh);
          g.add(glowSprite(new THREE.Color('#f5b840'), 2.8, 0.4));
          return g;
        }
        if (n.type === 'collector-center') {
          const group = new THREE.Group();
          const size = n.val || 26;
          const avatarSize = size * 2.4;
          // Tuned gold dual glow for pride-moment presence
          group.add(glowSprite(new THREE.Color('#f5b840'), size * 5, 0.5));
          group.add(glowSprite(new THREE.Color('#ffd74a'), size * 3, 0.45));
          // Placeholder core while avatar loads
          const placeholder = new THREE.Mesh(
            new THREE.SphereGeometry(size * 0.6, 20, 20),
            new THREE.MeshBasicMaterial({ color: '#f5b840' })
          );
          placeholder.userData.isPlaceholder = true;
          group.add(placeholder);
          const fallback = initials(n.name);
          makeAvatarSprite(n.profileImageUrl, avatarSize, '#f5b840', fallback).then(avatar => {
            group.remove(placeholder);
            group.add(avatar);
            n.__avatar = avatar;
          });
          // Username typography below
          const nameSprite = makeTextSprite(n.name, {
            fontSize: 64, fontWeight: 900, color: '#fff',
            bg: 'rgba(0,0,0,0.88)', borderColor: '#f5b840', paddingX: 16, paddingY: 8, scale: 3.6
          });
          nameSprite.position.set(0, -size * 1.6, 0);
          group.add(nameSprite);
          // Tagline above
          const tag = makeTextSprite('YOUR UNIVERSE', {
            fontSize: 22, fontWeight: 900, color: '#f5b840',
            bg: 'rgba(0,0,0,0.82)', borderColor: 'rgba(245,184,64,0.45)', paddingX: 10, paddingY: 4, scale: 5.5
          });
          tag.position.set(0, size * 1.75, 0);
          group.add(tag);
          n.__group = group;
          return group;
        }
        if (n.type === 'collector-player') {
          const group = new THREE.Group();
          const size = n.val || 10;
          const core = new THREE.Mesh(
            new THREE.SphereGeometry(size * 0.5, 28, 28),
            new THREE.MeshBasicMaterial({ color: n.teamColorPrimary })
          );
          group.add(core);
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(size * 0.72, size * 0.84, 64),
            new THREE.MeshBasicMaterial({ color: n.teamColorSecondary || n.teamColorPrimary, side: THREE.DoubleSide, transparent: true, opacity: 0.92 })
          );
          ring.rotation.x = Math.PI / 2;
          group.add(ring);
          group.add(glowSprite(new THREE.Color(n.teamColorPrimary), size * 5, 0.5));
          group.add(glowSprite(new THREE.Color(n.teamColorSecondary || n.teamColorPrimary), size * 7, 0.52));
          const nameSprite = makeTextSprite(n.name.toUpperCase(), {
            fontSize: 36, fontWeight: 900, bg: 'rgba(0,0,0,0.82)',
            borderColor: n.teamColorPrimary, color: '#fff', scale: 5
          });
          nameSprite.position.set(0, -size * 1.4, 0);
          group.add(nameSprite);
          const holdingsSprite = makeTextSprite(`${n.holdings.toLocaleString()} serials`, {
            fontSize: 20, bg: 'rgba(0,0,0,0.6)',
            borderColor: 'rgba(255,255,255,0.18)', color: 'rgba(240,242,253,0.85)', scale: 6
          });
          holdingsSprite.position.set(0, -size * 1.95, 0);
          group.add(holdingsSprite);
          n.__group = group;
          return group;
        }
        if (n.type === 'collector-moment') {
          const group = new THREE.Group();
          const size = n.val || 7;
          group.add(glowSprite(new THREE.Color(tierColor(n.tier)), size * 9, 0.55));
          const placeholder = new THREE.Mesh(
            new THREE.SphereGeometry(size * 0.9, 16, 16),
            new THREE.MeshBasicMaterial({ color: tierColor(n.tier) })
          );
          placeholder.userData.isPlaceholder = true;
          group.add(placeholder);
          if (n.heroUrl) {
            makeMomentCard(n.heroUrl, size * 4.8, tierColor(n.tier), n.setName).then(card => {
              group.remove(placeholder);
              group.add(card);
              n.__card = card;
            });
          }
          if (n.tier && n.tier.includes('ULTIMATE')) {
            const ring = new THREE.Mesh(
              new THREE.RingGeometry(size * 2.7, size * 3.15, 64),
              new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false })
            );
            ring.lookAt(new THREE.Vector3(0, 0, 1));
            group.add(ring);
            n.__ultimateRing = ring;
          }
          const lbl = makeTextSprite(tierLabel(n.tier).toUpperCase(), {
            fontSize: 20, bg: 'rgba(0,0,0,0.78)', borderColor: tierColor(n.tier), color: '#fff', scale: 7
          });
          lbl.position.set(0, -size * 2.8, 0);
          group.add(lbl);
          n.__group = group;
          return group;
        }
        if (n.type === 'edition-center') {
          const group = new THREE.Group();
          // Big glow behind the card
          group.add(glowSprite(new THREE.Color(tierColor(n.tier)), 220, 0.58));
          // Ultimate tier extra white pulse ring
          if (n.tier && n.tier.includes('ULTIMATE')) {
            const ring = new THREE.Mesh(
              new THREE.RingGeometry(55, 62, 64),
              new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })
            );
            ring.lookAt(new THREE.Vector3(0, 0, 1));
            group.add(ring);
            n.__ultimateRing = ring;
          }
          // Edition hero card sized down so holders can breathe.
          // The holders are the stars of L3, not the edition card.
          const placeholder = new THREE.Mesh(
            new THREE.SphereGeometry(8, 20, 20),
            new THREE.MeshBasicMaterial({ color: tierColor(n.tier) })
          );
          group.add(placeholder);
          if (n.heroUrl) {
            makeMomentCard(n.heroUrl, 42, tierColor(n.tier), n.setName).then(card => {
              group.remove(placeholder);
              group.add(card);
            });
          }
          const lbl = makeTextSprite((n.setName + ' · ' + tierLabel(n.tier)).toUpperCase(), {
            fontSize: 30, bg: 'rgba(0,0,0,0.88)', borderColor: tierColor(n.tier), color: '#fff', scale: 5
          });
          lbl.position.set(0, -30, 0);
          group.add(lbl);
          n.__group = group;
          return group;
        }
        if (n.type === 'serial-bead') {
          // Serial beads are tiny gold sparks. Human names are the visual focus,
          // not the abstract serial dots. Beads are ambient (there are lots of them).
          const group = new THREE.Group();
          const color = n.isUserOwned ? '#ffffff' : '#f5b840';
          const radius = n.isUserOwned ? 1.2 : 0.45;
          const core = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 8, 8),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: n.isUserOwned ? 1 : 0.6 })
          );
          group.add(core);
          if (n.isUserOwned) group.add(glowSprite(new THREE.Color(color), 8, 0.75));
          return group;
        }
        if (n.type === 'player') {
          const group = new THREE.Group();
          const core = new THREE.Mesh(
            new THREE.SphereGeometry(n.val * 0.55, 32, 32),
            new THREE.MeshBasicMaterial({ color: n.color })
          );
          group.add(core);
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(n.val * 0.7, n.val * 0.82, 64),
            new THREE.MeshBasicMaterial({ color: n.teamColors[0], side: THREE.DoubleSide, transparent: true, opacity: 0.92 })
          );
          ring.rotation.x = Math.PI / 2;
          group.add(ring);
          // Bigger glow — use additive
          group.add(glowSprite(new THREE.Color(n.teamColors[1] || n.color), n.val * 8, 0.62));
          group.add(glowSprite(new THREE.Color(n.teamColors[0]), n.val * 5, 0.5));
          const nameSprite = makeTextSprite(n.name.toUpperCase(), {
            fontSize: 54, fontWeight: 900, bg: 'rgba(0,0,0,0.82)',
            borderColor: n.teamColors[0], color: '#fff', scale: 3.2
          });
          nameSprite.position.set(0, -n.val * 1.35, 0);
          // Always render on top — prevents occlusion during auto-rotate
          if (nameSprite.material) { nameSprite.material.depthTest = false; nameSprite.material.zOffset = -1; }
          group.add(nameSprite);
          // Team subtitle
          const teamSprite = makeTextSprite(n.team.toUpperCase(), {
            fontSize: 22, bg: 'rgba(0,0,0,0.6)',
            borderColor: 'rgba(255,255,255,0.15)', color: '#cfcfd6', scale: 6
          });
          teamSprite.position.set(0, -n.val * 1.8, 0);
          if (teamSprite.material) { teamSprite.material.depthTest = false; teamSprite.material.zOffset = -1; }
          group.add(teamSprite);
          n.__group = group;
          return group;
        }
        if (n.type === 'moment') {
          const group = new THREE.Group();
          const size = Math.sqrt(n.val) * 2.3;

          // Placeholder core (while hero image loads)
          const core = new THREE.Mesh(
            new THREE.SphereGeometry(size * 0.4, 20, 20),
            new THREE.MeshBasicMaterial({ color: n.color })
          );
          core.userData.isPlaceholder = true;
          group.add(core);

          // Real moment card with hero image
          if (n.heroUrl) {
            makeMomentCard(n.heroUrl, size * 2.2, n.color, n.setName).then(card => {
              // Remove placeholder
              group.remove(core);
              group.add(card);
              n.__card = card;
            });
          }

          // Ultimate tier gets a white halo ring AND pulse
          if (n.tier && n.tier.includes('ULTIMATE')) {
            const ring = new THREE.Mesh(
              new THREE.RingGeometry(size * 1.6, size * 2.2, 64),
              new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
            );
            ring.lookAt(new THREE.Vector3(0, 0, 1));
            group.add(ring);
            n.__ultimateRing = ring;
          }

          // Big additive glow
          group.add(glowSprite(new THREE.Color(n.color), size * 5.5, 0.55));

          // Label
          const labelSprite = makeTextSprite(n.setName.toUpperCase(), {
            fontSize: 26, bg: 'rgba(0,0,0,0.78)', borderColor: n.color, color: '#fff', scale: 7
          });
          labelSprite.position.set(0, -size * 1.6, 0);
          group.add(labelSprite);
          n.__group = group;
          return group;
        }

        // Collector
        const group = new THREE.Group();
        // Collector tier rendering: scale up every tier. Top-10 get crown treatment,
        // avatars + names, even silver tier gets a small avatar + name (not just a grey dot).
        const size = Math.sqrt(n.val) * 2.0;

        if (n.isTop10) {
          // Inner circle collectors: avatar-first — the real profile image IS the node
          const avatarSize = size * 3.8;
          const placeholder = new THREE.Mesh(
            new THREE.SphereGeometry(size * 0.8, 16, 16),
            new THREE.MeshBasicMaterial({ color: '#f5b840' })
          );
          placeholder.userData.isPlaceholder = true;
          group.add(placeholder);

          const fallback = initials(n.name);
          makeAvatarSprite(n.profileImageUrl, avatarSize, '#f5b840', fallback).then(avatar => {
            group.remove(placeholder);
            avatar.position.set(0, 0, 0);
            group.add(avatar);
            n.__avatar = avatar;
          });

          // #1 holder gets a gold crown overhead — pride moment
          if (n.globalRank === 1) {
            const crown = makeTextSprite('👑', { fontSize: 64, bg: 'rgba(0,0,0,0)', borderColor: null, paddingX: 0, paddingY: 0, scale: 3.5 });
            crown.position.set(0, size * 3.6, 0);
            group.add(crown);
          }

          // Rank badge above avatar (compact)
          const rankSprite = makeTextSprite(`#${n.globalRank}`, {
            fontSize: 34, fontWeight: 900, color: '#f5b840',
            bg: 'rgba(0,0,0,0.94)', borderColor: '#f5b840', paddingX: 12, paddingY: 5, scale: 8
          });
          rankSprite.position.set(0, size * 2.7, 0);
          group.add(rankSprite);

          // Big name label below avatar
          const nameSprite = makeTextSprite(n.name, {
            fontSize: 40, color: '#fff',
            bg: 'rgba(0,0,0,0.92)', borderColor: 'rgba(245,184,64,0.55)', scale: 4.2
          });
          nameSprite.position.set(0, -size * 2.9, 0);
          group.add(nameSprite);

          group.add(glowSprite(new THREE.Color('#f5b840'), size * 7, 0.55));
        } else if (n.tier === 'teal') {
          // Top 50: real avatar + bigger, always-visible name
          const avatarSize = size * 3.0;
          const fallback = initials(n.name);
          makeAvatarSprite(n.profileImageUrl, avatarSize, '#14d8c4', fallback).then(avatar => {
            group.add(avatar);
          });
          const rankSprite = makeTextSprite(`#${n.globalRank}`, {
            fontSize: 20, fontWeight: 900, color: '#14d8c4',
            bg: 'rgba(0,0,0,0.82)', borderColor: 'rgba(20,216,196,0.55)', paddingX: 6, paddingY: 3, scale: 10
          });
          rankSprite.position.set(0, size * 2.0, 0);
          group.add(rankSprite);
          const nameSprite = makeTextSprite(n.name, {
            fontSize: 28, color: '#fff',
            bg: 'rgba(0,0,0,0.85)', borderColor: 'rgba(20,216,196,0.4)', scale: 6
          });
          nameSprite.position.set(0, -size * 2.2, 0);
          group.add(nameSprite);
          group.add(glowSprite(new THREE.Color('#14d8c4'), size * 4.5, 0.3));
        } else if (n.tier === 'silver') {
          // Silver tier gets identity — small avatar + dimmer name. Still visible, still clickable.
          const avatarSize = size * 2.2;
          const fallback = initials(n.name);
          makeAvatarSprite(n.profileImageUrl, avatarSize, '#d4d4d9', fallback).then(avatar => {
            group.add(avatar);
          });
          const nameSprite = makeTextSprite(n.name, {
            fontSize: 20, color: 'rgba(240,242,253,0.9)',
            bg: 'rgba(0,0,0,0.78)', borderColor: 'rgba(212,212,217,0.3)', scale: 7
          });
          nameSprite.position.set(0, -size * 1.8, 0);
          group.add(nameSprite);
          group.add(glowSprite(new THREE.Color('#d4d4d9'), size * 3.2, 0.22));
        } else {
          // Grey tier (ranks 201+): still a dot, but hoverable. Click-to-focus will fly the camera
          // in close enough that users can see their name on hover / tooltip even from far-out.
          const opacity = n.crossPlayerFan ? 0.82 : 0.55;
          const core = new THREE.Mesh(
            new THREE.SphereGeometry(size * 1.1, 14, 14),
            new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity })
          );
          group.add(core);
          if (n.crossPlayerFan) {
            group.add(glowSprite(new THREE.Color('#ff9a4a'), size * 3.5, 0.3));
          }
        }

        n.__group = group;
        return group;
      })
      .linkColor(l => {
        if (l.kind === 'collector-to-player') return l.strokeColor || 'rgba(245,184,64,0.55)';
        if (l.kind === 'player-moment') return 'rgba(255,217,107,0.55)';
        const srcNode = typeof l.source === 'object' ? l.source : null;
        if (srcNode?.isTop10) return 'rgba(245,184,64,0.62)';
        if (srcNode?.tier === 'teal') return 'rgba(20,216,196,0.35)';
        if (srcNode?.crossPlayerFan) return 'rgba(255,154,74,0.32)';
        return 'rgba(240,242,253,0.05)';
      })
      .linkOpacity(0.55)
      .linkWidth(l => {
        if (l.kind === 'collector-to-player') return 1.8;
        if (l.kind === 'player-moment') return 1.8;
        const srcNode = typeof l.source === 'object' ? l.source : null;
        if (srcNode?.isTop10) return 1.4;
        if (srcNode?.tier === 'teal') return 0.8;
        return 0.35;
      })
      .linkDirectionalParticles(l => {
        if (l.kind === 'collector-to-player') return 3;
        if (l.kind === 'player-moment') return 3;
        const srcNode = typeof l.source === 'object' ? l.source : null;
        if (srcNode?.isTop10) return 2;
        return 0;
      })
      .linkDirectionalParticleSpeed(0.008)
      .linkDirectionalParticleColor(l => {
        if (l.kind === 'collector-to-player') return l.particleColor || '#ffd96b';
        if (l.kind === 'player-moment') return '#ffd96b';
        return '#f5b840';
      })
      .linkDirectionalParticleWidth(1.6)
      .cooldownTime(0)
      .onBackgroundClick(() => {
        if (window.__clearCollectorSpotlight) window.__clearCollectorSpotlight();
      })
      .onNodeClick((node, event) => {
        // Shift+click OR double-click any node = pure navigation gesture: fly there
        // and retarget the orbit center, without routing/drawer. Lets you tour the
        // graph by clicking around without losing your place.
        if (event && (event.shiftKey || event.detail >= 2)) {
          flyToNode(node, 100);
          return;
        }
        // L4 Collector-Universe
        if (node.type === 'collector-center' || node.type === 'collector-hint') {
          // Center: toggle drawer. Hint particles: no-op.
          if (node.type === 'collector-center') {
            if (drawer.classList.contains('open')) drawer.classList.remove('open');
            else {
              const key = node.flowAddress;
              const cg = buildCollectorGraph(key);
              const pct = estimateCollectorPercentile(key);
              openL4CollectorDrawer({ cg, pct, key, uname: node.name, hero: cg.primaryOwner });
            }
          }
          return;
        }
        if (node.type === 'collector-player') {
          window.fandomRouter.go('player', { player: node.playerName });
          return;
        }
        if (node.type === 'collector-moment') {
          window.fandomRouter.go('edition', { key: node.editionKey, player: node.playerName });
          return;
        }
        if (node.type === 'moment') {
          window.fandomRouter.go('edition', { key: node.edition.editionKey, player: currentPlayer });
          return;
        }
        if (node.type === 'collector') {
          // Camera flies to collector, drawer opens, AND graph enters spotlight mode —
          // everything except this collector + the editions they own fades back, with a
          // "owns X of Y · N%" badge across the top. Click the badge or hit ESC to clear.
          flyToNode(node, 85);
          openCollectorDrawer(node);
          enterCollectorSpotlight(node);
          return;
        }
        else if (node.type === 'player') {
          flyToNode(node, 120);
          openPlayerDrawer(node);
        }
        else if (node.type === 'edition-center') {
          // quick back: go to L2 (player view)
          if (currentPlayer) window.fandomRouter.go('player', { player: currentPlayer });
          return;
        }
        else if (node.type === 'serial-bead') {
          // Fly in close to the serial so the user sees they've actually selected something,
          // then show the preview card. Sparks are tiny — the fly-in is part of the confirmation.
          flyToNode(node, 32);
          showSerialPreview(node);
          return;
        }
        // Default fallback for any other clickable node
        flyToNode(node, 160);
      });

    // Universal camera-focus-on-click. Smoothly flies the camera TO the clicked node
    // at the supplied distance, looking at the node. Unlike the old code that used cameraPosition
    // with `node` as lookAt (which pivots), this sets an explicit world-space target offset.
    function flyToNode(node, desiredDistance = 120) {
      if (!Graph) return;
      const nx = node.x || node.fx || 0;
      const ny = node.y || node.fy || 0;
      const nz = node.z || node.fz || 0;
      const cam = Graph.camera();
      if (!cam) return;
      // Use the vector from node toward current camera position to preserve orbit angle
      const dx = cam.position.x - nx;
      const dy = cam.position.y - ny;
      const dz = cam.position.z - nz;
      const dist = Math.max(0.1, Math.hypot(dx, dy, dz));
      const scale = desiredDistance / dist;
      const newPos = {
        x: nx + dx * scale,
        y: ny + dy * scale,
        z: nz + dz * scale
      };
      Graph.cameraPosition(newPos, { x: nx, y: ny, z: nz }, 900);
      // CRITICAL for navigation: re-target OrbitControls to the clicked node so subsequent
      // left-drag rotates AROUND it (not around the old origin). This is what makes the graph
      // actually feel navigable instead of stuck-pivoting on the player center.
      const ctrls = (typeof Graph.controls === 'function') ? Graph.controls() : null;
      if (ctrls && ctrls.target) {
        // Tween the target to match the camera lookAt over the same duration, otherwise
        // OrbitControls snaps it on first interaction and feels jarring.
        const start = { x: ctrls.target.x, y: ctrls.target.y, z: ctrls.target.z };
        const t0 = performance.now();
        const dur = 900;
        function tick(now) {
          const t = Math.min(1, (now - t0) / dur);
          const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
          ctrls.target.x = start.x + (nx - start.x) * e;
          ctrls.target.y = start.y + (ny - start.y) * e;
          ctrls.target.z = start.z + (nz - start.z) * e;
          ctrls.update();
          if (t < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }
    }

    // Force tuning — spread nodes for readability on mobile + desktop
    Graph.d3Force('charge').strength(-600);
    Graph.d3Force('link').distance(l => {
      if (l.kind === 'player-moment') return 120;
      const src = typeof l.source === 'object' ? l.source : null;
      if (src?.isTop10) return 40;
      if (src?.tier === 'teal') return 100;
      return 200;
    });
    // Note: d3.forceCollide not available — 3d-force-graph bundles d3 internally
    // but doesn't expose it as a global. Strong charge (-600) + wide link distances
    // handle the spreading; no separate collide force needed.

    // Bloom + film grain: deferred a tick so 3d-force-graph's composer is live.
    setTimeout(() => { installBloom(Graph); installGrainCA(Graph); }, 120);

    // Add backdrop + starfield + fog once scene is available
    setTimeout(() => {
      const scene = Graph.scene();
      if (scene) {
        addBackdropRings(scene);
        addStarfield(scene);
        addFog(scene);
      }
    }, 100);

    // Unlock full pan/zoom/orbit navigation. 3d-force-graph uses OrbitControls internally;
    // defaults disable pan and clamp zoom. Unlocking so the user can fly through the data field.
    setTimeout(() => {
      if (typeof Graph.controls !== 'function') return;
      const c = Graph.controls();
      if (!c) return;
      c.enableDamping = true;
      c.dampingFactor = 0.08;
      c.enablePan = true;                      // left-drag = orbit, right-drag = pan, middle-drag/pinch = zoom
      c.screenSpacePanning = true;             // pan parallel to camera plane (more intuitive than world-axis pan)
      c.panSpeed = 1.8;                        // navigation pass: faster pan for free movement
      c.rotateSpeed = 1.1;                     // snappier orbit
      c.zoomSpeed = 1.6;                       // bigger steps per scroll wheel tick
      c.minDistance = 20;                      // can get closer to inspect a node
      c.maxDistance = 8000;                    // can pull WAY out for the wide shot
      c.keyPanSpeed = 60;                      // arrow keys pan aggressively
      // Push the camera's far plane so distant nodes don't clip when pulled back.
      const cam = Graph.camera();
      if (cam) { cam.far = 20000; cam.near = 0.5; cam.updateProjectionMatrix(); }
      // listenToKeyEvents only exists in newer OrbitControls — guard for the r147 build bundled here
      if (typeof c.listenToKeyEvents === 'function') {
        c.listenToKeyEvents(window);
        c.keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };
      } else {
        // Manual arrow-key pan fallback — shifts camera + target along camera-relative axes
        window.addEventListener('keydown', (ev) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
          if (document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
          const cam = Graph.camera();
          if (!cam) return;
          const panAmt = 30;
          const dir = new THREE.Vector3();
          if (ev.key === 'ArrowLeft') { cam.getWorldDirection(dir); dir.cross(cam.up).normalize().multiplyScalar(-panAmt); }
          else if (ev.key === 'ArrowRight') { cam.getWorldDirection(dir); dir.cross(cam.up).normalize().multiplyScalar(panAmt); }
          else if (ev.key === 'ArrowUp') { dir.copy(cam.up).normalize().multiplyScalar(panAmt); }
          else if (ev.key === 'ArrowDown') { dir.copy(cam.up).normalize().multiplyScalar(-panAmt); }
          cam.position.add(dir);
          c.target.add(dir);
        });
      }
      c.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      };
      c.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_PAN
      };
      window.__fandomControls = c;
      window.__fandomGraph = Graph;

      // Suppress the browser context menu inside the graph so right-click-drag pans cleanly
      const graphDom = document.getElementById('graph');
      if (graphDom) {
        graphDom.addEventListener('contextmenu', (e) => e.preventDefault());
      }
    }, 150);

    // Ultimate-tier pulse animation: scan scene nodes each frame
    const clock = new THREE.Clock();
    Graph.onEngineTick(() => {
      // Auto-rotate: OrbitControls.autoRotate needs update() every frame.
      // 3d-force-graph stops calling update() after simulation cooldown.
      if (autoRotate && typeof Graph.controls === 'function') {
        const c = Graph.controls();
        if (c && c.autoRotate) c.update();
      }
      const t = clock.getElapsedTime();
      for (const n of currentData.nodes) {
        if (n.type === 'moment' && n.__ultimateRing) {
          const s = 1 + Math.sin(t * 2.2) * 0.2;
          n.__ultimateRing.scale.set(s, s, s);
          n.__ultimateRing.material.opacity = 0.65 + Math.sin(t * 2.2) * 0.2;
        }
        if (n.type === 'player' && n.__group) {
          // Subtle rotation of the central ring (second child)
          const ring = n.__group.children[1];
          if (ring && ring.rotation) ring.rotation.z = t * 0.18;
        }
      }
      // Rotate backdrop rings slowly
      for (const m of backdropMeshes) m.rotation.z = t * 0.02;
      // Slowly drift starfield
      if (starfieldMesh) starfieldMesh.rotation.y = t * 0.008;
    });

    return Graph;
  }

  // ======================= Show graph =======================
  function showGraphFor(playerName) {
    currentPlayer = playerName;
    currentData = buildGraph(playerName);
    document.getElementById('graph-empty').style.display = 'none';
    document.getElementById('graph-legend').style.display = 'block';
    document.getElementById('graph-meta').style.display = 'block';
    document.getElementById('graph-controls').style.display = 'flex';
    document.getElementById('graph-hint').style.display = 'block';
    document.getElementById('leaderboard').style.display = 'flex';

    document.getElementById('gm-player').textContent = playerName;
    // Moments = total minted (every serial is a unique Moment).
    const playerPayload = data.players.find(x => x.name === playerName);
    // Privacy-first analytics (spec-003 Task 8): fire a deep-link event carrying ONLY the
    // numeric playerId — never the player name, wallet address, dapperID, or username.
    if (typeof window.plausible === 'function' && playerPayload && playerPayload.playerId) {
      window.plausible('deep_link_player', { props: { player_id: String(playerPayload.playerId) } });
    }
    const totalMoments = playerPayload?.totalMintedMomentCount || currentData.stats.totalMinted || 0;
    // Epic intro: count up from 0 to the real number over 1.4s. Hooks visceral
    // "wait, this is enormous" reaction the moment the universe lands.
    const animateCount = (el, target, durMs = 1400) => {
      if (!el || target == null) return;
      const t0 = performance.now();
      const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / durMs);
        const v = Math.floor(target * ease(t));
        el.textContent = v.toLocaleString();
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = target.toLocaleString();
      };
      requestAnimationFrame(tick);
    };
    animateCount(document.getElementById('gm-moments'), totalMoments, 1500);
    animateCount(document.getElementById('gm-collectors'), currentData.stats.collectors || 0, 1300);
    animateCount(document.getElementById('gm-top10'), currentData.stats.top10 || 0, 1100);
    animateCount(document.getElementById('gm-serials'), currentData.stats.editions || 0, 900);
    // Locked score total (sum of all locked ASP for this player) — shown as currency.
    const lockedTotal = currentData.stats.lockedTotalScore;
    const gmLocked = document.getElementById('gm-locked');
    if (gmLocked) {
      if (lockedTotal !== null && lockedTotal >= 0) {
        const t0l = performance.now();
        const easeL = (t) => 1 - Math.pow(1 - t, 3);
        const tickL = (now) => {
          const t = Math.min(1, (now - t0l) / 1200);
          const v = Math.floor(lockedTotal * easeL(t));
          gmLocked.textContent = fmtLockedScore(v);
          if (t < 1) requestAnimationFrame(tickL);
          else gmLocked.textContent = fmtLockedScore(lockedTotal);
        };
        requestAnimationFrame(tickL);
      } else {
        gmLocked.textContent = '—';
      }
    }

    renderLeaderboard(currentData);

    const g = ensureGraph();
    g.graphData({ nodes: currentData.nodes, links: currentData.links });

    // Cinematic camera intro: epic 3-stage warp → swoop → settle. ~3s total.
    // Stage 1: snap to deep space (far, dark, anticipation)
    g.cameraPosition({ x: 0, y: 1200, z: 3500 }, { x: 0, y: 0, z: 0 }, 0);
    // Stage 2: warp through midfield (the "we're approaching" moment)
    setTimeout(() => {
      g.cameraPosition({ x: 60, y: 700, z: 1400 }, { x: 0, y: 0, z: 0 }, 900);
    }, 200);
    // Stage 3: arrival glide — slower easing for the settle, lets the eye catch up
    setTimeout(() => {
      g.cameraPosition({ x: 620, y: 200, z: 1020 }, { x: 0, y: 0, z: 0 }, 2200);
    }, 1100);
    // Idle auto-rotate kicks in after 8s of no input, ambient cinema feel
    scheduleIdleAutoRotate();
    // spec-004: Plausible picker_to_graph timing — fire after the cinematic
    // camera intro settles (Stage 3 starts at 1100ms + 2200ms glide = 3300ms).
    if (selectionTime > 0 && typeof window.plausible === 'function') {
      setTimeout(() => {
        const renderTime = performance.now();
        window.plausible('picker_to_graph', { props: { duration_ms: Math.round(renderTime - selectionTime) } });
        selectionTime = 0;
      }, 3400);
    }

    // Re-add scene adornments
    setTimeout(() => {
      const scene = g.scene();
      if (scene) {
        addBackdropRings(scene);
        addStarfield(scene);
        addFog(scene);
      }
    }, 450);

    // ---- Honest top-N disclosure + hint annulus (spec-003 Task 6) ----
    // Remove any previous hint annulus before adding the new one (covers the
    // case where a second player loads without going back to the picker).
    if (hintAnnulusMesh) {
      const prevScene = g.scene();
      if (prevScene) prevScene.remove(hintAnnulusMesh);
      hintAnnulusMesh = null;
    }
    if (currentData.hintPoints) {
      hintAnnulusMesh = currentData.hintPoints;
      // Add after the scene adornments settle so the annulus layers cleanly
      setTimeout(() => {
        const scene = g.scene();
        if (scene && hintAnnulusMesh) scene.add(hintAnnulusMesh);
      }, 500);
    }

    // Coverage disclosure affordance — a small text element in the graph area,
    // NOT a modal. Reads "Showing top S of M collectors" (or "all N" / "none").
    const cov = currentData.coverage || { S: 0, M: 0 };
    const coverageEl = document.getElementById('graph-coverage');
    if (coverageEl) {
      coverageEl.style.display = 'block';
      if (cov.M === 0) {
        coverageEl.textContent = 'No collector data available';
      } else {
        coverageEl.textContent = 'Showing top ' + Math.min(cov.S, 200) + ' of ' + cov.M.toLocaleString() + ' loaded holders · ' + (cov.locked ? 'available locked score' : 'Moments owned');
      }
    }
    window.__fandomCoverage = { S: cov.S, M: cov.M };
  }

  // ======================= Leaderboard sidebar =======================
  // Tier weight for sparkline bar ordering (ultimate brightest, first).
  const SPARK_TIER_WEIGHT = { ultimate: 5, legendary: 4, anthology: 3, rare: 2, common: 1 };
  const SPARK_TIER_COLOR = {
    ultimate: '#fff3c0',
    legendary: '#ff80ff',
    anthology: '#f5b840',
    rare: '#3b82f6',
    common: '#8d8d96'
  };

  // Aggregate an owner's per-edition holdings across the player's sampled serials.
  // Returns up to 12 {editionKey, tier, count} buckets, tier-weighted sorted (ultimate first).
  function editionHoldingsForOwner(ownerId, player) {
    if (!ownerId || !player || !Array.isArray(player.editions)) return [];
    const ownerLower = String(ownerId).toLowerCase().replace(/^0x/, '');
    const buckets = [];
    for (const e of player.editions) {
      const samples = Array.isArray(e.serialsSampled) ? e.serialsSampled : [];
      let c = 0;
      for (const s of samples) {
        const oa = s && (s.ownerFlowAddress || s.ownerAddress);
        if (!oa) continue;
        const norm = String(oa).toLowerCase().replace(/^0x/, '');
        if (norm === ownerLower) c++;
      }
      if (c > 0) {
        buckets.push({ editionKey: e.editionKey, tier: (e.tier || 'common').toLowerCase(), count: c });
      }
    }
    buckets.sort((a, b) => {
      const w = (SPARK_TIER_WEIGHT[b.tier] || 0) - (SPARK_TIER_WEIGHT[a.tier] || 0);
      if (w !== 0) return w;
      return b.count - a.count;
    });
    return buckets.slice(0, 12);
  }

  // Build an inline 120x18 SVG string of vertical bars per-edition, tier-colored, log-scaled.
  function renderSparklineSVG(distribution) {
    const W = 120, H = 18, N = 12;
    if (!distribution || !distribution.length) {
      return `<svg class="lb-spark lb-spark-empty" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><rect x="0" y="8" width="${W}" height="2" fill="rgba(255,255,255,0.08)"/></svg>`;
    }
    const gap = 2;
    const barW = Math.max(2, Math.floor((W - gap * (N - 1)) / N));
    const drawnW = barW * distribution.length + gap * (distribution.length - 1);
    const offsetX = Math.max(0, Math.floor((W - drawnW) / 2));
    const maxC = Math.max(...distribution.map(b => b.count));
    const logScale = maxC > 20;
    const scale = (c) => {
      if (c <= 0) return 0;
      if (logScale) return Math.log(c + 1) / Math.log(maxC + 1);
      return c / maxC;
    };
    let bars = '';
    for (let i = 0; i < distribution.length; i++) {
      const b = distribution[i];
      const h = Math.max(2, Math.round(scale(b.count) * (H - 2)));
      const x = offsetX + i * (barW + gap);
      const y = H - h;
      const color = SPARK_TIER_COLOR[b.tier] || SPARK_TIER_COLOR.common;
      const label = `${b.tier}: ${b.count}`;
      bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="1" fill="${color}"><title>${label}</title></rect>`;
    }
    return `<svg class="lb-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="false">${bars}</svg>`;
  }

  function renderLeaderboard(graphData) {
    const lb = document.getElementById('lb-list');
    const sub = document.getElementById('lb-sub');
    lb.innerHTML = '';
    const p = graphData.player;
    const lockedTotal = 200;
    sub.textContent = `${p.name} · positions among loaded holders. ${p.rankingMode === 'locked' ? 'Available locked score.' : 'Moments owned; locked ranking unavailable.'}`;
    document.querySelector('.lb-title').textContent = p.rankingMode === 'locked' ? 'Available Score Leaders' : 'Ownership Leaders';
    document.querySelector('.lb-eyebrow').textContent = p.rankingMode === 'locked' ? 'Locked score' : 'Ownership view';
    const max = Math.max(1, ...graphData.ownerArr.slice(0, 10).map(o => p.rankingMode === 'locked' ? (o.lockedScore || 0) : o.fullHoldings));
    for (let i = 0; i < Math.min(10, graphData.ownerArr.length); i++) {
      const o = graphData.ownerArr[i];
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.dataset.id = o.id;

      const rankEl = document.createElement('div');
      rankEl.className = 'lb-rank';
      rankEl.textContent = String(o.globalRank);

      const avEl = document.createElement('div');
      avEl.className = 'lb-avatar';
      if (o.profileImageUrl) {
        avEl.style.backgroundImage = `url("${o.profileImageUrl.replace(/"/g, '&quot;')}")`;
      } else {
        avEl.textContent = initials(o.name);
      }

      const infoEl = document.createElement('div');
      infoEl.className = 'lb-info';
      const nameEl = document.createElement('div');
      nameEl.className = 'lb-name';
      nameEl.textContent = o.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'lb-meta';
      const crossTag = o.crossPlayerFan ? ` · ${o.crossPlayerCount}-player` : '';
      metaEl.textContent = `${o.pctLabel}${crossTag}`;
      infoEl.appendChild(nameEl);
      infoEl.appendChild(metaEl);

      const holdEl = document.createElement('div');
      holdEl.className = 'lb-holdings';
      holdEl.textContent = p.rankingMode === 'locked' ? fmtLockedScore(o.lockedScore) : o.fullHoldings.toLocaleString();

      row.appendChild(rankEl);
      row.appendChild(avEl);
      row.appendChild(infoEl);
      row.appendChild(holdEl);

      // Progress bar (full width, row 2 of the grid)
      const bar = document.createElement('div');
      bar.className = 'lb-bar';
      const fill = document.createElement('div');
      fill.className = 'lb-bar-fill';
      fill.style.width = `${Math.min(100, ((p.rankingMode === 'locked' ? (o.lockedScore || 0) : o.fullHoldings) / max) * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);

      row.addEventListener('click', () => {
        openCollectorDrawer(o);
        const target = graphData.nodes.find(n => n.id === o.id);
        if (target && Graph) {
          const distance = 150;
          const distRatio = 1 + distance / Math.hypot(target.x || 1, target.y || 1, target.z || 1);
          Graph.cameraPosition({ x: (target.x || 1) * distRatio, y: (target.y || 1) * distRatio, z: (target.z || 1) * distRatio }, target, 900);
        }
      });

      lb.appendChild(row);
    }
  }

  document.getElementById('lb-collapse').addEventListener('click', () => {
    document.getElementById('leaderboard').classList.toggle('collapsed');
  });

  // ======================= Drawer =======================
  const drawer = document.getElementById('drawer');
  const drawerInner = document.getElementById('drawer-inner');
  function clearDrawer() { while (drawerInner.firstChild) drawerInner.removeChild(drawerInner.firstChild); }
  function mkEl(tag, opts = {}) {
    const el = document.createElement(tag);
    if (opts.className) el.className = opts.className;
    if (opts.text) el.textContent = opts.text;
    if (opts.href) el.href = opts.href;
    if (opts.target) el.target = opts.target;
    if (opts.rel) el.rel = opts.rel;
    if (opts.style) el.style.cssText = opts.style;
    if (opts.src) el.src = opts.src;
    if (opts.alt) el.alt = opts.alt;
    return el;
  }
  document.getElementById('drawer-close').addEventListener('click', () => drawer.classList.remove('open'));

  function openCollectorDrawer(n) {
    clearDrawer();
    const p = data.players.find(x => x.name === currentPlayer);
    if (!p) return; // defensive — shouldn't happen at L2
    const total = p.owners.length;
    const rank = n.globalRank;
    const lockedScore = n.lockedScore;

    // Hero (avatar + rank + username)
    const hero = mkEl('div', { className: 'collector-hero' });
    const av = mkEl('div', { className: 'collector-hero-avatar' });
    if (n.profileImageUrl) av.style.backgroundImage = `url("${n.profileImageUrl.replace(/"/g, '&quot;')}")`;
    else av.textContent = initials(n.name);
    hero.appendChild(av);
    meta.appendChild(mkEl('div', { className: 'collector-hero-rank', text: `#${rank} · ${fmtLockedScore(lockedScore)}` }));
    meta.appendChild(mkEl('div', { className: 'collector-hero-label', text: `${currentPlayer} collector · position among loaded holders` }));
    meta.appendChild(mkEl('div', { className: 'collector-hero-username', text: n.name }));
    hero.appendChild(meta);
    drawerInner.appendChild(hero);

    // Percentile row
    const pct = mkEl('div', { className: 'percentile-row' });
    pct.appendChild(mkEl('div', { className: 'percentile-label', text: n.pctLabel }));
    const bar = mkEl('div', { className: 'percentile-bar' });
    const fill = mkEl('div', { className: 'percentile-fill' });
    // Fill = inverse of percentile (higher rank = bigger fill)
    const fillPct = Math.max(1, 100 - percentileRank(rank, total));
    fill.style.width = `${fillPct}%`;
    bar.appendChild(fill);
    pct.appendChild(bar);
    pct.appendChild(mkEl('div', { className: 'percentile-value', text: `Locked: ${fmtLockedScore(lockedScore)} · Owned: ${n.fullHoldings.toLocaleString()} moments` }));
    drawerInner.appendChild(pct);

    // Stats grid
    const rarRow = mkEl('div', { className: 'rar-row' });
    const sp1 = document.createElement('span');
    sp1.innerHTML = `<strong>${fmtLockedScore(lockedScore)}</strong> locked score · <strong>#${rank}</strong> rank`;
    rarRow.appendChild(sp1);
    const sp2 = document.createElement('span');
    const pctHeld = (n.fullHoldings / p.totalMintedMomentCount * 100).toFixed(2);
    sp2.innerHTML = `<strong>${pctHeld}%</strong> of all ${currentPlayer} Moments`;
    rarRow.appendChild(sp2);
    if (n.crossPlayerFan) {
      const sp3 = document.createElement('span');
      sp3.style.color = '#ff9a4a';
      sp3.innerHTML = `<strong>${n.crossPlayerCount}</strong> players collected`;
      rarRow.appendChild(sp3);
    }
    drawerInner.appendChild(rarRow);

    // One-up / one-down (neighbor context)
    if (currentData && currentData.ownerArr.length > 1) {
      const arr = currentData.ownerArr;
      const neighbors = mkEl('div', { className: 'neighbors' });
      const above = arr.find(o => o.globalRank === rank - 1);
      const below = arr.find(o => o.globalRank === rank + 1);
      function neighborEl(dir, o) {
        if (!o) return null;
        const el = mkEl('div', { className: 'neighbor' });
        el.appendChild(mkEl('div', { className: 'neighbor-dir', text: dir }));
        el.appendChild(mkEl('div', { className: 'neighbor-name', text: `#${o.globalRank} · ${o.name}` }));
        el.appendChild(mkEl('div', { className: 'neighbor-holdings', text: fmtLockedScore(o.lockedScore) }));
        el.addEventListener('click', () => openCollectorDrawer(o));
        return el;
      }
      const aEl = neighborEl('▲ one ahead', above);
      const bEl = neighborEl('▼ one behind', below);
      if (aEl) neighbors.appendChild(aEl);
      if (bEl) neighbors.appendChild(bEl);
      if (aEl || bEl) drawerInner.appendChild(neighbors);
    }

    // Moments grid (trophy case) — actual hero images from Media Gateway
    if (n.momentsOwned.length) {
      const section = mkEl('div', { className: 'drawer-section' });
      section.appendChild(mkEl('h4', { text: `Trophy case · ${n.momentsOwned.length} Moments in this graph` }));
      const byEdition = new Map();
      for (const h of n.momentsOwned) {
        const list = byEdition.get(h.editionKey) || [];
        list.push(h);
        byEdition.set(h.editionKey, list);
      }
      const grid = mkEl('div', { className: 'moments-grid' });
      for (const [ek, arr] of [...byEdition.entries()].sort((a, b) => {
        // Sort by tier weight descending
        const tA = a[1][0].edition.tier, tB = b[1][0].edition.tier;
        return tierWeight(tB) - tierWeight(tA);
      })) {
        const ed = arr[0].edition;
        const heroFlowId = arr[0].flowId;
        const card = mkEl('div', { className: 'moment-card' });
        const img = mkEl('div', { className: 'moment-card-img' });
        if (heroFlowId) {
          img.style.backgroundImage = `url("${mediaUrl(heroFlowId, 'hero', { width: 240, format: 'webp', quality: 75 })}")`;
        }
        card.appendChild(img);
        const tierBadge = mkEl('div', { className: `moment-card-tier tier-${tierKey(ed.tier)}`, text: tierLabel(ed.tier) });
        card.appendChild(tierBadge);
        const body = mkEl('div', { className: 'moment-card-body' });
        body.appendChild(mkEl('div', { className: 'moment-card-name', text: ed.set?.flowName || 'Moment' }));
        const serials = arr.slice(0, 5).map(h => `#${h.serial}`).join(', ');
        body.appendChild(mkEl('div', { className: 'moment-card-serials', text: arr.length > 5 ? `${serials}, +${arr.length - 5}` : serials }));
        card.appendChild(body);
        card.addEventListener('click', () => {
          const mNode = currentData?.nodes.find(nn => nn.id === 'moment:' + ek);
          if (mNode) openMomentDrawer(mNode);
        });
        grid.appendChild(card);
      }
      section.appendChild(grid);
      drawerInner.appendChild(section);
    }

    // Actions
    const actions = mkEl('div', { className: 'detail-actions', style: 'margin-top: 14px;' });

    // Explicit commit — "Visit their universe →" — only navigating on button press
    if (n.flowAddress) {
      const visitBtn = mkEl('button', { className: 'btn-sm btn-primary', text: 'Visit their universe →' });
      visitBtn.style.cssText += 'background: linear-gradient(135deg, #14d8c4, #5b6fff); color: #05060c; font-weight: 800; border: none;';
      visitBtn.addEventListener('click', () => {
        window.fandomRouter.go('collector', { addr: n.flowAddress });
      });
      actions.appendChild(visitBtn);
    }

    // Share your universe link
    const shareUrl = `${window.location.origin}${window.location.pathname}?player=${encodeURIComponent(currentPlayer)}&spotlight=${encodeURIComponent(n.flowAddress || n.dapperID || n.username)}`;
    const shareBtn = mkEl('button', { className: 'btn-sm', text: 'Copy share link' });
    shareBtn.dataset.copy = shareUrl;
    actions.appendChild(shareBtn);
    if (n.flowAddress) {
      actions.appendChild(mkEl('a', { className: 'btn-sm', text: 'Flowscan ↗', href: `https://www.flowscan.io/account/0x${n.flowAddress.replace(/^0x/, '')}`, target: '_blank', rel: 'noopener' }));
    }
    if (n.username) {
      actions.appendChild(mkEl('a', { className: 'btn-sm', text: `@${n.username} on Top Shot ↗`, href: `https://nbatopshot.com/user/@${n.username}`, target: '_blank', rel: 'noopener' }));
    }
    drawerInner.appendChild(actions);

    drawer.classList.add('open');
  }

  // Serial-bead preview. Single click shows a small floating card with owner info
  // + "Visit owner →" commit button. Misclick closes the card, user stays at L3.
  function showSerialPreview(node) {
    // Find the owner record on this player for richer context
    const p = data.players.find(x => x.name === currentPlayer);
    const owner = p?.owners.find(o => o.flowAddress === node.ownerAddr);
    const ownerName = owner?.username || (node.ownerAddr ? shortAddr(node.ownerAddr) : '—');

    // Remove any prior preview
    const prior = document.getElementById('serial-preview');
    if (prior) prior.remove();

    const el = document.createElement('div');
    el.id = 'serial-preview';
    el.style.cssText = [
      'position: fixed', 'z-index: 120', 'top: 50%', 'left: 50%',
      'transform: translate(-50%, -50%)', 'background: rgba(5,6,12,0.95)',
      'backdrop-filter: blur(16px)', '-webkit-backdrop-filter: blur(16px)',
      'border: 1px solid rgba(20,216,196,0.42)', 'border-radius: 12px',
      'padding: 22px 26px', 'min-width: 320px', 'max-width: 420px',
      'box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 60px rgba(20,216,196,0.15)',
      'color: #f0f2fd', 'font-family: inherit'
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-family: Sofia Sans Extra Condensed, sans-serif; font-weight: 900; font-size: 22px; text-transform: uppercase; letter-spacing: 0.02em; margin-bottom: 4px;';
    title.textContent = `Serial #${node.serial}`;
    el.appendChild(title);

    const eyebrow = document.createElement('div');
    eyebrow.style.cssText = 'font-size: 10px; color: rgba(240,242,253,0.55); text-transform: uppercase; letter-spacing: 0.14em; margin-bottom: 14px; font-weight: 700;';
    eyebrow.textContent = 'Individual Moment · one of a kind';
    el.appendChild(eyebrow);

    if (owner) {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.08); border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 14px;';
      const avatar = document.createElement('div');
      avatar.style.cssText = 'width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; background-size: cover; background-position: center; border: 2px solid #f5b840; background: linear-gradient(135deg, #14d8c4, #5b6fff); display: flex; align-items: center; justify-content: center; font-weight: 900;';
      if (owner.profileImageUrl) {
        avatar.style.backgroundImage = `url("${owner.profileImageUrl.replace(/"/g, '&quot;')}")`;
      } else {
        avatar.textContent = initials(owner.username || '');
      }
      row.appendChild(avatar);
      const ownerInfo = document.createElement('div');
      ownerInfo.style.cssText = 'flex: 1;';
      const ownerName_el = document.createElement('div');
      ownerName_el.style.cssText = 'font-weight: 800; font-size: 15px;';
      ownerName_el.textContent = ownerName;
      ownerInfo.appendChild(ownerName_el);
      const ownerSub = document.createElement('div');
      ownerSub.style.cssText = 'font-size: 11px; color: rgba(240,242,253,0.55); font-family: JetBrains Mono, SF Mono, monospace;';
      ownerSub.textContent = `Holds ${owner.holdings.toLocaleString()} ${currentPlayer} moments`;
      ownerInfo.appendChild(ownerSub);
      row.appendChild(ownerInfo);
      el.appendChild(row);
    } else {
      const noOwner = document.createElement('div');
      noOwner.style.cssText = 'padding: 10px 0; color: rgba(240,242,253,0.6); font-size: 13px;';
      noOwner.textContent = 'Owner information not available for this serial.';
      el.appendChild(noOwner);
    }

    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display: flex; gap: 8px; margin-top: 10px;';

    if (node.ownerAddr) {
      const visitBtn = document.createElement('button');
      visitBtn.style.cssText = 'flex: 1; padding: 12px 16px; background: linear-gradient(135deg, #14d8c4, #5b6fff); color: #05060c; border: none; border-radius: 8px; font-family: Sofia Sans Extra Condensed, sans-serif; font-weight: 900; font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; cursor: pointer;';
      visitBtn.textContent = 'Visit owner →';
      visitBtn.addEventListener('click', () => {
        el.remove();
        window.fandomRouter.go('collector', { addr: node.ownerAddr });
      });
      actionRow.appendChild(visitBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'padding: 12px 16px; background: rgba(255,255,255,0.06); color: #f0f2fd; border: 1px solid rgba(255,255,255,0.14); border-radius: 8px; font-family: inherit; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; cursor: pointer;';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => el.remove());
    actionRow.appendChild(closeBtn);

    el.appendChild(actionRow);
    document.body.appendChild(el);

    // Dismiss on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') {
        el.remove();
        window.removeEventListener('keydown', onKey);
      }
    };
    window.addEventListener('keydown', onKey);

    // Dismiss on click outside
    setTimeout(() => {
      const onOutside = (e) => {
        if (!el.contains(e.target)) {
          el.remove();
          document.removeEventListener('click', onOutside);
          window.removeEventListener('keydown', onKey);
        }
      };
      document.addEventListener('click', onOutside);
    }, 50);
  }


  function openMomentDrawer(n) {
    const e = n.edition;
    clearDrawer();
    drawerInner.appendChild(mkEl('div', { className: 'eyebrow', text: `Moment · ${tierLabel(n.tier)}` }));
    drawerInner.appendChild(mkEl('h3', { text: e.set?.flowName || 'Moment' }));
    drawerInner.appendChild(mkEl('div', { className: 'sub', text: `Series ${e.set?.flowSeriesNumber || '?'} · Circulation of ${(e.edition?.circulationCount || 0).toLocaleString()}` }));

    if (n.heroUrl) {
      const hero = mkEl('img', { src: n.heroUrl, alt: '', style: 'width:100%; border-radius:10px; margin:12px 0 16px; display:block; border:1px solid rgba(255,255,255,0.08);' });
      drawerInner.appendChild(hero);
    }
    const playDesc = e.play?.description || '';
    if (playDesc) {
      drawerInner.appendChild(mkEl('div', { text: playDesc, style: 'font-size:13px; line-height:1.55; color:var(--fg-muted); margin-bottom:16px; padding:12px 14px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:6px;' }));
    }

    // Top holders of this edition (from in-graph data)
    const holderCounts = new Map();
    for (const link of currentData.links) {
      if (link.kind !== 'collector-moment') continue;
      const target = typeof link.target === 'object' ? link.target.id : link.target;
      if (target !== n.id) continue;
      const src = typeof link.source === 'object' ? link.source : currentData.nodes.find(x => x.id === link.source);
      if (!src) continue;
      holderCounts.set(src.id, (holderCounts.get(src.id) || 0) + 1);
    }
    const topHolders = [...holderCounts.entries()]
      .map(([nodeId, count]) => ({ node: currentData.nodes.find(x => x.id === nodeId), count }))
      .filter(x => x.node)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    if (topHolders.length) {
      const sec = mkEl('div', { className: 'drawer-section' });
      sec.appendChild(mkEl('h4', { text: 'Top holders of this edition · in graph' }));
      const list = mkEl('div', { className: 'owner-list' });
      for (const h of topHolders) {
        const row = mkEl('div', { className: 'owner-row' });
        row.style.cursor = 'pointer';
        const addrSp = mkEl('span', { className: 'addr' });
        addrSp.textContent = `#${h.node.globalRank} · ${h.node.name}`;
        if (h.node.isTop10) addrSp.appendChild(mkEl('span', { className: 'tier-b', text: 'Inner', style: 'margin-left:6px; background:rgba(245,184,64,0.14); border-color:rgba(245,184,64,0.3); color:#f5b840;' }));
        if (h.node.crossPlayerFan) addrSp.appendChild(mkEl('span', { className: 'tier-b', text: `${h.node.crossPlayerCount}-player`, style: 'margin-left:6px; background:rgba(255,154,74,0.14); border-color:rgba(255,154,74,0.3); color:#ff9a4a;' }));
        row.appendChild(addrSp);
        row.appendChild(mkEl('span', { className: 'count', text: `${h.count} serial${h.count === 1 ? '' : 's'}` }));
        row.addEventListener('click', () => openCollectorDrawer(h.node));
        list.appendChild(row);
      }
      sec.appendChild(list);
      drawerInner.appendChild(sec);
    }

    drawer.classList.add('open');
  }

  function openPlayerDrawer(n) {
    const p = data.players.find(x => x.name === n.name);
    clearDrawer();
    drawerInner.appendChild(mkEl('div', { className: 'eyebrow', text: 'Player' }));
    drawerInner.appendChild(mkEl('h3', { text: p.name }));
    drawerInner.appendChild(mkEl('div', { className: 'sub', text: p.team }));

    const rarRow = mkEl('div', { className: 'rar-row' });
    const sp1 = document.createElement('span');
    sp1.innerHTML = `<strong>${p.editions.length}</strong> unique editions`;
    rarRow.appendChild(sp1);
    const sp2 = document.createElement('span');
    sp2.innerHTML = `<strong>${p.totalMintedMomentCount.toLocaleString()}</strong> serials minted`;
    rarRow.appendChild(sp2);
    const sp3 = document.createElement('span');
    sp3.innerHTML = `<strong>${p.owners.length.toLocaleString()}</strong> unique holders`;
    rarRow.appendChild(sp3);
    drawerInner.appendChild(rarRow);

    const sec = mkEl('div', { className: 'drawer-section' });
    sec.appendChild(mkEl('h4', { text: 'All editions' }));
    const list = mkEl('div', { className: 'holdings-list' });
    for (const e of p.editions) {
      const row = mkEl('div', { className: 'holding-row', style: 'cursor:pointer;' });
      const left = document.createElement('span');
      left.innerHTML = `<span class="play">${esc(e.set?.flowName || 'Moment')}</span><br/><span style="font-size:11px; color:var(--fg-muted); text-transform:uppercase; letter-spacing:0.08em;">${esc(tierLabel(e.tier))} · Series ${esc(e.set?.flowSeriesNumber || '?')}</span>`;
      row.appendChild(left);
      const right = document.createElement('span');
      right.innerHTML = `<span class="serial">${(e.edition?.circulationCount || 0).toLocaleString()}</span>`;
      row.appendChild(right);
      const mNode = currentData?.nodes.find(nn => nn.id === 'moment:' + e.editionKey);
      if (mNode) row.addEventListener('click', () => openMomentDrawer(mNode));
      list.appendChild(row);
    }
    sec.appendChild(list);
    drawerInner.appendChild(sec);

    drawer.classList.add('open');
  }

  // ======================= Spotlight mode =======================
  function activateSpotlight(ownerId) {
    if (!currentData || !ownerId) return;
    // Resolve DOM once; bail silently if the overlay isn't present (defensive).
    const overlay = document.getElementById('spotlight-overlay');
    const unameEl = document.getElementById('spotlight-username');
    const statsEl = document.getElementById('spotlight-stats');
    const shareBtn = document.getElementById('spotlight-share');
    const dismissBtn = document.getElementById('spotlight-dismiss');
    if (!overlay || !unameEl || !statsEl) return;

    const p = currentData.player || data.players.find(x => x.name === currentPlayer);
    if (!p) return;

    // Privacy-first analytics (spec-003 Task 8): carry ONLY the numeric playerId + a
    // boolean spotlight flag. Never the flowAddress, dapperID, or username — those stay
    // in the browser. (The address arrives as `ownerId` but is never sent outbound.)
    if (typeof window.plausible === 'function' && p && p.playerId) {
      window.plausible('deep_link_spotlight', { props: { player_id: String(p.playerId), spotlight: true } });
    }
    // Match by flowAddress, dapperID, or username — same key set the router emits.
    const matchIn = (list) => (list || []).find(x =>
      x.flowAddress === ownerId || x.dapperID === ownerId || x.username === ownerId
    );

    // Full node (top-200 rendered with sprites + click handlers).
    const o = matchIn(currentData.ownerArr);
    // Raw owner entry from the full dataset — used to compute a true rank even
    // when the collector is outside the top-200 rendered in detail.
    const rawOwner = matchIn(p.owners);

    // Share URL — round-trips the original spotlight param exactly as it entered,
    // so a deep-link shared from any source re-opens the same overlay.
    const shareUrl = `${window.location.origin}${window.location.pathname}?player=${encodeURIComponent(currentPlayer)}&spotlight=${encodeURIComponent(ownerId)}`;

    // ---- Case A: collector is inside the top-200 full nodes ----
    if (o) {
      unameEl.textContent = o.name;
      const lockedScore = o.lockedScore;
      const lockedStats = lockedScore !== null && lockedScore >= 0
        ? `locked score of <strong>${fmtLockedScore(lockedScore)}</strong> — ranked <strong>#${o.globalRank}</strong> among loaded ${currentPlayer} holders`
        : `You own <strong>${o.fullHoldings.toLocaleString()}</strong> ${currentPlayer} moments; your locked score is unavailable in this response`;
      statsEl.innerHTML = `Position <strong>#${o.globalRank}</strong> among loaded ${currentPlayer} holders — ${lockedStats}. <br/>${o.pctLabel} · ${o.crossPlayerFan ? `${o.crossPlayerCount}-player fan` : 'Single-player focus'}`;
      overlay.style.display = 'flex';

      if (shareBtn) {
        shareBtn.style.display = '';
        shareBtn.onclick = () => {
          navigator.clipboard.writeText(shareUrl);
          shareBtn.textContent = 'Copied ✓';
          setTimeout(() => { shareBtn.textContent = 'Copy my universe link'; }, 1500);
        };
      }

      if (dismissBtn) {
        dismissBtn.style.display = '';
        dismissBtn.textContent = 'Enter the graph';
        dismissBtn.onclick = () => {
          overlay.style.display = 'none';
          // Fly camera to their node, then open the collector drawer.
          const node = currentData.nodes.find(n => n.id === o.id);
          if (node && Graph) {
            setTimeout(() => {
              const distance = 100;
              const distRatio = 1 + distance / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
              Graph.cameraPosition({ x: (node.x || 1) * distRatio, y: (node.y || 1) * distRatio, z: (node.z || 1) * distRatio }, node, 1800);
              openCollectorDrawer(o);
            }, 200);
          } else {
            openCollectorDrawer(o);
          }
        };
      }
      return;
    }

    // ---- Case B: collector exists in the dataset but is outside the top-200 ----
    // The graph still loaded; we just can't fly to a specific node. Show a graceful
    // message with their true rank and the universe size. No crash.
    if (rawOwner) {
      // __rank is assigned by buildGraph's rankedOwners.forEach; compute a fallback
      // rank if it's missing (e.g. if buildGraph was bypassed).
      const trueRank = rawOwner.__rank || (p.owners.findIndex(x => x === rawOwner) + 1) || null;
      const totalCollectors = currentData.coverage ? currentData.coverage.M : p.owners.length;
      unameEl.textContent = rawOwner.username || shortAddr(rawOwner.flowAddress);
      const rankFragment = trueRank ? `You're <strong>#${trueRank}</strong> — ` : '';
      statsEl.innerHTML = `${rankFragment}outside the top 200 shown in detail, but part of the universe of <strong>${totalCollectors.toLocaleString()}</strong> collectors. <br/>Hold <strong>${(rawOwner.holdings || 0).toLocaleString()}</strong> ${currentPlayer} serials. The full universe loads below — pan and zoom to find your place in it.`;
      overlay.style.display = 'flex';

      if (shareBtn) {
        shareBtn.style.display = '';
        shareBtn.onclick = () => {
          navigator.clipboard.writeText(shareUrl);
          shareBtn.textContent = 'Copied ✓';
          setTimeout(() => { shareBtn.textContent = 'Copy my universe link'; }, 1500);
        };
      }

      if (dismissBtn) {
        dismissBtn.style.display = '';
        dismissBtn.textContent = 'Enter the graph';
        dismissBtn.onclick = () => { overlay.style.display = 'none'; };
      }
      return;
    }

    // ---- Case C: spotlight param matches nothing in the dataset ----
    // Don't crash; show a minimal graceful state and let the user dismiss into the graph.
    unameEl.textContent = shortAddr(ownerId);
    statsEl.innerHTML = `We couldn't find this collector in the ${currentPlayer} universe, but the graph is yours to explore below.`;
    overlay.style.display = 'flex';
    if (shareBtn) shareBtn.style.display = 'none';
    if (dismissBtn) {
      dismissBtn.style.display = '';
      dismissBtn.textContent = 'Enter the graph';
      dismissBtn.onclick = () => { overlay.style.display = 'none'; };
    }
  }

  // ======================= Collector spotlight (graph-level emphasis) =======================
  // Click a collector → fade everything except them + the editions they own + the player center,
  // and surface a "owns X of Y · N%" stat. ESC, the back button, or clicking the badge clears.
  let _spotlitAddr = null;

  function _setObjectOpacity(obj, opacity) {
    if (!obj) return;
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) { m.transparent = true; m.opacity = opacity; }
    }
    if (obj.children && obj.children.length) {
      for (const c of obj.children) _setObjectOpacity(c, opacity);
    }
  }

  function _ownedEditionKeys(player, addr) {
    const keys = new Set();
    if (!player || !addr) return keys;
    for (const ed of player.editions || []) {
      const samples = ed.serialsSampled || [];
      if (samples.some(s => s.ownerFlowAddress === addr)) keys.add(ed.editionKey);
    }
    return keys;
  }

  function enterCollectorSpotlight(node) {
    if (!node || !Graph || !currentData) return;
    const addr = node.flowAddress;
    if (!addr) return;
    _spotlitAddr = addr;

    const player = data.players.find(x => x.name === currentPlayer);
    if (!player) return;
    const ownedKeys = _ownedEditionKeys(player, addr);

    // HIDE non-relevant nodes entirely (visibility=false) instead of fading. Bloom adds
    // glow to anything with non-zero alpha, so 2K faded collectors still wash the screen.
    Graph.nodeVisibility(n => {
      if (!_spotlitAddr) return true;
      if (n.type === 'collector') return n.flowAddress === _spotlitAddr;
      // Editions stay visible — both owned (bright) and unowned (dimmed via opacity)
      // Player center, team logos, etc. stay visible too
      return true;
    });

    // Hide all links except those touching the spotlit collector or their owned editions
    Graph.linkVisibility(l => {
      if (!_spotlitAddr) return true;
      const src = typeof l.source === 'object' ? l.source : null;
      const tgt = typeof l.target === 'object' ? l.target : null;
      const involves = (n) => n && (
        (n.type === 'collector' && n.flowAddress === _spotlitAddr) ||
        ((n.type === 'moment' || n.type === 'edition-center') && ownedKeys.has(n.editionKey))
      );
      return involves(src) || involves(tgt);
    });

    // Material opacity tweak: dim the UNOWNED editions so user can see what's missing,
    // keep owned editions and the spotlit collector at full opacity.
    const { nodes } = Graph.graphData();
    for (const n of nodes) {
      const obj = n.__threeObj;
      if (!obj) continue;
      let op;
      if (n.type === 'collector') {
        op = 1.0; // either spotlit (visible) or hidden — set to 1
      } else if (n.type === 'moment' || n.type === 'edition-center') {
        op = ownedKeys.has(n.editionKey) ? 1.0 : 0.18;
      } else {
        op = 0.85;
      }
      _setObjectOpacity(obj, op);
    }

    // Refresh particle display now that visibility changed
    Graph.refresh && Graph.refresh();

    _showSpotlightStat(node.name || addr.slice(0, 8), ownedKeys.size, (player.editions || []).length, player.partial === true);

    // Epic moment: shoot a beam of light from the player center to this collector
    try { _spawnBeamToCollector(node); } catch (e) {}

    // 100% completion = take-over-the-screen champion ceremony
    if (player.partial !== true && ownedKeys.size === (player.editions || []).length && (player.editions || []).length > 0) {
      setTimeout(() => _fullScreenChampionMoment(node.name || addr.slice(0, 8), (player.editions || []).length), 600);
    }
  }

  function clearCollectorSpotlight() {
    if (!_spotlitAddr) return;
    _spotlitAddr = null;
    if (!Graph) return;
    const { nodes } = Graph.graphData();
    for (const n of nodes) {
      if (n.__threeObj) _setObjectOpacity(n.__threeObj, 1.0);
    }
    // Restore visibility + opacity defaults
    Graph.nodeVisibility(true);
    Graph.linkVisibility(true);
    Graph.linkOpacity(0.55);
    Graph.refresh && Graph.refresh();
    _hideSpotlightStat();
  }

  function _showSpotlightStat(name, owned, total, partial) {
    let el = document.getElementById('spotlight-stat');
    if (!el) {
      el = document.createElement('div');
      el.id = 'spotlight-stat';
      el.style.cssText = 'position:absolute; top:18px; left:50%; transform:translateX(-50%); z-index:10; padding:14px 22px; background:rgba(0,0,0,0.85); backdrop-filter:blur(14px); border:1px solid var(--accent-teal); border-radius:999px; color:var(--accent-teal); font-family:var(--mono); font-size:13px; box-shadow:0 4px 24px rgba(20,216,196,0.4); cursor:pointer; user-select:none; transition:all 0.18s ease;';
      el.title = 'Click to clear spotlight (or press ESC)';
      el.addEventListener('click', clearCollectorSpotlight);
      document.querySelector('.graph-area').appendChild(el);
    }
    const pct = total ? (owned / total * 100) : 0;
    const isPerfect = owned === total && total > 0;
    const accent = isPerfect ? '#f5b840' : '#14d8c4';
    // Build content with safe DOM methods (no innerHTML — name field is from data but apply XSS hygiene)
    while (el.firstChild) el.removeChild(el.firstChild);
    const mkSpan = (txt, css) => { const s = document.createElement('span'); s.textContent = txt; if (css) s.style.cssText = css; return s; };
    const mkStrong = (txt, css) => { const s = document.createElement('strong'); s.textContent = txt; if (css) s.style.cssText = css; return s; };
    el.appendChild(mkStrong(String(name), 'color:#fff; font-family:var(--hdr); font-size:14px; font-weight:900; text-transform:uppercase; letter-spacing:0.04em;'));
    el.appendChild(mkSpan(' · ', 'color:rgba(240,242,253,0.5); margin:0 8px;'));
    el.appendChild(mkSpan('observed in '));
    el.appendChild(mkStrong(String(owned), `color:${accent};`));
    el.appendChild(mkSpan(' of ', 'color:rgba(240,242,253,0.5);'));
    el.appendChild(mkStrong(String(total), 'color:#fff;'));
    el.appendChild(mkSpan(partial ? ' editions · partial dataset' : ' editions', 'color:rgba(240,242,253,0.5);'));
    el.appendChild(mkSpan(' · ', 'color:rgba(240,242,253,0.5); margin:0 8px;'));
    const pctStr = pct.toFixed(pct === Math.floor(pct) ? 0 : 1) + '%';
    el.appendChild(mkStrong(pctStr, `color:${accent}; font-size:15px;`));
    if (isPerfect) el.appendChild(mkSpan(' 🏆', 'font-size:18px; line-height:1; margin-left:6px;'));
    el.appendChild(mkSpan(' click to clear', 'color:rgba(240,242,253,0.4); margin-left:14px; font-size:11px;'));
    el.style.borderColor = accent;
    el.style.color = accent;
    el.style.boxShadow = `0 4px 28px ${accent}55`;
    el.style.display = 'block';
  }

  function _hideSpotlightStat() {
    const el = document.getElementById('spotlight-stat');
    if (el) el.style.display = 'none';
  }

  // ======================= Idle auto-rotate (ambient cinema) =======================
  // After 8s of no user input, slowly auto-orbit via OrbitControls. Any input cancels.
  let _idleTimer = null;
  function scheduleIdleAutoRotate() {
    cancelIdleAutoRotate();
    _idleTimer = setTimeout(() => {
      if (!document.body.classList.contains('viewing-player')) return;
      if (typeof Graph.controls !== 'function') return;
      const c = Graph.controls();
      if (!c) return;
      c.autoRotate = true;
      c.autoRotateSpeed = 0.3; // very slow ambient drift
      c.target.set(0, 0, 0);
    }, 8000);
  }
  function cancelIdleAutoRotate() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    if (typeof Graph.controls === 'function') {
      const c = Graph.controls();
      if (c) c.autoRotate = false;
    }
  }
  // Any pointer/key input cancels idle spin and re-arms the timer
  ['pointerdown', 'wheel', 'keydown', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, () => {
      cancelIdleAutoRotate();
      if (document.body.classList.contains('viewing-player')) scheduleIdleAutoRotate();
    }, { passive: true });
  });

  // ======================= Beam-of-light reveal on collector spotlight =======================
  // When a collector is spotlit, pulse a beam from the player center to that collector.
  // Pure visual — Three.js LineSegments with additive material, fades out after 1.2s.
  function _spawnBeamToCollector(node) {
    if (!Graph) return;
    const scene = Graph.scene && Graph.scene();
    if (!scene || !node) return;
    const start = new THREE.Vector3(0, 0, 0);
    const end = new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0);
    if (end.lengthSq() < 0.5) return;
    const geom = new THREE.BufferGeometry().setFromPoints([start, end]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffd96b, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, linewidth: 4 });
    const line = new THREE.Line(geom, mat);
    scene.add(line);
    // Also add an animated pulse sphere riding the beam
    const pulseGeom = new THREE.SphereGeometry(6, 12, 12);
    const pulseMat = new THREE.MeshBasicMaterial({ color: 0xffe18a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending });
    const pulse = new THREE.Mesh(pulseGeom, pulseMat);
    scene.add(pulse);
    const t0 = performance.now();
    const dur = 1100;
    function anim(now) {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 2);
      pulse.position.set(start.x + (end.x - start.x) * e, start.y + (end.y - start.y) * e, start.z + (end.z - start.z) * e);
      pulse.scale.setScalar(1 + 1.2 * (1 - t));
      mat.opacity = 1 - t;
      pulseMat.opacity = 0.95 * (1 - t);
      if (t < 1) requestAnimationFrame(anim);
      else { scene.remove(line); scene.remove(pulse); geom.dispose(); mat.dispose(); pulseGeom.dispose(); pulseMat.dispose(); }
    }
    requestAnimationFrame(anim);
  }

  // ======================= 100% completion — full-screen 🏆 ceremony =======================
  // When a collector spotlight reveals 100% completion, take over the screen briefly.
  function _fullScreenChampionMoment(name, total) {
    if (document.getElementById('champion-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'champion-overlay';
    ov.style.cssText = 'position:fixed; inset:0; z-index:9999; display:flex; flex-direction:column; align-items:center; justify-content:center; background:radial-gradient(ellipse at center, rgba(245,184,64,0.18) 0%, rgba(0,0,0,0.92) 70%); backdrop-filter: blur(8px); animation: fadein 0.4s ease-out; cursor: pointer;';
    const trophy = document.createElement('div');
    trophy.textContent = '🏆';
    trophy.style.cssText = 'font-size: clamp(120px, 20vw, 220px); line-height: 1; filter: drop-shadow(0 0 40px rgba(245,184,64,0.7)); animation: trophy-bounce 1.2s cubic-bezier(0.34, 1.56, 0.64, 1);';
    const label = document.createElement('div');
    label.textContent = 'COMPLETE UNIVERSE';
    label.style.cssText = 'font-family: "Sofia Sans Extra Condensed", sans-serif; font-weight: 900; font-size: clamp(36px, 5vw, 64px); text-transform: uppercase; letter-spacing: 0.06em; color: #f5b840; margin-top: 24px; text-shadow: 0 4px 32px rgba(245,184,64,0.55);';
    const sub = document.createElement('div');
    sub.textContent = `${name} owns all ${total} editions`;
    sub.style.cssText = 'font-family: "JetBrains Mono", monospace; font-size: 16px; color: rgba(255,255,255,0.8); margin-top: 12px; letter-spacing: 0.04em;';
    const dismiss = document.createElement('div');
    dismiss.textContent = 'click anywhere to continue';
    dismiss.style.cssText = 'font-family: "JetBrains Mono", monospace; font-size: 11px; color: rgba(255,255,255,0.4); margin-top: 32px; letter-spacing: 0.16em; text-transform: uppercase;';
    ov.appendChild(trophy);
    ov.appendChild(label);
    ov.appendChild(sub);
    ov.appendChild(dismiss);
    const styleEl = document.createElement('style');
    styleEl.textContent = '@keyframes fadein {from{opacity:0}to{opacity:1}} @keyframes trophy-bounce {0%{transform:scale(0) rotate(-15deg);opacity:0} 60%{transform:scale(1.1) rotate(5deg);opacity:1} 100%{transform:scale(1) rotate(0)}}';
    ov.appendChild(styleEl);
    ov.addEventListener('click', () => { ov.style.transition = 'opacity 0.3s'; ov.style.opacity = '0'; setTimeout(() => ov.remove(), 300); });
    document.body.appendChild(ov);
    // Auto-dismiss after 6s
    setTimeout(() => { if (ov.parentNode) { ov.style.transition = 'opacity 0.4s'; ov.style.opacity = '0'; setTimeout(() => ov.remove(), 400); } }, 6000);
  }
  window.__fullScreenChampionMoment = _fullScreenChampionMoment;

  // Expose for back-button + ESC handlers + new-player loads to clear stale state.
  window.__clearCollectorSpotlight = clearCollectorSpotlight;
  window.__enterCollectorSpotlight = enterCollectorSpotlight;
  window.__spawnBeamToCollector = _spawnBeamToCollector;

  // Copy buttons
  document.addEventListener('click', e => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      navigator.clipboard.writeText(copyBtn.dataset.copy);
      const orig = copyBtn.textContent;
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = orig; }, 1400);
    }
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (Graph) Graph.cameraPosition({ x: 620, y: 200, z: 1020 }, { x: 0, y: 0, z: 0 }, 1000);
  });
  document.getElementById('btn-spin').addEventListener('click', e => {
    autoRotate = !autoRotate;
    e.target.textContent = autoRotate ? '⏸ Stop rotation' : '◐ Auto-rotate';
    // Use OrbitControls' built-in autoRotate — it gracefully yields to manual
    // input (drag/wheel/touch) without fighting the user. The old manual spin()
    // called cameraPosition every frame which locked out interaction.
    if (typeof Graph.controls !== 'function') return;
    const c = Graph.controls();
    if (!c) return;
    c.autoRotate = autoRotate;
    c.autoRotateSpeed = 0.5; // slow, gentle orbit
    c.target.set(0, 0, 0); // orbit around the player center
  });

  window.addEventListener('resize', () => {
    if (Graph) Graph.width(container.clientWidth).height(container.clientHeight);
  });

  // ======================= L3 Edition view =======================
  function buildEditionGraph(editionKey, playerName) {
    const p = data.players.find(x => x.name === playerName);
    if (!p) return null;
    const e = p.editions.find(ed => ed.editionKey === editionKey);
    if (!e) return null;

    const nodes = [];
    const links = [];

    const mediaFlowId = e.serialsSampled[0]?.flowId;
    const heroUrl = mediaFlowId ? mediaUrl(mediaFlowId, 'hero', { width: 320, format: 'webp', quality: 85 }) : null;
    nodes.push({
      id: 'edition:' + editionKey,
      type: 'edition-center',
      heroUrl,
      setName: e.set?.flowName || 'Moment',
      tier: e.tier,
      circulation: e.edition?.circulationCount || 0,
      val: 48,
      fx: 0, fy: 0, fz: 0
    });

    const holderCounts = new Map();
    const sampleCap = Math.min(200, e.serialsSampled.length);
    const sampled = e.serialsSampled.slice(0, sampleCap);
    for (const s of sampled) {
      if (!s.ownerFlowAddress) continue;
      holderCounts.set(s.ownerFlowAddress, (holderCounts.get(s.ownerFlowAddress) || 0) + 1);
    }

    // Collect all holders, sorted by how many of this edition they hold
    const allHolders = [...holderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([addr, cnt]) => ({ addr, cnt, owner: p.owners.find(o => o.flowAddress === addr) }))
      .filter(h => h.owner);

    const uniqueHolderCount = allHolders.length;

    // Tiered cap: show up to 30 holders distributed across three rings.
    // If the edition has fewer holders, scale the visual size up so they feel present.
    const topHolders = allHolders.slice(0, 3);           // gold tier (inner)
    const nextHolders = allHolders.slice(3, 10);         // teal tier (middle)
    const outerHolders = allHolders.slice(10, 30);       // silver tier (outer)

    // Sparse-scaling multiplier — when there are few holders, everything gets bigger
    const holderScale = uniqueHolderCount <= 5 ? 2.0
                      : uniqueHolderCount <= 15 ? 1.55
                      : uniqueHolderCount <= 40 ? 1.2
                      : 1.0;

    // At L3 the rank shown is scoped to THIS moment (rank 1 = holds most of these serials).
    // playerRank is preserved on the node for drawer context.
    const GOLD_RADIUS = 165;
    topHolders.forEach((h, i) => {
      const angle = (i / Math.max(1, topHolders.length)) * Math.PI * 2 - Math.PI / 2;
      const playerRank = p.owners.findIndex(o => o.flowAddress === h.addr) + 1;
      const editionRank = i + 1;
      const crossCnt = crossPlayerCount(h.owner);
      nodes.push({
        id: 'holder:' + h.addr,
        type: 'collector',
        name: h.owner.username || shortAddr(h.addr),
        username: h.owner.username,
        flowAddress: h.addr,
        dapperID: h.owner.dapperID,
        profileImageUrl: h.owner.profileImageUrl,
        globalRank: editionRank,
        playerRank,
        editionHoldings: h.cnt,
        fullHoldings: h.owner.holdings,
        holdings: h.cnt,
        momentsOwned: [],
        isTop10: true,
        tier: 'gold',
        crossPlayerFan: crossCnt > 1,
        crossPlayerCount: crossCnt,
        pctLabel: `holds ${h.cnt}`,
        color: '#f5b840',
        val: 7 * holderScale,
        fx: Math.cos(angle) * GOLD_RADIUS,
        fy: Math.sin(angle) * 28,
        fz: Math.sin(angle) * GOLD_RADIUS
      });
    });

    const TEAL_RADIUS = 240;
    nextHolders.forEach((h, i) => {
      const angle = (i / Math.max(1, nextHolders.length)) * Math.PI * 2 + Math.PI / 4;
      const playerRank = p.owners.findIndex(o => o.flowAddress === h.addr) + 1;
      const editionRank = topHolders.length + i + 1;
      const crossCnt = crossPlayerCount(h.owner);
      nodes.push({
        id: 'holder:' + h.addr,
        type: 'collector',
        name: h.owner.username || shortAddr(h.addr),
        username: h.owner.username,
        flowAddress: h.addr,
        dapperID: h.owner.dapperID,
        profileImageUrl: h.owner.profileImageUrl,
        globalRank: editionRank,
        playerRank,
        editionHoldings: h.cnt,
        fullHoldings: h.owner.holdings,
        holdings: h.cnt,
        momentsOwned: [],
        isTop10: false,
        tier: 'teal',
        crossPlayerFan: crossCnt > 1,
        crossPlayerCount: crossCnt,
        pctLabel: `holds ${h.cnt}`,
        color: '#14d8c4',
        val: 5 * holderScale,
        fx: Math.cos(angle) * TEAL_RADIUS,
        fy: Math.sin(angle * 2) * 22,
        fz: Math.sin(angle) * TEAL_RADIUS
      });
    });

    // Silver tier — ranks 11–30, third outer ring
    const SILVER_RADIUS = 340;
    outerHolders.forEach((h, i) => {
      const angle = (i / Math.max(1, outerHolders.length)) * Math.PI * 2 + Math.PI / 3;
      const playerRank = p.owners.findIndex(o => o.flowAddress === h.addr) + 1;
      const editionRank = topHolders.length + nextHolders.length + i + 1;
      const crossCnt = crossPlayerCount(h.owner);
      nodes.push({
        id: 'holder:' + h.addr,
        type: 'collector',
        name: h.owner.username || shortAddr(h.addr),
        username: h.owner.username,
        flowAddress: h.addr,
        dapperID: h.owner.dapperID,
        profileImageUrl: h.owner.profileImageUrl,
        globalRank: editionRank,
        playerRank,
        editionHoldings: h.cnt,
        fullHoldings: h.owner.holdings,
        holdings: h.cnt,
        momentsOwned: [],
        isTop10: false,
        tier: 'silver',
        crossPlayerFan: crossCnt > 1,
        crossPlayerCount: crossCnt,
        pctLabel: `holds ${h.cnt}`,
        color: '#d4d4d9',
        val: 3.2 * holderScale,
        fx: Math.cos(angle) * SILVER_RADIUS,
        fy: Math.sin(angle * 3) * 16,
        fz: Math.sin(angle) * SILVER_RADIUS
      });
    });

    // Preserve the union-of-visible-holders for serial-to-holder linking below
    const topHoldersForLinks = [...topHolders, ...nextHolders, ...outerHolders];

    const BEAD_RADIUS = 90;
    const editionColor = tierColor(e.tier);
    const topAddrs = new Set(topHoldersForLinks.map(h => h.addr));
    sampled.forEach((s, i) => {
      const angle = (i / sampled.length) * Math.PI * 2;
      const y = Math.sin(angle * 3) * 10;
      nodes.push({
        id: 'serial:' + s.flowId,
        type: 'serial-bead',
        serial: s.serial,
        flowId: s.flowId,
        ownerAddr: s.ownerFlowAddress,
        color: editionColor,
        isUserOwned: false,
        val: 1.2,
        fx: Math.cos(angle) * BEAD_RADIUS,
        fy: y,
        fz: Math.sin(angle) * BEAD_RADIUS
      });
      if (s.ownerFlowAddress && topAddrs.has(s.ownerFlowAddress)) {
        links.push({
          source: 'holder:' + s.ownerFlowAddress,
          target: 'serial:' + s.flowId,
          kind: 'holder-serial',
          value: 0.4
        });
      }
    });

    return {
      nodes, links,
      player: p, edition: e,
      topHolders,
      visibleHolders: topHolders.length + nextHolders.length + outerHolders.length,
      stats: {
        circulation: e.edition?.circulationCount || 0,
        sampled: sampled.length,
        uniqueHolders: holderCounts.size,
        topHolder: topHolders[0] || null
      }
    };
  }

  function showEditionView(editionKey, playerName) {
    const eg = buildEditionGraph(editionKey, playerName);
    if (!eg) { console.warn('[edition] not found', editionKey); return; }
    currentPlayer = playerName;
    currentData = Object.assign({}, eg, { ownerArr: [], editionNodes: new Map() });

    document.getElementById('graph-empty').style.display = 'none';
    document.getElementById('graph-legend').style.display = 'block';
    document.getElementById('graph-meta').style.display = 'block';
    document.getElementById('graph-controls').style.display = 'flex';
    document.getElementById('graph-hint').style.display = 'block';
    document.getElementById('leaderboard').style.display = 'none';

    document.getElementById('gm-player').textContent = eg.edition.set?.flowName || 'Edition';
    document.getElementById('gm-moments').textContent = tierLabel(eg.edition.tier);
    document.getElementById('gm-collectors').textContent = eg.stats.uniqueHolders.toString();
    const topLabel = eg.stats.topHolder ? (eg.stats.topHolder.owner.username || shortAddr(eg.stats.topHolder.addr)) : '—';
    document.getElementById('gm-top10').textContent = topLabel;
    document.getElementById('gm-serials').textContent = eg.stats.circulation.toLocaleString();

    // Subtitle surfaces total unique holders + how many are visible in the ring
    const setLbl = (eg.edition.set?.flowName || 'Edition').toUpperCase();
    const tierLbl = tierLabel(eg.edition.tier).toUpperCase();
    const circ = (eg.edition.edition?.circulationCount || 0).toLocaleString();
    const estVal = fmtUSDShort(tierUnitValue(eg.edition.tier) * (eg.edition.edition?.circulationCount || 0));
    const totalHolders = eg.stats.uniqueHolders;
    const visibleCount = eg.visibleHolders || 0;
    const holderTag = totalHolders <= visibleCount
      ? `${totalHolders} HOLDERS — ALL SHOWN`
      : `${totalHolders} UNIQUE HOLDERS — TOP ${visibleCount} SHOWN BY COUNT`;
    typeLevelSubtitle(`${setLbl} · ${tierLbl} · ${circ} MINTED · EST ${estVal} · ${holderTag}`);

    const g = ensureGraph();
    g.graphData({ nodes: eg.nodes, links: eg.links });

    setTimeout(() => {
      // Pull camera back when the silver ring is populated (radius 340)
      const hasSilver = (eg.visibleHolders || 0) > 10;
      const camZ = hasSilver ? 520 : 260;
      g.cameraPosition({ x: 0, y: hasSilver ? 140 : 60, z: camZ }, { x: 0, y: 0, z: 0 }, 1500);
    }, 50);
  }


  // ======================= L4 Collector-Universe view =======================
  // Normalize a Flow address param (strip 0x prefix, lowercase, defensive trim).
  function normalizeFlowAddr(a) { return (a || '').replace(/^0x/i, '').toLowerCase().trim(); }

  // Build the L4 collector graph: collector center + inner ring of players-collected + outer ring of top moments + faint outer hint particles.
  function buildCollectorGraph(addr) {
    const key = normalizeFlowAddr(addr);
    const perPlayer = []; // { player, holdings, teamColors, ownerRecord, momentsOwned[] }
    let primaryOwner = null;
    for (const p of data.players) {
      const o = p.owners.find(x => normalizeFlowAddr(x.flowAddress) === key);
      if (!o || !o.holdings || o.holdings <= 0) continue;
      if (!primaryOwner || (o.username && !primaryOwner.username) || (o.profileImageUrl && !primaryOwner.profileImageUrl)) {
        primaryOwner = o;
      }
      const momentsOwned = [];
      for (const e of p.editions) {
        for (const s of (e.serialsSampled || [])) {
          const ownerField = s.ownerFlowAddress || s.ownerAddress || '';
          if (normalizeFlowAddr(ownerField) === key) {
            momentsOwned.push({ flowId: s.flowId, serialNumber: s.serial || s.serialNumber, edition: e, editionKey: e.editionKey, playerName: p.name, teamColors: p.teamColors });
          }
        }
      }
      perPlayer.push({
        player: p, playerName: p.name, holdings: o.holdings,
        teamColors: p.teamColors, username: o.username, avatar: o.profileImageUrl,
        momentsOwned
      });
    }
    perPlayer.sort((a, b) => b.holdings - a.holdings);
    const nodes = [];
    const links = [];
    const totalHoldings = perPlayer.reduce((a, x) => a + x.holdings, 0);

    // Collector center node
    const centerId = 'collector:' + key + ':center';
    const username = (primaryOwner && primaryOwner.username) ? primaryOwner.username : shortAddr(key);
    const avatarUrl = primaryOwner && primaryOwner.profileImageUrl ? primaryOwner.profileImageUrl : null;
    nodes.push({
      id: centerId,
      type: 'collector-center',
      name: username,
      username: primaryOwner?.username || null,
      flowAddress: key,
      profileImageUrl: avatarUrl,
      totalHoldings,
      playersCollectedCount: perPlayer.length,
      val: 26,
      fx: 0, fy: 0, fz: 0
    });

    if (perPlayer.length === 0) {
      return { addr: key, primaryOwner, perPlayer, nodes, links, empty: true, totalHoldings: 0, topMoments: [] };
    }

    // Inner ring: players-collected, sized by holdings (cap to 10 for layout; remainder signaled in subtitle)
    const innerPlayers = perPlayer.slice(0, 10);
    const INNER_R = 60;
    innerPlayers.forEach((pp, i) => {
      const angle = (i / innerPlayers.length) * Math.PI * 2 - Math.PI / 2;
      // Log-ish sizing: base 6 + bounded growth by holdings (cap 18)
      const nodeVal = Math.max(6, Math.min(18, 6 + Math.sqrt(pp.holdings) * 0.9));
      const playerNodeId = 'collector-player:' + key + ':' + pp.player.playerId;
      nodes.push({
        id: playerNodeId,
        type: 'collector-player',
        name: pp.playerName,
        playerName: pp.playerName,
        team: pp.player.team,
        teamColorPrimary: (pp.teamColors && pp.teamColors[0]) || '#5b6fff',
        teamColorSecondary: (pp.teamColors && pp.teamColors[1]) || '#14d8c4',
        holdings: pp.holdings,
        val: nodeVal,
        fx: Math.cos(angle) * INNER_R,
        fy: Math.sin(angle * 2) * 8,
        fz: Math.sin(angle) * INNER_R
      });
      links.push({
        source: playerNodeId,
        target: centerId,
        kind: 'collector-to-player',
        strokeColor: 'rgba(' + hexToRgbTriplet((pp.teamColors && pp.teamColors[0]) || '#5b6fff') + ',0.55)',
        particleColor: (pp.teamColors && pp.teamColors[1]) || '#f5b840',
        value: 0.6
      });
    });

    // Outer ring: top 12 moments across all players, ranked by tier then rarity
    const tierPriority = { ULTIMATE: 5, LEGENDARY: 4, ANTHOLOGY: 3, RARE: 2, FANDOM: 1, COMMON: 0 };
    function tierPri(tier) {
      if (!tier) return 0;
      for (const k of Object.keys(tierPriority)) if (tier.includes(k)) return tierPriority[k];
      return 0;
    }
    const allMoments = [];
    for (const pp of perPlayer) for (const m of pp.momentsOwned) allMoments.push(m);
    allMoments.sort((a, b) => {
      const tb = tierPri(b.edition.tier) - tierPri(a.edition.tier);
      if (tb !== 0) return tb;
      return (a.edition.edition?.circulationCount || 99999) - (b.edition.edition?.circulationCount || 99999);
    });
    const topMoments = allMoments.slice(0, 12);
    const OUTER_R = 140;
    topMoments.forEach((m, i) => {
      const angle = (i / Math.max(1, topMoments.length)) * Math.PI * 2 + Math.PI / 8;
      const heroUrl = m.flowId ? mediaUrl(m.flowId, 'hero', { width: 180, format: 'webp', quality: 80 }) : null;
      const momId = 'collector-moment:' + key + ':' + i;
      nodes.push({
        id: momId,
        type: 'collector-moment',
        editionKey: m.editionKey,
        playerName: m.playerName,
        setName: m.edition.set?.flowName || 'Moment',
        tier: m.edition.tier,
        circulation: m.edition.edition?.circulationCount || 0,
        serialNumber: m.serialNumber,
        heroUrl,
        val: 7,
        fx: Math.cos(angle) * OUTER_R,
        fy: Math.sin(angle * 3) * 10,
        fz: Math.sin(angle) * OUTER_R
      });
    });

    // Outer annulus hint — faint gold particles
    const HINT_COUNT = 180;
    const HINT_R_INNER = 200;
    const HINT_R_OUTER = 240;
    for (let i = 0; i < HINT_COUNT; i++) {
      const angle = (i / HINT_COUNT) * Math.PI * 2 + (Math.random() * 0.02);
      const r = HINT_R_INNER + Math.random() * (HINT_R_OUTER - HINT_R_INNER);
      nodes.push({
        id: 'collector-hint:' + key + ':' + i,
        type: 'collector-hint',
        val: 0.2,
        fx: Math.cos(angle) * r,
        fy: (Math.random() - 0.5) * 10,
        fz: Math.sin(angle) * r
      });
    }

    return { addr: key, primaryOwner, perPlayer, nodes, links, empty: false, totalHoldings, topMoments, truncatedMoments: Math.max(0, allMoments.length - topMoments.length) };
  }

  // Estimate percentile of this collector across the whole indexed graph (union across all players).
  function estimateCollectorPercentile(addr) {
    const key = normalizeFlowAddr(addr);
    const totals = new Map();
    for (const p of data.players) {
      for (const o of p.owners) {
        if (!o.flowAddress || !o.holdings) continue;
        const k = normalizeFlowAddr(o.flowAddress);
        totals.set(k, (totals.get(k) || 0) + o.holdings);
      }
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const idx = sorted.indexOf(key);
    if (idx < 0) return { rank: null, total: sorted.length, pctTile: null };
    // Top X% where X = ceil((idx+1) / total * 100)
    const pctTile = Math.max(1, Math.ceil((idx + 1) / sorted.length * 100));
    return { rank: idx + 1, total: sorted.length, pctTile };
  }

  // Render the L4 scene. Reuses ensureGraph + existing post-processing.
  function showCollectorView(addr) {
    const key = normalizeFlowAddr(addr);

    // UI chrome
    document.getElementById('graph-empty').style.display = 'none';
    document.getElementById('graph-legend').style.display = 'none';
    document.getElementById('graph-meta').style.display = 'block';
    document.getElementById('graph-controls').style.display = 'flex';
    document.getElementById('graph-hint').style.display = 'block';
    const lb = document.getElementById('leaderboard'); if (lb) lb.style.display = 'none';
    drawer.classList.remove('open');
    document.querySelectorAll('.player-card.active').forEach(el => el.classList.remove('active'));

    const cg = buildCollectorGraph(key);
    const pct = estimateCollectorPercentile(key);
    const hero = cg.primaryOwner;
    const uname = (hero && hero.username) ? hero.username : shortAddr(key);

    // Meta box
    document.getElementById('gm-player').textContent = uname;
    document.getElementById('gm-moments').textContent = cg.totalHoldings.toLocaleString() + ' serials';
    document.getElementById('gm-collectors').textContent = cg.perPlayer.length + ' players';
    document.getElementById('gm-top10').textContent = pct.rank ? ('Top ' + pct.pctTile + '%') : '—';
    document.getElementById('gm-serials').textContent = (cg.topMoments || []).length + ' shown · ' + (cg.truncatedMoments || 0) + ' more';
    document.getElementById('graph-hint').textContent = 'Click a player to enter their universe · Esc returns';

    if (cg.empty) {
      typeLevelSubtitle(`UNKNOWN COLLECTOR · ${shortAddr(key).toUpperCase()} · NO HOLDINGS IN INDEXED GRAPH`);
    } else {
      const rankTag = pct.rank ? `#${pct.rank.toLocaleString()} COLLECTOR · TOP ${pct.pctTile}%` : 'UNRANKED COLLECTOR';
      const moreMoments = cg.truncatedMoments > 0 ? ` · ${cg.truncatedMoments.toLocaleString()} MORE MOMENTS` : '';
      typeLevelSubtitle(`${uname.toUpperCase()} · ${rankTag} · ${cg.totalHoldings.toLocaleString()} SERIALS ACROSS ${cg.perPlayer.length} PLAYERS${moreMoments}`);
    }

    currentPlayer = null;
    currentData = Object.assign({ ownerArr: [], editionNodes: new Map() }, { nodes: cg.nodes, links: cg.links });

    const g = ensureGraph();
    g.graphData({ nodes: cg.nodes, links: cg.links });

    setTimeout(() => {
      if (cg.empty) {
        g.cameraPosition({ x: 0, y: 40, z: 150 }, { x: 0, y: 0, z: 0 }, 1400);
      } else {
        g.cameraPosition({ x: 0, y: 50, z: 220 }, { x: 0, y: 0, z: 0 }, 1400);
      }
    }, 50);

    // Auto-open drawer after camera settles — this is the pride-moment trigger.
    setTimeout(() => {
      if (!cg.empty) openL4CollectorDrawer({ cg, pct, key, uname, hero });
    }, 1800);
  }

  // Open the L4-scoped drawer: hero + stats + players-collected bar + top moments + copy-link CTA.
  function openL4CollectorDrawer(ctx) {
    const { cg, pct, key, uname, hero } = ctx;
    clearDrawer();

    const heroEl = mkEl('div', { className: 'collector-hero' });
    const av = mkEl('div', { className: 'collector-hero-avatar' });
    if (hero && hero.profileImageUrl) av.style.backgroundImage = `url("${hero.profileImageUrl.replace(/"/g, '&quot;')}")`;
    else av.textContent = initials(uname);
    heroEl.appendChild(av);
    const meta = mkEl('div', { className: 'collector-hero-meta' });
    meta.appendChild(mkEl('div', { className: 'collector-hero-rank', text: pct.rank ? `#${pct.rank.toLocaleString()}` : '—' }));
    meta.appendChild(mkEl('div', { className: 'collector-hero-label', text: `Your fandom universe · across ${data.players.length} indexed players` }));
    meta.appendChild(mkEl('div', { className: 'collector-hero-username', text: uname }));
    heroEl.appendChild(meta);
    drawerInner.appendChild(heroEl);

    // Stats row
    const rarRow = mkEl('div', { className: 'rar-row' });
    const sp1 = document.createElement('span');
    sp1.innerHTML = `<strong>${cg.totalHoldings.toLocaleString()}</strong> serials held`;
    rarRow.appendChild(sp1);
    const sp2 = document.createElement('span');
    sp2.innerHTML = `<strong>${cg.perPlayer.length}</strong> player${cg.perPlayer.length === 1 ? '' : 's'} collected`;
    rarRow.appendChild(sp2);
    if (pct.pctTile) {
      const sp3 = document.createElement('span');
      sp3.style.color = '#f5b840';
      sp3.innerHTML = `<strong>Top ${pct.pctTile}%</strong> indexed collector`;
      rarRow.appendChild(sp3);
    }
    drawerInner.appendChild(rarRow);

    // Players-collected bar (breakdown)
    if (cg.perPlayer.length > 0) {
      const section = mkEl('div', { className: 'drawer-section' });
      section.appendChild(mkEl('h4', { text: `Players in this universe · top ${Math.min(cg.perPlayer.length, 10)}` }));
      const list = mkEl('div', { className: 'owner-list' });
      const maxHoldings = cg.perPlayer[0].holdings || 1;
      cg.perPlayer.slice(0, 10).forEach((pp) => {
        const row = mkEl('div', { className: 'owner-row' });
        row.style.cursor = 'pointer';
        const teamC = (pp.teamColors && pp.teamColors[0]) || '#5b6fff';
        const addrSp = mkEl('span', { className: 'addr' });
        addrSp.textContent = pp.playerName;
        const swatch = mkEl('span', { style: `display:inline-block; width:8px; height:8px; border-radius:50%; background:${teamC}; margin-right:8px; vertical-align:middle;` });
        addrSp.prepend(swatch);
        row.appendChild(addrSp);
        // Mini horizontal bar + count
        const right = mkEl('span', { style: 'display:flex; align-items:center; gap:8px; min-width:120px;' });
        const barWrap = mkEl('span', { style: 'display:inline-block; width:60px; height:6px; background:rgba(255,255,255,0.06); border-radius:3px; overflow:hidden;' });
        const barFill = mkEl('span', { style: `display:block; height:100%; background:${teamC}; width:${Math.round(pp.holdings / maxHoldings * 100)}%;` });
        barWrap.appendChild(barFill);
        right.appendChild(barWrap);
        right.appendChild(mkEl('span', { className: 'count', text: `${pp.holdings.toLocaleString()}` }));
        row.appendChild(right);
        row.addEventListener('click', () => window.fandomRouter.go('player', { player: pp.playerName }));
        list.appendChild(row);
      });
      section.appendChild(list);
      drawerInner.appendChild(section);
    }

    // Top moments strip
    if (cg.topMoments && cg.topMoments.length > 0) {
      const section = mkEl('div', { className: 'drawer-section' });
      section.appendChild(mkEl('h4', { text: `Trophy case · top ${cg.topMoments.length} Moments by tier` }));
      const grid = mkEl('div', { className: 'moments-grid' });
      cg.topMoments.forEach((m) => {
        const card = mkEl('div', { className: 'moment-card' });
        card.style.cursor = 'pointer';
        const img = mkEl('div', { className: 'moment-card-img' });
        if (m.flowId) img.style.backgroundImage = `url("${mediaUrl(m.flowId, 'hero', { width: 180, format: 'webp', quality: 80 }).replace(/"/g, '&quot;')}")`;
        img.style.backgroundSize = 'cover';
        img.style.backgroundPosition = 'center';
        card.appendChild(img);
        const cap = mkEl('div', { className: 'moment-card-cap' });
        cap.appendChild(mkEl('div', { className: 'moment-card-set', text: m.edition.set?.flowName || 'Moment' }));
        cap.appendChild(mkEl('div', { className: 'moment-card-meta', text: `#${m.serialNumber || '?'} · ${tierLabel(m.edition.tier)}` }));
        card.appendChild(cap);
        card.addEventListener('click', () => window.fandomRouter.go('edition', { key: m.editionKey, player: m.playerName }));
        grid.appendChild(card);
      });
      section.appendChild(grid);
      drawerInner.appendChild(section);
    }

    // Action row — Copy link is the primary CTA per R1 / community signal
    const actions = mkEl('div', { className: 'detail-actions', style: 'margin-top: 18px; display:flex; gap:10px; flex-wrap:wrap;' });
    const copyBtn = mkEl('button', { className: 'btn-sm', text: 'Copy my universe link', style: 'background:rgba(245,184,64,0.14); border:1px solid rgba(245,184,64,0.45); color:#f5b840; padding:9px 14px; border-radius:6px; cursor:pointer; font-family:inherit; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.14em;' });
    copyBtn.addEventListener('click', () => {
      const u = window.location.href;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(u).then(() => showL4Toast('Link copied — paste it anywhere')).catch(() => showL4Toast(u));
        } else {
          showL4Toast(u);
        }
      } catch (e) { showL4Toast(u); }
    });
    actions.appendChild(copyBtn);
    if (hero && hero.username) {
      actions.appendChild(mkEl('a', { className: 'btn-sm', text: `@${hero.username} on Top Shot ↗`, href: `https://nbatopshot.com/user/@${hero.username}`, target: '_blank', rel: 'noopener' }));
    }
    if (key) {
      actions.appendChild(mkEl('a', { className: 'btn-sm', text: 'Flowscan ↗', href: `https://www.flowscan.io/account/0x${key}`, target: '_blank', rel: 'noopener' }));
    }
    drawerInner.appendChild(actions);

    drawer.classList.add('open');
  }

  // Minimal toast for L4 "link copied" — no new DOM, just a transient styled element.
  function showL4Toast(text) {
    let el = document.getElementById('l4-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'l4-toast';
      el.style.cssText = 'position:fixed; bottom:32px; left:50%; transform:translateX(-50%); background:rgba(10,10,20,0.95); border:1px solid rgba(245,184,64,0.55); color:#f5b840; padding:12px 20px; border-radius:8px; font-family:inherit; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.14em; z-index:200; box-shadow:0 8px 32px rgba(0,0,0,0.6); opacity:0; transition:opacity 0.2s ease;';
      document.body.appendChild(el);
    }
    el.textContent = text;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    clearTimeout(el.__hideTimer);
    el.__hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  // Small utility: '#RRGGBB' -> 'R,G,B' for rgba() strings
  function hexToRgbTriplet(hex) {
    if (!hex || hex[0] !== '#') return '255,255,255';
    const h = hex.length === 4 ? hex.replace(/#(.)(.)(.)/, '#$1$1$2$2$3$3') : hex;
    const r = parseInt(h.slice(1, 3), 16);
    const g = parseInt(h.slice(3, 5), 16);
    const b = parseInt(h.slice(5, 7), 16);
    return `${r},${g},${b}`;
  }

  // ======================= Router registration =======================
  window.fandomRouter.register('player', {
    render: (payload) => {
      showGraphFor(payload.player);
      // Subtitle is optional — typeLevelSubtitle was removed in the L0/L1 cleanup.
      // Guard so the render function doesn't crash (which would prevent spotlight activation).
      if (typeof typeLevelSubtitle === 'function') {
        const p = data.players.find(x => x.name === payload.player);
        if (p) {
          const topOwner = currentData && currentData.ownerArr && currentData.ownerArr[0];
          const topLockedTag = topOwner ? ` · ${p.rankingMode === 'locked' ? 'AVAILABLE LOCKED SCORE' : 'OWNERSHIP VIEW'} · ${p.rankingMode === 'locked' ? fmtLockedScore(topOwner.lockedScore) : topOwner.fullHoldings.toLocaleString() + ' OWNED'}` : '';
          const totalMarketValue = p.editions.reduce((a, e) => a + editionMarketValue(e), 0);
          typeLevelSubtitle(`${String(p.name).toUpperCase()} · ${(p.totalMintedMomentCount || 0).toLocaleString()} MOMENTS · ${p.owners.length.toLocaleString()} LOADED HOLDERS · ${p.editions.length} EDITIONS${topLockedTag}`);
        } else {
          typeLevelSubtitle('');
        }
      }
      if (payload.spotlight) setTimeout(() => activateSpotlight(payload.spotlight), 1500);
    },
    buildCrumbs: (payload) => ([
      { label: 'Top Shot', level: 'picker', payload: {} },
      { label: payload.player, level: 'player', payload: { player: payload.player } }
    ])
  });
  window.fandomRouter.register('collector', {
    render: (payload) => showCollectorView(payload.addr),
    buildCrumbs: (payload) => ([
      { label: 'Top Shot', level: 'picker', payload: {} },
      { label: 'Collector', level: 'collector', payload }
    ])
  });
  window.fandomRouter.register('edition', {
    render: (payload) => {
      // showEditionView sets its own richer subtitle now (includes holder totals)
      showEditionView(payload.key, payload.player);
    },
    buildCrumbs: (payload) => {
      const p = data.players.find(x => x.name === payload.player);
      const e = p?.editions.find(ed => ed.editionKey === payload.key);
      return [
        { label: 'Top Shot', level: 'picker', payload: {} },
        { label: payload.player || '—', level: 'player', payload: { player: payload.player } },
        { label: (e?.set?.flowName || 'Edition') + ' · ' + tierLabel(e?.tier), level: 'edition', payload }
      ];
    }
  });

  // ======================= Cinematic level transition =======================
  function cinematicTransition(fromState, toState) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('level-transition-overlay');
      if (!overlay || !window.gsap) { resolve(); return; }
      window.gsap.to(overlay, {
        opacity: 1, duration: 0.4, ease: 'power2.inOut',
        onComplete: () => {
          setTimeout(() => {
            window.gsap.to(overlay, { opacity: 0, duration: 0.9, ease: 'power3.inOut', onComplete: resolve });
          }, 80);
        }
      });
    });
  }
  window.cinematicTransition = cinematicTransition;

  // ======================= Initial URL routing =======================
  const initial = window.fandomRouter.parseQuery(window.location.search);
  // Only deep-link to a player/edition. With no URL param, stay on the picker.
  if ((initial.level === 'player' || initial.level === 'edition') && initial.payload && initial.payload.player) {
    // Ensure index.json is loaded before resolving the player name → playerId
    if (window.DataLayer && typeof window.DataLayer.initIndex === 'function') {
      window.DataLayer.initIndex().catch(() => {}).finally(() => {
        loadAndRoutePlayer(initial.payload.player, initial.payload.spotlight || null).then(() => {
          if (initial.level === 'edition') {
            window.fandomRouter.go('edition', initial.payload, { replace: true });
          }
        });
      });
    } else {
      // Fallback: try loading directly (works for numeric playerIds)
      loadAndRoutePlayer(initial.payload.player, initial.payload.spotlight || null);
    }
  }

  // ===== Mobile overlay toggles =====
  // Legend toggle button is now in fandom.html (inline onclick).
  // Meta panel: tap to expand stats on mobile
  const meta = document.getElementById('graph-meta');
  if (meta) {
    meta.addEventListener('click', () => {
      if (window.matchMedia('(max-width: 768px)').matches) {
        meta.classList.toggle('mobile-expanded');
      }
    });
  }
})();

