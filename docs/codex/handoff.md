# Lenia Hunt — handoff

## Objective
Find new-looking Lenia (single-channel continuous CA) creatures on a laptop: an automated
search that classifies each candidate, keeps movers and pulsers, and builds a gallery that
favours novelty. Sibling of `../life-hunt` (HighLife soup search).

## Layout
- `index.html`, `style.css`, `app.js`: UI, hunt loop, gallery (localStorage `lenia-hunt-gallery-v1`, export/import JSON)
- `gpu.js`: WebGL2 engine. The world is a T×T atlas of independent 128² toroidal tiles, each with its own params.
  Kernels are stored as sparse tap lists (weights < 1e-4·max dropped). Search uses T=4 (16 candidates per draw); the viewer uses T=1.
- `lenia-core.js`: CPU FFT sim (reference + Node tests), `measure` (torus circular-mean centroid), `shapeDescriptor`,
  `Tracker` (2-stage classify), `features`, `classify`, `featureVector`, `novelty`, `nextCandidate` (search policy), `seedBlob`
- `explain.js`: live figures for the '어떻게 작동하나' section (kernel heatmap, growth curve with μ±σ, gallery scatter of speed vs mass variation)
- `cards.js`: trading-card gallery. Name (Latin-ish, hashed from id), HP from mass, type from class (활공/맥동/고동), two moves from features,
  μ/σ/R stat row, flavor text, rarity from novelty (커먼/언커먼/레어/최초 발견; holo foil in the art window for 레어+), and '1진화' when it was mutated from a gallery member.
  Hover tilts the card and runs a small CPU Lenia sim (128 torus, seeded with the saved crop) in the art window, following the centroid.
- `table.js`: card-table effects with GSAP 3.12.5 + Flip (cdnjs, loaded as globals before app.js). New finds are saved with `opened:false`
  (sealed); the 확장팩 button opens up to 5 per pack: drag across the top (or click) to tear, cards rise out, spread face down with
  rarity glow on the backs (gold = 최초 발견, purple = 레어, teal = 언커먼), flip one by one (rare cards shake and flash first),
  then '도감에 넣기' flies them into their grid slots. The deck draws a random opened card and flips it face up. The 격자/부채꼴 toggle uses Flip.
  Entries without an `opened` field (saved before this) count as opened. Debug hooks: `lenia.table.openPack()`, `.drawFromDeck()`, `.setView('fan')`.
- `orbium.js`: Orbium (Chan 2019) reference creature, used for sanity checks and the "Orbium" button
- `tools/smoke.mjs`: `node tools/smoke.mjs [n]` asserts Orbium → glider on the CPU path, optionally runs n CPU candidates

## How it works
- Candidate = random params (R 10–15, β from a ring-set list, μ, σ ≈ μ·0.06–0.18, dt 0.1) + seed → noise disc (`seedBlob`, fully seed-determined).
- Screening: 400 steps, sampled every 5. Dies (mass<0.5) / explodes (>30% cells >0.1) end early.
  Provisional keepers continue to 1500 steps and are reclassified on the late window; a mass change of >25% since step 400 → `unstable`.
- Classes: glider, pulsing-mover, oscillator (= keepers), static, unstable, chaotic, explodes, dies.
- Search policy (`nextCandidate`): each slot is a lineage walking the die/explode edge (dies → σ up, explodes/chaotic → σ down).
  Keepers spawn mutants. A third of fresh starts mutate a gallery member.
- Novelty = mean distance to the 3 nearest gallery feature vectors (speed, massCV, shapeVar, mass/R², elongation, spread,
  straightness, 6-bin radial profile). Saved only if ≥ `NOVELTY_MIN` (0.35). Gallery cap 150 (prunes the least distinct).
- Replay: "시드에서" re-runs the same seed on the same 128 torus (deterministic on the same GPU); "최종 형태" spawns the saved 8-bit crop.

