# A clearer view of collecting

Independent sprint by Felipe Mattos, 8 October 2026.

## Starting point

Upstream: https://github.com/dapperlabs/fandom-graph

Reviewed commit: `55184ebf2296c0ae28f5095ff1527965e7cb09a4`.

The original prototype and its MIT license remain attributed. This extension is not an official Dapper Labs release. No changes have been sent to Dapper or published from this sprint.

## Question and evidence

Can a collector distinguish ownership counts from locked-score rankings and tell which numbers are known?

Inspection of `fandom.js` at the reviewed commit showed that a failed leaderboard request left the sidebar and coverage text describing a locked-score ranking. Missing holders in a returned leaderboard were assigned score zero. The graph's coverage denominator was fixed at 200 rather than using the loaded holder count. These are reproducible presentation/code-path findings in an open-source prototype, not claims about the main Top Shot app.

The methodology described direct public GraphQL queries and six athletes, while the loader described a remote JSON roster and the contribution guide described generation using private BigQuery infrastructure. The extension documents the actual client loading path; it does not claim access to that private generator.

## Changes

- Added a shared ranking-state function, used by the graph and the synthetic interactive example.
- Fallback sorts loaded holders by Moments owned and labels that view explicitly.
- Missing scores stay `null`; verified zero stays zero. Malformed, duplicate, empty or wholly unmatched responses do not establish a locked-score view.
- Available leaderboard scores order only the loaded holder subset. Displayed positions are not advertised as official global ranks.
- Score totals are described as totals for returned entries, not whole-platform totals.
- Fixed holder coverage denominator; the visible graph still limits fully rendered collector nodes.
- Added a native, keyboard-accessible disclosure for source, unknown freshness, partial flags and filtering.
- Partial-dataset spotlight wording says "observed in"; it does not infer non-ownership from an absent sampled serial.
- Preserved missing scores through the API proxy instead of converting absent source scores to zero.
- Disabled upstream analytics in the independent demo; no new tracking was added.

The data contract does not specify an authoritative update timestamp. The UI displays "not provided" rather than inventing one from request time. It does not infer that `partial: false` guarantees completeness.

## Snapshot audit

`scripts/audit.py` checks the three included upstream sample files and writes `case/audit.json` with file hashes. Python and SQLite independently reconcile reported holder counts against observed serials; their results must agree. SQL is in `scripts/audit.sql`.

| Snapshot | Editions | Holders | Observed serials | Reported/observed holder-count differences |
| --- | ---: | ---: | ---: | ---: |
| Karl-Anthony Towns | 54 | 7,830 | 16,970 | 5,903 |
| Stephen Curry | 63 | 11,647 | 29,938 | 0 |
| LeBron James | 68 | 9,960 | 30,881 | 0 |

No duplicate serial IDs or holder addresses were found. None of the samples supplied an update timestamp. Curry and LeBron declare partial data; Towns does not. Reported supply, observed serials and holder counts describe different populations. The Towns count differences need a selection/sampling explanation; they are not 5,903 proven data bugs or affected customers.

This is not a live API audit, an independent on-chain reconciliation, or a representative sample of customers. Public wallet accounts are not equivalent to individual people. The audit does not estimate revenue, support volume, retention or hiring probability.

## Validation

- JavaScript syntax checks.
- Nine targeted Node tests: failure sorting, null versus zero, missing capped-response holders, empty/malformed/invalid/duplicate/unmatched responses, and unknown timestamp.
- Privacy smoke scanner: pass. Its Windows path handling was corrected and it accepts analytics being disabled.
- Browser checks: actual graph with the repository LeBron snapshot under four controlled API states; source labels, holder denominator, zero/null handling and disclosure interaction.
- Browser case checks: four interactive states, recorded audit rendering and narrow-screen overflow.

Browser score responses are synthetic test fixtures. Graph browser tests intentionally replace remote thumbnails with empty SVGs, so screenshots verify layout and behavior without depending on third-party media. These fixtures are not measurements of live leaderboard scores.

The broad smoke runner needed two harness fixes: a portable Node server and fetching its fixture outside an about:blank browser page. After those fixes, its graph and spotlight checks passed. The final run reported 8 passes and 1 failure: first paint under its mobile network/CPU throttle was 11,048 ms against a 4,000 ms gate. Its long-task ratio check passed. This sprint does not claim the performance gate passed or any performance improvement. The inherited 3D view and its external dependencies remain a performance limitation to investigate separately.

## Run locally

```sh
npm install
node scripts/serve.cjs
```

Open http://127.0.0.1:8766 for the case. Its graph link uses `sample=1` to select the included snapshot rather than the remote snapshot CDN. The static server has no live leaderboard backend; the graph correctly enters ownership mode. The case's state selector demonstrates the other states using clearly marked synthetic data.

```sh
python scripts/audit.py
node --test scripts/number-context.test.cjs
node scripts/privacy-smoke.mjs
node scripts/browser-check.mjs
```

The browser script uses installed Google Chrome via Playwright. To contribute upstream, preserve its no-framework structure and run its required checks. The included contribution patch excludes the personal case and attribution footer.

## Next measurement

Compare original and revised views in counterbalanced usability tasks: identify ranking metric, distinguish unknown from zero, and explain freshness. Record task accuracy, completion time and confidence. A small pilot identifies misunderstandings; a suitably sized experiment would be needed for an impact claim. Internal support and retention data would be necessary to measure business outcomes.

## Short walkthrough

1. Explain why the fandom view caught my attention (15 seconds).
2. Use the interactive fixture: verified zero versus unknown score (30 seconds).
3. Switch to failure mode and show the changed ranking label (20 seconds).
4. Open the real-snapshot graph and its source disclosure (30 seconds).
5. Show the audit's checks and limitations, then discuss what I would measure next (25 seconds).

## Sources

- https://www.dapperlabs.com/careers
- https://github.com/dapperlabs/fandom-graph/blob/55184ebf2296c0ae28f5095ff1527965e7cb09a4/CONTRIBUTING.md
- https://github.com/dapperlabs/fandom-graph/blob/55184ebf2296c0ae28f5095ff1527965e7cb09a4/fandom.js
- https://github.com/dapperlabs/fandom-graph/blob/55184ebf2296c0ae28f5095ff1527965e7cb09a4/data-layer.js
- https://github.com/dapperlabs/fandom-graph/blob/55184ebf2296c0ae28f5095ff1527965e7cb09a4/methodology.html
