// Fandom Graph router — URL <-> level state. Levels: player|edition|collector. Picker = boot/no-op.
(function (global) {
  const handlers = {};
  let currentState = null;

  function parseQuery(search) {
    const p = new URLSearchParams(search);
    if (p.get('edition'))   return { level: 'edition',   payload: { key: p.get('edition'), player: p.get('player') || null } };
    if (p.get('collector')) return { level: 'collector', payload: { addr: p.get('collector') } };
    if (p.get('player'))    return { level: 'player',    payload: { player: p.get('player'), spotlight: p.get('spotlight') || null } };
    return { level: 'picker', payload: {} };
  }

  function buildUrl(level, payload) {
    const u = new URL(window.location.href);
    u.search = '';
    const q = u.searchParams;
    if (level === 'player')       { q.set('player', payload.player); if (payload.spotlight) q.set('spotlight', payload.spotlight); }
    else if (level === 'edition') { q.set('edition', payload.key); if (payload.player) q.set('player', payload.player); }
    else if (level === 'collector') { q.set('collector', payload.addr); }
    // picker = no params
    return u.pathname + (q.toString() ? '?' + q.toString() : '');
  }

  function register(level, config) {
    handlers[level] = config;
  }

  async function go(level, payload, opts) {
    opts = opts || {};
    const handler = handlers[level];
    if (!handler) { console.warn('[router] no handler for', level); return; }
    const prior = currentState;
    const url = buildUrl(level, payload);
    if (!opts.replace && !opts.fromPop) {
      try { window.history.pushState({ level: level, payload: payload }, '', url); } catch (e) { /* ignore */ }
    } else if (opts.replace) {
      try { window.history.replaceState({ level: level, payload: payload }, '', url); } catch (e) { /* ignore */ }
    }
    currentState = { level: level, payload: payload };
    if (global.cinematicTransition && prior) {
      try { await global.cinematicTransition(prior, currentState); } catch (e) { /* swallow */ }
    }
    try { await handler.render(payload); } catch (e) { console.error('[router] render error', e); }
    renderBreadcrumb();
  }

  function renderBreadcrumb() {
    const el = document.getElementById('level-breadcrumb');
    if (!el) return;
    // Picker boot state: no breadcrumb.
    if (currentState.level === 'picker') { el.style.display = 'none'; while (el.firstChild) el.removeChild(el.firstChild); return; }
    const crumbs = (handlers[currentState.level] && handlers[currentState.level].buildCrumbs)
      ? handlers[currentState.level].buildCrumbs(currentState.payload)
      : [{ label: currentState.level, level: currentState.level, payload: currentState.payload }];
    // Clear via DOM API (defense-in-depth, no innerHTML)
    while (el.firstChild) el.removeChild(el.firstChild);
    crumbs.forEach(function (c, i) {
      const isActive = i === crumbs.length - 1;
      const node = document.createElement(isActive ? 'span' : 'a');
      node.className = 'crumb' + (isActive ? ' active' : '');
      node.textContent = c.label;
      if (!isActive) {
        node.href = buildUrl(c.level, c.payload);
        node.addEventListener('click', function (ev) {
          ev.preventDefault();
          go(c.level, c.payload);
        });
      }
      el.appendChild(node);
      if (!isActive) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›'; // single right-pointing angle quote
        el.appendChild(sep);
      }
    });
    el.style.display = crumbs.length ? 'flex' : 'none';
  }

  window.addEventListener('popstate', function (ev) {
    const state = ev.state || parseQuery(window.location.search);
    go(state.level, state.payload, { fromPop: true });
  });

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !currentState) return;
    if (currentState.level === 'edition' && currentState.payload && currentState.payload.player) {
      go('player', { player: currentState.payload.player });
    } else if (currentState.level === 'player') {
      go('picker', {});
    } else if (currentState.level === 'collector') {
      go('picker', {});
    }
  });

  global.fandomRouter = {
    register: register,
    go: go,
    parseQuery: parseQuery,
    currentState: function () { return currentState; }
  };
})(window);
