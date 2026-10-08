# spec-003 Task 4 — Perf-cap integration spike (DE-RISK)

**Date:** 2026-06-27
**Repo:** `dapperlabs/fandom-graph`
**Question:** Can the holders 201–1000 hint annulus be rendered as a single `THREE.Points` object added to the scene OUTSIDE of `3d-force-graph`'s `graphData()` — via `Graph.scene().add(pointsGroup)` — while still sharing the scene/camera/post-processing/interaction space?

## TL;DR — VERDICT: **PROCEED** with the `THREE.Points` path.

All three de-risking checks PASS, confirmed both by static reading of `fandom.js` and by a live headless-browser run of the reproducible spike at `spike-perf.html`.

| Check | Result | Evidence basis |
|-------|--------|-----------------|
| (a) Scene/camera/transform sharing | **PASS** | live + static |
| (b) Post-processing (bloom) captures Points | **PASS** | live + static |
| (c) Points do NOT intercept node clicks | **PASS** | live + static |

---

## Method

1. **Static reading** of `/tmp/fandom-graph/fandom.js` — `ensureGraph()` (L1017), `addStarfield()` (L874), `addBackdropRings()` (L855), `installBloom()` (L927), `installGrainCA()` (L954), `onNodeClick` (L1600), and the existing `whale-hint`/`collector-hint` node build paths (L1106, L1118, L3204, L3653).
2. **Live reproducible spike** at `spike-perf.html` — loads the identical UMD stack as `fandom.html` (three r149 runtime + r147 post-processing UMD scripts + 3d-force-graph 1.70.19), builds a 10-node force-graph, creates a 500-point gold `THREE.Points` shell, adds it via `Graph.scene().add(pointsGroup)`, and wires bloom through `Graph.postProcessingComposer()`.
3. **Headless-browser verification** (Puppeteer via the harness browser tool) — queried the live scene graph, composer passes, and `graphData` membership, then behaviorally clicked a graph node and empty point-cloud space.

---

## Check (a) — Scene/camera/transform sharing — **PASS**

### Static evidence
`fandom.js` L1748–1753 (and again L1898–1902) shows the established pattern for adding non-`graphData` objects to the force-graph scene:

```js
const scene = Graph.scene();
if (scene) {
  addBackdropRings(scene);   // scene.add(inner); scene.add(outer);   — L863, L870
  addStarfield(scene);       // scene.add(starfieldMesh);             — L914  (a THREE.Points!)
  addFog(scene);
}
```

`addStarfield()` (L874–915) constructs a `THREE.Points` object (`starfieldMesh = new THREE.Points(geom, mat)`) and adds it via `scene.add(starfieldMesh)`. The starfield is visible in production and tracks OrbitControls (orbit/pan/zoom) because the camera is the single shared `THREE.PerspectiveCamera` that 3d-force-graph renders. `addBackdropRings()` (L855–872) does the same with `THREE.Mesh` rings. This is direct prior art that `Graph.scene().add()` places an object into the SAME scene the renderer draws, with the SAME camera — so it inherits the camera transform.

3d-force-graph's `Graph.scene()` accessor returns the actual `THREE.Scene` used by its internal `WebGLRenderer` (this is the documented public accessor; the starfield/backdrop rings being visible in production proves it is the rendered scene, not a copy).

### Live evidence (headless browser)
```js
const scene = Graph.scene();
const pg = scene.children.find(c => c.name === 'perfSpikeHintPoints');
// {
//   foundPointsByName:   true,
//   pointsParentIsScene: true,      // pg.parent === scene
//   pointsIsTHREEPoints: true,      // pg.isPoints
//   sceneChildTypes: ["Mesh","AmbientLight","DirectionalLight","Group","Points"],
//   cameraType: "PerspectiveCamera",
//   hasControls: true               // Graph.controls() exists (OrbitControls)
// }
```

The `Points` object is a direct child of `Graph.scene()`, in the same `children` array as the force-graph's own lights and node group. Because 3d-force-graph renders this exact scene with this exact camera every frame, the Points share the full transform space and will track OrbitControls. **PASS.**

---

## Check (b) — Post-processing (bloom + grain) renders the Points — **PASS**

### Static evidence
`installBloom(Graph)` (L927–949) and `installGrainCA(Graph)` (L954–1015) both obtain the composer via:

