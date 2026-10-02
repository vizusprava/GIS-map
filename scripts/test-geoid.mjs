/**
 * Kontrola převodu Bpv ↔ elipsoid (`src/geoid.ts`, kvazigeoid ČÚZK CR-2005).
 *
 * Referenční hodnoty jsou z PLNÉ mřížky CR-2005 (cz_cuzk_CR-2005.tif z PROJ-data, bilineárně);
 * v kódu je zředěná, takže se toleruje pár centimetrů. Kdyby tenhle test spadl, terén ČÚZK
 * a Google 3D dlaždice by se v daném kraji zase rozjely o metry (viz hlavička geoid.ts).
 *
 * Spustit: `npm run test:geoid`.
 */
import { geoidN } from '../src/geoid.ts'

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

console.log('\n── hodnoty proti plné mřížce CR-2005 (tolerance 5 cm) ──')
const REF = [
  ['Liberec', 15.056, 50.767, 43.214],
  ['Praha', 14.42, 50.087, 44.892],
  ['Plzeň', 13.378, 49.747, 46.603],
  ['Cheb', 12.371, 50.08, 46.698],
  ['Brno', 16.608, 49.195, 44.639],
  ['Ostrava', 18.292, 49.835, 42.530],
  ['Šumava-Kvilda', 13.58, 49.02, 47.515],
  ['Sněžka', 15.74, 50.736, 43.623],
  ['Č. Budějovice', 14.474, 48.975, 46.151],
  ['Jihlava', 15.591, 49.396, 46.093],
]
for (const [name, lon, lat, ref] of REF) {
  const v = geoidN(lon, lat)
  ok(Math.abs(v - ref) <= 0.05, `${name}: ${v.toFixed(3)} m (CR-2005 ${ref.toFixed(3)})`)
}

console.log('\n── tvar přes celou ČR ──')
let mn = Infinity, mx = -Infinity, jump = 0
for (let lat = 48.55; lat <= 51.06; lat += 0.001) {
  let prev = null
  for (let lon = 12.09; lon <= 18.86; lon += 0.0015) {
    const v = geoidN(lon, lat)
    mn = Math.min(mn, v); mx = Math.max(mx, v)
    if (prev != null) jump = Math.max(jump, Math.abs(v - prev))
    prev = v
  }
}
// Obdélník kolem ČR zasahuje v rozích do Polska a Německa, kde kvazigeoid klesá k 38 m —
// hodnoty uvnitř republiky hlídají místa výš, tady jde jen o to, že nic neujelo mimo rozumný rozsah.
ok(mn > 36 && mx < 48, `rozsah v obdélníku kolem ČR ${mn.toFixed(2)}–${mx.toFixed(2)} m (grid CR-2005 má 36,8–47,5)`)
// ~100 m krok — skok by na švu dlaždic terénu udělal schod
ok(jump < 0.02, `největší změna na 100 m: ${(jump * 100).toFixed(2)} cm (spojité, bez schodů)`)

console.log('\n── mimo mřížku ──')
const far = [geoidN(0, 0), geoidN(30, 60), geoidN(12.09, 51.5)]
ok(far.every(Number.isFinite), `za hranicí vrací okrajovou hodnotu (${far.map(v => v.toFixed(2)).join(', ')})`)

console.log(fails ? `\n${fails} SELHÁNÍ` : '\nVŠE PROŠLO')
process.exit(fails ? 1 : 0)
