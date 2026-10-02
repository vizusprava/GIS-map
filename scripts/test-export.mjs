/**
 * Kontroly exportů do 3ds Maxu, které se v appce samy neprojeví.
 *
 *  - Převod WGS84 ↔ S-JTSK: hotový převodník musí dávat bit po bitu totéž co přímé `proj4(...)`.
 *    Na něm stojí poloha všeho, co jde ven, a rozdíl by se ukázal až v Maxu.
 *  - V-Ray skript: každá `geo…` funkce, kterou skript volá, v něm musí být nadefinovaná.
 *    MAXScript to zjistí až za běhu — a jen v té větvi, která se zrovna vykoná.
 *  - Budovy: zadaný posun se musí odečíst stejně jako u terénu, jinak se rozjedou.
 *
 * Spustit: `npm run test:export`
 */
import proj4 from 'proj4'
import { sjtskOf, wgsOf, buildMaxScriptFiles, tilesOutline } from '../src/tiles.ts'
import { buildBuildingsObj } from '../src/buildings.ts'
import { drawOverlayToCanvas } from '../src/export/drawOverlay.ts'

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

console.log('\n── převodník S-JTSK dává totéž co přímé proj4 ──')
{
  // Liberec, Praha, Brno, Ostrava, Šumava — napříč republikou
  const pts = [[15.056, 50.767], [14.42, 50.087], [16.607, 49.195], [18.292, 49.835], [13.5, 48.98]]
  let same = true, sameBack = true, worstRound = 0
  for (const [lon, lat] of pts) {
    const a = sjtskOf(lon, lat)
    const b = proj4('EPSG:4326', 'EPSG:5514', [lon, lat])
    if (a[0] !== b[0] || a[1] !== b[1]) same = false
    const [lo2, la2] = wgsOf(a[0], a[1])
    const back = proj4('EPSG:5514', 'EPSG:4326', [a[0], a[1]])
    if (lo2 !== back[0] || la2 !== back[1]) sameBack = false
    worstRound = Math.max(worstRound, Math.abs(lo2 - lon), Math.abs(la2 - lat))
  }
  ok(same, 'sjtskOf je bit po bitu shodné s proj4(EPSG:4326 → EPSG:5514)')
  ok(sameBack, 'wgsOf je bit po bitu shodné s proj4(EPSG:5514 → EPSG:4326)')
  // inverze Křováku je v proj4 iterativní — vrací se zhruba na milimetr (1e-8° ≈ 1 mm), ne přesně
  ok(worstRound < 1e-7, `tam a zpět se vrátí na místo (odchylka ${worstRound.toExponential(1)}°, tj. pod 1 cm)`)
  const [x, y] = sjtskOf(15.056, 50.767)
  ok(x < -600000 && x > -700000 && y < -950000 && y > -1050000, `Liberec padne do Křováku se zápornými souřadnicemi (${x.toFixed(0)}, ${y.toFixed(0)})`)
}

console.log('\n── V-Ray skript volá jen funkce, které sám definuje ──')
{
  const ms = buildMaxScriptFiles(['dlazdice_1_2.jpg'])
  const defined = new Set([...ms.matchAll(/^fn (geo\w+)/gm)].map(m => m[1]))
  const used = new Set([...ms.matchAll(/\b(geo[A-Z]\w*)\b/g)].map(m => m[1]))
  const missing = [...used].filter(n => !defined.has(n))
  ok(defined.size > 5, `skript definuje své funkce (${defined.size})`)
  ok(missing.length === 0, missing.length ? `nedefinované funkce: ${missing.join(', ')}` : 'žádná volaná funkce nechybí')
}