```js
const composer = Graph.postProcessingComposer();
composer.addPass(bloom);   // UnrealBloomPass
```

3d-force-graph's `postProcessingComposer()` returns an `THREE.EffectComposer` whose **first pass is a `RenderPass` of the entire `Graph.scene()` with `Graph.camera()`**. `RenderPass` renders every object in `scene.children` to the composer's read buffer; subsequent passes (bloom, grain) operate on that buffer. Therefore ANY object added via `scene.add()` — including a `THREE.Points` — is captured by the RenderPass and goes through bloom + grain.

The starfield (`THREE.Points`, added via `scene.add()`) IS visibly bloomed in production (the bright stars glow) — direct prior art. The backdrop rings (additive-blended meshes, `scene.add()`) also show bloom glow. Both confirm the composer's RenderPass covers the whole scene, not just `graphData` nodes.

### Live evidence (headless browser)
```js
const composer = Graph.postProcessingComposer();
// {
//   composerPasses: ["iu", "UnrealBloomPass"],   // "iu" is the minified RenderPass class name
//   firstPassIsRenderPass: true,                 // composer.passes[0].scene !== undefined
//   firstPassSceneIsGraphScene: true             // composer.passes[0].scene === Graph.scene()
// }
```

The composer's first pass has `scene === Graph.scene()` — i.e. it renders the exact scene that now contains our `THREE.Points`. The `UnrealBloomPass` follows and operates on the rendered buffer. Gold additive-blended points produce a visible glow in the spike (screenshot at `spike-perf-screenshot.png`). **PASS.**

> Note for Task 5/6: bloom threshold in `fandom.js` is `0.55` (L942). To guarantee the hint annulus glows, the `PointsMaterial` colors should exceed the luminance threshold — the existing `0xf5b840` gold (luminance ≈ 0.72) clears it, matching the starfield/backdrop approach.

---

## Check (c) — Pointer event non-interference — **PASS**

### Static evidence
3d-force-graph's `onNodeClick` (and `onNodeHover`, drag, etc.) raycasts ONLY against the meshes produced by `nodeThreeObject()` for nodes in `graphData()`. The raycaster iterates `graphData().nodes`, projects each node's `__threeObj` world position, and tests intersection — it does NOT walk `scene.children` arbitrarily. An object added via `scene.add()` that is not referenced by any `graphData` node's `__threeObj` is therefore invisible to the graph's pointer handlers.

`fandom.js` L1600–1685 confirms the handler is purely node-type dispatch: it receives a `node` (a `graphData` entry) and switches on `node.type`. It never inspects arbitrary scene children. The existing `whale-hint`/`collector-hint` nodes (L1106, L1118) are non-interactive BY VIRTUE of being `return`-early in `onNodeClick` (L1617, L1633) — but they are still full `graphData` nodes and still cost a raycast test each. Moving the 201–1000 hints OUT of `graphData` into a single `THREE.Points` removes ~800 raycast tests per pointer event AND removes them from the force simulation entirely — the dual win this spike exists to validate.

The starfield (`THREE.Points`, `scene.add()`) and backdrop rings (`THREE.Mesh`, `scene.add()`) do NOT intercept clicks in production — they are not in `graphData()`. Direct prior art.

### Live evidence (headless browser)
```js
// {
//   graphDataNodeCount: 10,          // the 500 Points did NOT inflate graphData
//   pointsInGraphData: false,        // no graphData node has __threeObj === pointsGroup
//   nodesWithThreeObj: 10            // only the 10 real nodes are raycast targets
// }
```

**Behavioral test:**
- Clicked graph node `n0` at screen `(870, 642)` → `onNodeClick` fired: `[click] onNodeClick fired on n0 — Points did NOT steal it ✔`
- Clicked empty point-cloud space at `(40, 40)` → no `onNodeClick` fired (the HUD did not gain a `[click]` line).

The Points object cannot be hit by the graph's raycaster because it is not a `graphData` node. **PASS.**

---

## Verdict: **PROCEED** with the `THREE.Points` path for holders 201–1000.

All three checks pass. No pivot to Plan B-perf is required. The 201–1000 hint annulus should be a single `THREE.Points` object added via `Graph.scene().add()`, NOT 800 individual `graphData` nodes.

### Implementation approach for Task 5/6

**Create the Points group** (mirror `addStarfield()` at `fandom.js` L874–915):

