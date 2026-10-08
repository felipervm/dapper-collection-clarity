# Contributing to Fandom Graph

Thanks for your interest! This is a Dapper Labs prototype, open-sourced for the community.

## Getting started

1. Clone the repo
2. Run `python3 -m http.server 8000`
3. Open `http://localhost:8000/fandom?player=LeBron+James`
4. Install dev deps: `npm install` (for Playwright smoke tests)

## Making changes

- The graph logic is in `fandom.js` (~3,500 lines, no build step, plain ES5-ish JS in an IIFE)
- The data layer is `data-layer.js` (player roster + per-player data loader)
- The router is `router.js` (URL ↔ state mapping)
- Styles are in `styles.css`
- Tests are in `scripts/smoke.mjs` (Playwright) and `scripts/privacy-smoke.mjs`

## Submitting changes

1. Fork → branch → commit → PR
2. Run `node --check fandom.js` before submitting
3. Run `node scripts/privacy-smoke.mjs` — must pass
4. Keep the code style: no build step, no TypeScript, no framework

## Data

The `/data/{playerId}.json` files are generated from BigQuery (see [SPEC-002](https://github.com/dapperlabs/nbats-data-auth-portal/blob/main/specs/002-fandom-ownership-backend/spec.md)). The generator requires private Dapper Labs infrastructure. External contributors should use the sample data in `/data/sample/`.

## Code of conduct

Be respectful. This is a prototype project — we're generous with merges for quality contributions.