## Deploy
- Live: https://lenia-hunt.vercel.app (Vercel, scope magic3ightballs-projects). Redeploy: `npx vercel@latest deploy --prod --yes --scope magic3ightballs-projects` from this folder, then delete any `.env.local` that `vercel` creates. `.vercelignore` excludes docs/ and tools/.
- Listed in the deployed-links hub Artifact (Claude_etc/deployed-links/index.html, groups array).

## Run
- launch.json entry `lenia-hunt`, port 8986 (`python3 -m http.server 8986 --directory .../lenia-hunt`)
- `?autostart=0` loads paused.

## Verified (2026-10-20)
- Orbium → `glider` on the CPU (speed 0.473 R/t) and travels on the GPU viewer with stable mass.
- GPU hunt: about 870–1100 candidates/min. One run: 756 candidates → 7 gliders, 2 pulsing movers, 11 oscillators, 17 gallery entries.
  Movers included 1-ring Orbium-like (μ≈0.128), 2-ring β=[1,1] crescent (μ 0.2688, σ 0.0417, v 0.14), and 3-ring β=[1,.33,.66] slow gliders (μ≈0.32, v 0.03–0.06).
- Seed replays in the viewer reproduced the search speeds to 3 decimals on 5/5 movers checked. The gallery persists across reloads. No console errors.
- The machine was heavily loaded by sibling hunts during testing (load avg ~187), and CPU timings were inflated.

## Gotchas
- A hidden Browser pane freezes the page between tool calls, and in-page `await setTimeout` hangs. Drive the search with
  `lenia.runBatches(300)` (about 15 s per call) and read `lenia.counts` / `lenia.gallery`. Screenshots need the pane to be visible.
- The hunt loop uses MessageChannel, not rAF/setTimeout, so it keeps running in a visible-but-unfocused tab.
- The 400-step-only classification let slow growers in as "oscillators". The 1500-step confirmation stage fixes that. Keep it.

## 2026-10-20 later
- Gallery became trading cards (cards.js + `.tcard` CSS, container-query sized, max 270px). Verified: 17 cards with no clipping at desktop or 375px width, hover animation advancing frames, holo only in the art window. Redeployed.

- Card-table animations (pack/deck/fan) added and redeployed. References: Pokémon TCG Pocket (drag-to-tear, rare light cue), Balatro (springy flip, small random tilt), Hearthstone-style rarity glow on face-down backs, simeydotme pokemon-cards-css (hover tilt; GPL, so not copied).
- Testing note: in the Browser pane, GSAP tweens only advance while screenshots are taken; to check end states, flush with `gsap.globalTimeline.getChildren(true,true,true).forEach(t => t.progress(1))` (skip repeat:-1 tweens).

- Gallery default view is now a stacked deck (`pile`: ◀/▶ tuck the top card under or bring the bottom back, 섞기 shuffles, 한 장 뽑기 draws a random card into the stage). Views 덱/부채꼴/격자 switch with Flip; the choice is kept in localStorage `lenia-hunt-view`. The old small deck button was removed.
- Rarity is relative now (user chose option C on 2026-10-20): `assignRarity()` in app.js ranks every card by leave-one-out kNN novelty within the whole gallery. Top 5% (at least 1) = 전설 ✦, next 15% = 레어 ★, next 30% = 언커먼 ◆, rest = 커먼 ●. It's recomputed on every render, so tiers can drop as look-alikes arrive. Before this, rarity used the novelty saved at discovery time, so early finds were all 레어 (9/17 cards were 레어 or above).
  Visuals: frame colour per tier (silver / blue / purple / orange), foil range (none / name strip / art window / whole face plus a moving sheen), and a corner badge. The 새로움순 sort uses `rarityScore`.

## Next ideas
- Show a centroid trail/animated thumbnail on cards. Add a bigger world (256) for spawned crops.
- Tune `NOVELTY_MIN` / feature scaling once the gallery has 100+ entries. Oscillators currently dominate the count.
- Multi-channel or Flow-Lenia (arXiv 2212.07906) variant. Cross-check finds against Chan's published animal list.