```js
function addHolderHintPoints(scene, playerCenter, holders201to1000) {
  const COUNT = holders201to1000.length;           // up to 800
  const pos = new Float32Array(COUNT * 3);
  const col = new Float32Array(COUNT * 3);
  // place each hint on the existing annulus used by whale-hint/collector-hint:
  //   angle = rankIndex/total * 2π, radius in [R_INNER, R_OUTER] around playerCenter
  for (let i = 0; i < COUNT; i++) {
    const h = holders201to1000[i];
    const angle = (i / COUNT) * Math.PI * 2 + (Math.random() * 0.02);
    const r = HINT_R_INNER + Math.random() * (HINT_R_OUTER - HINT_R_INNER);
    pos[i*3]   = playerCenter.x + Math.cos(angle) * r;
    pos[i*3+1] = playerCenter.y + (Math.random() - 0.5) * 8;
    pos[i*3+2] = playerCenter.z + Math.sin(angle) * r;
    col[i*3] = 0.96; col[i*3+1] = 0.72; col[i*3+2] = 0.25; // gold 0xf5b840
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6, vertexColors: true, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
  });
  const points = new THREE.Points(geom, mat);
  points.name = 'holderHintPoints';
  scene.add(points);                                 // OUTSIDE graphData()
  return points;
}
```

**Geometry/material:**
- `THREE.BufferGeometry` with `position` (Float32Array `N*3`) + `color` (Float32Array `N*3`, gold `0xf5b840`).
- `THREE.PointsMaterial`: `size ≈ 1.6`, `vertexColors: true`, `transparent: true`, `opacity ≈ 0.7`, `blending: THREE.AdditiveBlending`, `depthWrite: false`, `sizeAttenuation: true` — identical recipe to `addStarfield()` (L904–912) so bloom treats it the same.

**Positioning:** reuse the existing `whale-hint` annulus geometry (`HINT_R_INNER=170`, `HINT_R_OUTER=195` at L3206–3207 for L0; the player-view equivalent for L2/L4). Offset by the player-node's world position so the annulus centers on the player. Rank order → angle so the annulus reads as "more collectors further out."

**Lifecycle:** add the Points in the same `setTimeout` block that currently calls `addBackdropRings(scene)` / `addStarfield(scene)` after a view renders (e.g. L1748–1753, L1898–1902). Keep a module-level ref (like `starfieldMesh`) and `scene.remove()` + dispose geometry/material on view change to avoid leaks — same pattern already used for `backdropMeshes` (L856).

**Disclosure affordance:** since the 201–1000 hints are now non-interactive, pair them with a small label sprite ("+800 more collectors · top 200 shown") at the annulus edge, OR a HUD chip. The Points themselves are pure visual hint — no click, no hover, no tooltip (matches the existing `whale-hint`/`collector-hint` "no-op" semantics at L1617/L1633 but at 1/800th the raycast + simulation cost).

### Perf win quantified
- **Force simulation:** removes up to 800 nodes from `graphData()` → the d3-force simulation no longer integrates 800 bodies per tick. This is the core de-risk: Assumption 1 (top-1000 stalling first-paint) is addressed by keeping only the top-200 in the sim.
- **Raycast per pointer event:** `onNodeClick`/`onNodeHover` raycast drops from ~1000 targets to ~200.
- **Draw cost:** one `THREE.Points` draw call vs. 800 `Mesh`+`Sprite` group draw calls (the current `whale-hint` builds a `Group` with a `Mesh` + `glowSprite` per node — L1112–1114).

---

## Artifacts
- `spike-perf.html` — reproducible standalone spike (open in any browser; HUD prints the 3 checks live; buttons toggle Points/bloom; `logEvidence()` dumps the scene/composer/graphData state to console).
- `spike-perf-screenshot.png` — headless-browser screenshot showing the gold point shell bloomed around the 10-node graph (not committed; large binary — the live HUD text above is the durable evidence).

## Reproducing
```bash
cd /tmp/fandom-graph
python3 -m http.server 8080   # any static server; the UMD libs are unpkg CDN
# open http://localhost:8080/spike-perf.html
# click "print evidence" → console shows the scene/composer/graphData facts
# click any blue node → HUD confirms onNodeClick fires (Points don't steal it)
# click empty space over the gold cloud → no node click fires
```
