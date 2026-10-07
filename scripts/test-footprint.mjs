/**
 * Kontrola půdorysu modelu pro skrytí mapy (`src/footprint.ts`).
 *
 * Mapa se má schovat přesně pod modelem: díry v modelu (vnitřek okružní křižovatky, bloky
 * mezi větvemi) zůstanou s mapou, úzké mezery mezi díly se zavřou, okraj ořezu leží kousek
 * uvnitř modelu (zubatý okraj ořezu v Cesiu se tak schová pod model) a kusy nemají díry
 * ani moc bodů (Cesium díry neumí a cena ořezu roste s body).
 *
 * Spustit: `npm run test:footprint`
 */
import { FootprintRaster } from '../src/footprint.ts'
import { pointInRing } from '../src/rings.ts'

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

/** Půdorys z obdélníků [e0, n0, e1, n1] (každý dva trojúhelníky). */
function footprint(rects, extra = []) {
  const all = rects.flat()
  const r = new FootprintRaster(Math.min(...rects.map(q => q[0])), Math.min(...rects.map(q => q[1])), Math.max(...rects.map(q => q[2])), Math.max(...rects.map(q => q[3])))
  for (const [a, b, c, d] of rects) { r.addTriangle(a, b, c, b, c, d); r.addTriangle(a, b, c, d, a, d) }
  for (const t of extra) r.addTriangle(...t)
  void all
  return r.pieces()
}
const inside = (pieces, e, n) => pieces.some(p => pointInRing(e, n, p))

// okružní křižovatka: čtverec 100 × 100 m s dírou 60 × 60 m uprostřed (pás silnice 20 m)
const ring = [[0, 0, 100, 20], [0, 80, 100, 100], [0, 20, 20, 80], [80, 20, 100, 80]]
let t0 = Date.now()
const rp = footprint(ring)
ok(rp.length > 0, `okruh: ${rp.length} kusů za ${Date.now() - t0} ms`)
ok(!inside(rp, 50, 50) && !inside(rp, 30, 70), 'okruh: vnitřek (díra) mapu neskryje')
ok(inside(rp, 10, 50) && inside(rp, 50, 90) && inside(rp, 90, 10), 'okruh: silnice mapu skryje (i v rozích a u řezů kusů)')
ok(!inside(rp, 0.3, 50) && !inside(rp, 19.7, 50), 'okruh: okraj ořezu je uvnitř modelu (vnější i vnitřní okraj)')
ok(inside(rp, 1, 50) && inside(rp, 19, 50), 'okruh: o kus dál od okraje už skryje')
ok(rp.every(p => p.length >= 3 && p.length <= 120), `okruh: kusy mají 3–120 bodů (${rp.map(p => p.length).join(', ')})`)
// hustá kontrola: celý pás skrytý, celá díra ne (mřížka po 1 m, 1,5 m od okrajů)
let miss = 0, leak = 0
for (let e = 1.5; e <= 98.5; e += 1) for (let n = 1.5; n <= 98.5; n += 1) {
  const onRoad = e < 18.5 || e > 81.5 || n < 18.5 || n > 81.5
  const inHole = e > 21.5 && e < 78.5 && n > 21.5 && n < 78.5
  const hit = inside(rp, e, n)
  if (onRoad && !hit) miss++
  if (inHole && hit) leak++
}
ok(!miss && !leak, `okruh: bez děr v ořezu a bez ořezu v díře (chybí ${miss}, navíc ${leak})`)

// mezery mezi díly: 0,5 m se zavře, 3 m zůstane
const gap = footprint([[0, 0, 10, 10], [10.5, 0, 20.5, 10]])
ok(inside(gap, 10.25, 5), 'úzká mezera mezi díly (0,5 m) se zavře')
const wide = footprint([[0, 0, 10, 10], [13, 0, 23, 10]])
ok(!inside(wide, 11.5, 5) && inside(wide, 5, 5) && inside(wide, 18, 5), 'široká mezera (3 m) zůstane s mapou')

// svislá stěna (trojúhelníky promítnuté na čáru) nespadne a úzká se neořízne
const wall = footprint([[0, 0, 10, 10]], [[20, 0, 20, 30, 20, 0], [20, 0, 20, 30, 20, 30]])
ok(wall.length > 0 && !inside(wall, 20, 15), 'svislá stěna: bez pádu, úzká stěna mapu neskryje')

// díl užší než buňka mřížky (obrubník 10 cm) uprostřed mezery 2 m: bez něj mezera zůstane
// (víc, než se zavře), s ním jsou z ní dvě úzké a plochy se spojí
const strip = footprint([[0, 0, 10, 10], [12, 0, 22, 10], [10.95, 0, 11.05, 10]])
ok(inside(strip, 11, 5) && inside(strip, 10.4, 5) && inside(strip, 11.6, 5), 'úzký díl (10 cm) se započítá a spojí sousední plochy')
const noStrip = footprint([[0, 0, 10, 10], [12, 0, 22, 10]])
ok(!inside(noStrip, 11, 5), '…bez něj mezera 2 m zůstane')

// výkon: 200 000 drobných trojúhelníků na 400 × 400 m
t0 = Date.now()
const big = new FootprintRaster(0, 0, 400, 400)
for (let i = 0; i < 100000; i++) {
  const x = (i % 400) + 0.2, y = Math.floor(i / 400) * 1.6
  big.addTriangle(x, y, x + 1, y, x, y + 1.6); big.addTriangle(x + 1, y, x + 1, y + 1.6, x, y + 1.6)
}
const bp = big.pieces()
const ms = Date.now() - t0
ok(ms < 8000 && bp.length > 0 && bp.reduce((s, p) => s + p.length, 0) <= 3500, `výkon: 200 000 trojúhelníků za ${ms} ms, ${bp.length} kusů`)

console.log(fails ? `\n${fails} kontrol selhalo` : '\nvše v pořádku')
process.exit(fails ? 1 : 0)
