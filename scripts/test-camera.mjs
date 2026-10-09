/**
 * Kontrola hranic pro kameru (`src/crGeometry.ts`): co je uvnitř republiky, co kousek za
 * hranicí (ještě smí) a co daleko (přitáhne se na okraj povoleného pásu).
 *
 * Spustit: `npm run test:camera`
 */
import { CR_H, CR_W, MARGIN_KM, clampToCr, kmOutsideCr } from '../src/crGeometry.ts'

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

ok(CR_W > 450 && CR_W < 520 && CR_H > 260 && CR_H < 310, `rozměr republiky ${CR_W.toFixed(0)} × ${CR_H.toFixed(0)} km`)

// uvnitř
for (const [name, lon, lat] of [['Praha', 14.42, 50.09], ['Brno', 16.61, 49.2], ['Ostrava', 18.29, 49.84], ['Aš', 12.19, 50.22], ['Liberec', 15.06, 50.77], ['České Budějovice', 14.47, 48.97]]) {
  ok(kmOutsideCr(lon, lat) === 0 && clampToCr(lon, lat) === null, `${name} je uvnitř`)
}

// kousek za hranicí — ještě smí (pás MARGIN_KM)
for (const [name, lon, lat] of [['Zittau', 14.81, 50.9], ['Cheb–Waldsassen', 12.31, 49.97], ['Gmünd', 14.99, 48.77]]) {
  const km = kmOutsideCr(lon, lat)
  ok(km > 0 && km < MARGIN_KM && clampToCr(lon, lat) === null, `${name} ${km.toFixed(1)} km za hranicí — smí`)
}

// daleko — přitáhne se přesně na okraj pásu
for (const [name, lon, lat] of [['Drážďany', 13.74, 51.05], ['Vídeň', 16.37, 48.21], ['Mnichov', 11.58, 48.14], ['Krakov', 19.94, 50.06], ['Vratislav', 17.04, 51.11]]) {
  const km = kmOutsideCr(lon, lat), q = clampToCr(lon, lat)
  const qk = q ? kmOutsideCr(q[0], q[1]) : NaN
  ok(km > MARGIN_KM && !!q && Math.abs(qk - MARGIN_KM) < 0.5, `${name} ${km.toFixed(0)} km za hranicí → přitaženo na ${qk.toFixed(1)} km`)
}

console.log(fails ? `\n${fails} kontrol selhalo` : '\nvše v pořádku')
process.exit(fails ? 1 : 0)
