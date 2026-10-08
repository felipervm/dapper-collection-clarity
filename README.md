# Dapper Collection Clarity

An independent exploration by Felipe Mattos of data clarity in Dapper Labs’ open-source Fandom Graph: ranking context, unknown scores and collection coverage.

## Explore

- **[Case study](index.html)** — a standalone interactive page with embedded images, fonts and audit results. Download and open it in a browser, or serve this repository.
- **[Full case](case/index.html)** — links to the modified 3D graph and reproducible supporting files.
- **[Method and validation](SPRINT.md)** — sources, implementation choices, findings and limitations.
- **[Audit results](case/audit.json)** and **[audit script](scripts/audit.py)**.

## Run locally

```sh
node scripts/serve.cjs
```

Open `http://127.0.0.1:8766` for the full case. The graph uses the included repository snapshot with `sample=1`; a local static server does not provide the production leaderboard API. The interactive case uses clearly labelled synthetic responses.

```sh
node scripts/number-context.test.cjs
python scripts/audit.py
```

## What changed

Unknown locked scores stay unknown instead of becoming zero. When the score service cannot rank a collection, the interface explicitly switches to an ownership view. Source, freshness limitations, partial flags and loaded coverage are explained beside the numbers.

Three included snapshots were checked for duplicate identifiers and reconciliation between reported holder counts and observed serials. These checks are not a live blockchain audit and do not demonstrate business impact. See the method for the exact results and limits.

## Attribution

Based on [Dapper Labs’ Fandom Graph](https://github.com/dapperlabs/fandom-graph), pinned to `55184ebf2296c0ae28f5095ff1527965e7cb09a4`. The original README is preserved in [docs/upstream-README.md](docs/upstream-README.md). This is independent work, not an official Dapper Labs release or an endorsed project.

Original MIT code license retained. Product images and marks belong to their respective owners; they are used as attributed editorial context and are not covered by the MIT code license. Font licenses and visual sources are included in [case/assets](case/assets/SOURCES.md).

[Felipe Mattos · LinkedIn](https://www.linkedin.com/in/felipervm)
