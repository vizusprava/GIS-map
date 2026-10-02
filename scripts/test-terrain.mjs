/**
 * Kontrola dopočtu hlubších dlaždic terénu (`src/terrainTiles.ts`).
 *
 * Nad úrovní `DMR_MAX_LEVEL` se na ČÚZK nechodí a dlaždice se řeže z předka. Když je v tom
 * počtu o jedna vedle, terén se tiše posune nebo mezi dlaždicemi vznikne schod — a na mapě to
 * poznáš, až když ti model visí ve vzduchu. Proto se tu měří přesně tohle.
 *
 * Spustit: `npm run test:terrain` (Node 24 čte .ts přímo, žádný build není potřeba).
 */
import { nearestToFocus, resampleTile, sliceBlock } from '../src/terrainTiles.ts'

let fails = 0
const near = (a, b, tol, what) => {
  const ok = Math.abs(a - b) <= tol
  if (!ok) fails++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}: ${a.toFixed(6)} (čekáno ${b.toFixed(6)} ±${tol})`)
}
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

const W = 64, H = 64
/** rovina h = 100 + 3·i − 2·j — bilineární vzorkování ji musí vrátit PŘESNĚ, ať se řeže kdekoli */
const plane = new Float32Array(W * H)
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) plane[j * W + i] = 100 + 3 * i - 2 * j

console.log('\n── dlaždice se nekrájí, jen opisuje (n = 1) ──')
{
  const same = resampleTile(plane, W, H, 0, 0, 1)
  let worst = 0
  for (let k = 0; k < W * H; k++) worst = Math.max(worst, Math.abs(same[k] - plane[k]))
  near(worst, 0, 0, 'největší odchylka od předlohy')
}

console.log('\n── řez roviny musí sedět na milimetr, ať je dlaždice kdekoli ──')
for (const n of [2, 4, 8]) {
  let worst = 0, worstAt = ''
  for (let sy = 0; sy < n; sy++) {
    for (let sx = 0; sx < n; sx++) {
      const out = resampleTile(plane, W, H, sx, sy, n)
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          // kde vzorek leží v mřížce předka, a jakou výšku tam rovina má
          const gu = (sx * (W - 1) + i) / n, gv = (sy * (H - 1) + j) / n
          const want = 100 + 3 * gu - 2 * gv
          const d = Math.abs(out[j * W + i] - want)
          if (d > worst) { worst = d; worstAt = `dlaždice ${sx},${sy} vzorek ${i},${j}` }
        }
      }
    }
  }
  near(worst, 0, 1e-3, `n = ${n}: největší odchylka (${worstAt || 'nikde'})`)
}

console.log('\n── sousední dlaždice na sebe navazují bez schodu ──')
{
  // pilovitý terén, ať se případný posun projeví: střídavé hřbety a rýhy
  const rough = new Float32Array(W * H)
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) rough[j * W + i] = 200 + 8 * Math.sin(i / 3) * Math.cos(j / 5)
  const n = 4
  let worstX = 0, worstY = 0
  for (let sy = 0; sy < n; sy++) {
    for (let sx = 0; sx < n; sx++) {
      const a = resampleTile(rough, W, H, sx, sy, n)
      if (sx + 1 < n) {
        const b = resampleTile(rough, W, H, sx + 1, sy, n) // soused na východ
        for (let j = 0; j < H; j++) worstX = Math.max(worstX, Math.abs(a[j * W + (W - 1)] - b[j * W]))
      }
      if (sy + 1 < n) {
        const c = resampleTile(rough, W, H, sx, sy + 1, n) // soused na jih
        for (let i = 0; i < W; i++) worstY = Math.max(worstY, Math.abs(a[(H - 1) * W + i] - c[i]))
      }
    }
  }
  near(worstX, 0, 1e-4, 'schod na svislé hraně mezi dlaždicemi')
  near(worstY, 0, 1e-4, 'schod na vodorovné hraně mezi dlaždicemi')
}

console.log('\n── krajní vzorky předka zůstávají krajními vzorky ──')
{
  const n = 8
  const nw = resampleTile(plane, W, H, 0, 0, n)          // severozápadní roh předka
  const se = resampleTile(plane, W, H, n - 1, n - 1, n)  // jihovýchodní roh předka
  near(nw[0], plane[0], 1e-4, 'SZ roh sedí na SZ roh předka')
  near(se[(H - 1) * W + (W - 1)], plane[(H - 1) * W + (W - 1)], 1e-4, 'JV roh sedí na JV roh předka')
}

console.log('\n── nic nespadne mimo mřížku ──')
{
  let bad = 0
  for (const n of [1, 2, 4, 8, 16]) {
    for (const [sx, sy] of [[0, 0], [n - 1, 0], [0, n - 1], [n - 1, n - 1]]) {
      const out = resampleTile(plane, W, H, sx, sy, n)
      for (let k = 0; k < W * H; k++) if (!Number.isFinite(out[k])) bad++
    }
  }
  ok(bad === 0, `žádné NaN ani nekonečno v rozích (nalezeno ${bad})`)
}

console.log('\n── blok rodiče se rozřeže na čtyři děti bez jediného posunu ──')
{
  // blok 127×127 uzlů přes rodiče; rovina v souřadnicích RODIČE (0…126)
  const N = 2 * (W - 1) + 1
  const block = new Float32Array(N * N)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) block[j * N + i] = 300 + 2 * i - 5 * j + 0.25 * i * j
  let worst = 0
  for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
    const kid = sliceBlock(block, N, W, H, sx, sy)
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const gi = sx * (W - 1) + i, gj = sy * (H - 1) + j
      worst = Math.max(worst, Math.abs(kid[j * W + i] - (300 + 2 * gi - 5 * gj + 0.25 * gi * gj)))
    }
  }
  near(worst, 0, 0, 'každé dítě čte přesně svůj kus bloku')
  const nw = sliceBlock(block, N, W, H, 0, 0), ne = sliceBlock(block, N, W, H, 1, 0), sw = sliceBlock(block, N, W, H, 0, 1)
  let seamX = 0, seamY = 0
  for (let j = 0; j < H; j++) seamX = Math.max(seamX, Math.abs(nw[j * W + (W - 1)] - ne[j * W]))
  for (let i = 0; i < W; i++) seamY = Math.max(seamY, Math.abs(nw[(H - 1) * W + i] - sw[i]))
  near(seamX, 0, 0, 'západní a východní dítě sdílí svislou hranu bit po bitu')
  near(seamY, 0, 0, 'severní a jižní dítě sdílí vodorovnou hranu bit po bitu')
  near(nw[0], block[0], 0, 'SZ roh dítěte je SZ roh rodiče')
  const se = sliceBlock(block, N, W, H, 1, 1)
  near(se[W * H - 1], block[N * N - 1], 0, 'JV roh dítěte je JV roh rodiče')
}

console.log('\n── fronta se odbavuje od středu pohledu ven ──')
{
  // mřížka 5×5 dlaždic po ~1 km kolem Liberce; střed pohledu leží přesně v prostředku
  const FL = 15.056, FA = 50.767, STEP = 0.01
  const queue = []
  for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) queue.push({ lon: FL + c * STEP, lat: FA + r * STEP })
  // vyzobat jednu po druhé a změřit, jak daleko od středu každá byla
  // měří se ve SKUTEČNÉ vzdálenosti po zemi, ne ve stupních — na 50° je stupeň délky kratší
  const metres = t => Math.round(Math.hypot((t.lat - FA) * 111320, (t.lon - FL) * 111320 * Math.cos(FA * Math.PI / 180)))
  const rest = queue.slice()
  const order = []
  while (rest.length) order.push(metres(rest.splice(nearestToFocus(rest, FL, FA), 1)[0]))
  let rising = true
  for (let i = 1; i < order.length; i++) if (order[i] < order[i - 1]) rising = false
  ok(rising, `vzdálenost od středu jen roste (${order.slice(0, 6).join(' → ')} → … → ${order[order.length - 1]} m)`)
  near(order[0], 0, 0, 'první na řadě je dlaždice ve středu')
  near(order[order.length - 1], Math.hypot(2 * 111320 * STEP, 2 * 111320 * STEP * Math.cos(FA * Math.PI / 180)), 2, 'poslední je roh')
}

console.log('\n── když se člověk podívá jinam, přerovná se to ──')
{
  const queue = [
    { lon: 15.0, lat: 50.0 }, // západní
    { lon: 16.0, lat: 50.0 }, // východní
  ]
  ok(nearestToFocus(queue, 15.1, 50.0) === 0, 'pohled na západ bere západní dlaždici')
  ok(nearestToFocus(queue, 15.9, 50.0) === 1, 'pohled na východ bere východní dlaždici')
  ok(nearestToFocus([], 15, 50) === -1, 'prázdná fronta vrací −1')
}

console.log('\n── poledníky se stahují podle rovnoběžky ──')
{
  // u nás je stupeň zeměpisné délky asi 0,63 stupně šířky; bez opravy by se to spletlo
  const queue = [
    { lon: 15.0, lat: 50.9 },  // 0,9° na sever
    { lon: 16.2, lat: 50.0 },  // 1,2° na východ ≈ 0,76° šířky, tedy blíž
  ]
  ok(nearestToFocus(queue, 15.0, 50.0) === 1, 'bližší je ta východní, ne severní')
}

console.log(fails ? `\n${fails} SELHÁNÍ` : '\nVŠE PROŠLO')
process.exit(fails ? 1 : 0)