console.log('\n── budovy jdou s posunem stejně jako terén ──')
{
  // obdélník 12 × 8 m v Křováku, terén vodorovně 300 m, střecha plochá na 306 m
  const X = -680000, Y = -990000
  const fp = { outer: [[X, Y], [X + 12, Y], [X + 12, Y + 8], [X, Y + 8]], holes: [] }
  const ground = () => 300
  const surface = () => 306
  const plain = buildBuildingsObj([fp], ground, surface, 1)
  // stejná konvence jako buildTileObj: offset se ODEČÍTÁ, takže „k počátku" = roh budovy
  const off = { x: X, y: Y, z: 300 }
  const moved = buildBuildingsObj([fp], ground, surface, 1, off)
  ok(plain.count === 1 && moved.count === 1, 'budova vznikla v obou případech')
  const nums = line => line.split(' ').slice(1).map(Number)
  let worst = 0
  plain.verts.forEach((v, i) => {
    const a = nums(v), b = nums(moved.verts[i])
    worst = Math.max(worst, Math.abs(a[0] - off.x - b[0]), Math.abs(a[1] - off.y - b[1]), Math.abs(a[2] - off.z - b[2]))
  })
  ok(worst < 1e-3, `každý vrchol je posunutý přesně o zadaný posun (odchylka ${worst.toFixed(4)} m)`)
  const first = nums(moved.verts[0])
  ok(Math.abs(first[0]) < 20 && Math.abs(first[1]) < 20, `po posunu leží budova u počátku (${first.map(n => n.toFixed(1)).join(', ')})`)
}

console.log('\n── výkres dokreslený do exportu mapy po kusech ──')
{
  // Plátno, které jen počítá tahy — stačí na otázku „nakreslí se ta čára do tohohle kusu?"
  const fakeCanvas = () => {
    const g = { strokes: 0, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, translate() {}, rotate() {}, fillText() {} }
    g.stroke = () => { g.strokes++ }
    return g
  }
  const item = pts => ({ prims: [{ kind: 'poly', pts, layer: '0', color: 0xff0000 }], toSjtsk: (x, y) => [x, y], hidden: new Set(), alpha: 1 })
  // kus mapy 250 × 250 m, 250 px
  const box = { minX: -688000, minY: -975000, maxX: -687750, maxY: -974750 }
  const drawn = pts => { const g = fakeCanvas(); drawOverlayToCanvas(g, 250, 250, box, [item(pts)]); return g.strokes }
  ok(drawn([[-689000, -974900], [-686500, -974900]]) === 1, 'dlouhá čára přes celý kus (žádný vrchol uvnitř) se nakreslí')
  ok(drawn([[-687900, -974900], [-687800, -974850]]) === 1, 'čára celá uvnitř se nakreslí')
  ok(drawn([[-689000, -976000], [-688500, -976000]]) === 0, 'čára úplně mimo kus se zahodí')
}

console.log('\n── obrys výběru dlaždic (export ve tvaru výběru) ──')
{
  const T = (ix, iy) => ({ ix, iy, size: 250 })
  // plocha prstenců (shoelace) — díra se odečte, protože jde opačným směrem
  const area = rings => Math.abs(rings.reduce((s, r) => s + r.reduce((a, [x, y], i) => {
    const [x2, y2] = r[(i + 1) % r.length]
    return a + x * y2 - x2 * y
  }, 0) / 2 * (r === rings[0] ? 1 : -1), 0))
  ok(tilesOutline([T(0, 0), T(1, 0), T(0, 1), T(1, 1)]) === undefined, 'plný obdélník 2×2 se neořezává')
  const L = tilesOutline([T(0, 0), T(1, 0), T(0, 1)])
  ok(L?.length === 1 && Math.abs(area(L) - 3 * 250 * 250) < 1, `tvar L → jeden prstenec o ploše tří dlaždic (${L ? area(L) : '—'} m²)`)
  const ring = []
  for (let ix = 0; ix < 3; ix++) for (let iy = 0; iy < 3; iy++) if (ix !== 1 || iy !== 1) ring.push(T(ix, iy))
  const R = tilesOutline(ring)
  ok(R?.length === 2, `rámeček 3×3 bez prostředku → vnější obrys + díra (${R?.length ?? 0} prstence)`)
}

console.log(fails ? `\n${fails} SELHÁNÍ` : '\nVŠE PROŠLO')
process.exit(fails ? 1 : 0)
