/**
 * Kontrola čtení DXF (`src/dxf.ts`) — jednotky z hlavičky a odolnost středu proti úletům.
 *
 * Obojí se pozná až v mapě a pozdě: špatné jednotky posunou výkres o tři řády, rozhozený střed
 * ho vyhodí z Křováku a položí „doprostřed pohledu". Na reálném výkresu (VRT_Test.dxf) udělaly
 * dva zatoulané prvky z obálky 2 386 × 2 293 km, takže to není teoretická starost.
 *
 * Spustit: `npm run test:dxf` (Node 24 čte .ts přímo, žádný build není potřeba).
 */
import { decodeDxf, dxfToPrims, krovakForm, toKrovakNeg } from '../src/dxf.ts'
import { parseDrawing } from '../src/drawingParse.ts'

let fails = 0
const near = (a, b, tol, what) => {
  const ok = Math.abs(a - b) <= tol
  if (!ok) fails++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}: ${a.toFixed(2)} (čekáno ${b.toFixed(2)} ±${tol})`)
}
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

/** Složí nejmenší platný DXF: hlavička s jednotkami + úsečky v ENTITIES. */
const makeDxf = (lines, insunits) => {
  const out = ['0', 'SECTION', '2', 'HEADER']
  if (insunits != null) out.push('9', '$INSUNITS', '70', String(insunits))
  out.push('0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES')
  for (const [x1, y1, x2, y2] of lines) {
    out.push('0', 'LINE', '8', 'KRESBA', '10', String(x1), '20', String(y1), '11', String(x2), '21', String(y2))
  }
  out.push('0', 'ENDSEC', '0', 'EOF')
  return out.join('\r\n') + '\r\n'
}

// stavba kolem reálného místa v S-JTSK (Liberec) — 200 úseček na ploše 200 × 200 m
const CX = -675000, CY = -980000
const site = []
for (let i = 0; i < 200; i++) {
  const x = CX + (i % 20) * 10, y = CY + Math.floor(i / 20) * 10
  site.push([x, y, x + 8, y + 8])
}

console.log('\n── čistá kresba: střed sedí na stavbu ──')
{
  const p = dxfToPrims(makeDxf(site, 6))
  near(p.midX, CX + 95, 60, 'medián X')
  near(p.midY, CY + 45, 60, 'medián Y')
  near(p.maxX - p.minX, 198, 15, 'obálka na šířku (m)')
  ok(p.unit === 1, `jednotky metry → přepočet ${p.unit}×`)
}

console.log('\n── dva zatoulané prvky: obálka se rozpadne, medián ne ──')
{
  // přesně ten případ z VRT_Test.dxf: jeden prvek v počátku, jeden v zrcadlovém Křováku
  const p = dxfToPrims(makeDxf([...site, [0, 0, 1, 1], [700000, 1000000, 700001, 1000001]], 6))
  const span = (p.maxX - p.minX) / 1000
  ok(span > 1000, `obálka je kvůli úletům ${span.toFixed(0)} km (tedy k ničemu)`)
  near(p.midX, CX + 95, 60, 'medián X pořád na stavbě')
  near(p.midY, CY + 45, 60, 'medián Y pořád na stavbě')
  // tohle je to podstatné: podle mediánu výkres do Křováku PADNE, podle středu obálky ne
  const inKrovak = (x, y) => x > -950000 && x < -380000 && y > -1260000 && y < -890000
  ok(inKrovak(p.midX, p.midY), 'podle mediánu je výkres rozpoznán jako S-JTSK')
  ok(!inKrovak((p.minX + p.maxX) / 2, (p.minY + p.maxY) / 2), 'podle středu obálky by rozpoznán NEBYL (proto ta změna)')
  // jádro pro přelet musí taky zůstat na stavbě
  near(p.coreMaxX - p.coreMinX, 190, 40, 'jádro na šířku (m) — bez úletů')
}

console.log('\n── jádro NEOŘEZÁVÁ dlouhou trasu ──')
{
  // koridor 80 km: jádro musí zůstat dlouhé, jinak by přelet ukázal jen kousek
  const line = []
  for (let i = 0; i < 400; i++) { const x = CX + i * 200; line.push([x, CY, x + 200, CY + 5]) }
  const p = dxfToPrims(makeDxf(line, 6))
  const coreKm = (p.coreMaxX - p.coreMinX) / 1000
  near(coreKm, 76, 6, 'jádro trasy (km) z 80 km celkem')
}

console.log('\n── jednotky z hlavičky ──')
{
  const mm = site.map(([a, b, c, d]) => [a * 1000, b * 1000, c * 1000, d * 1000])
  const p = dxfToPrims(makeDxf(mm, 4)) // 4 = milimetry
  ok(p.unit === 0.001, `milimetry → přepočet ${p.unit}× (${p.unitName})`)
  near(p.midX, CX + 95, 60, 'po přepočtu je medián X zpátky v metrech')
  near(p.maxX - p.minX, 198, 15, 'po přepočtu sedí i obálka (m)')
}
{
  const p = dxfToPrims(makeDxf(site, undefined)) // bez $INSUNITS
  ok(p.unit === 1, `bez hlavičky se NEPŘEPOČÍTÁVÁ (${p.unitName})`)
}
{
  const p = dxfToPrims(makeDxf(site, 0)) // 0 = bez jednotek (geodetické výkresy)
  ok(p.unit === 1, 'nulové $INSUNITS se taky nepřepočítává')
}

console.log('\n── hlavička nesedí se souřadnicemi v S-JTSK: vyhrají souřadnice ──')
{
  // nejčastější případ: šablona AutoCADu s milimetry, souřadnice v metrech Křováku —
  // podle hlavičky by se vydělily tisícem a výkres by vypadl z Křováku a byl tisíckrát menší
  const p = dxfToPrims(makeDxf(site, 4))
  ok(p.unit === 1, `„milimetry" v hlavičce, souřadnice v metrech → metry (${p.unitName})`)
  near(p.midX, CX + 95, 60, 'medián X zůstal v Křováku')
  near(p.maxX - p.minX, 198, 15, 'velikost sedí (m)')
  ok(!!p.unitNote && p.unitNote.includes('milimetry'), `appka to řekne: „${p.unitNote}"`)
}
{
  // opačně: hlavička „metry", souřadnice ve skutečnosti v milimetrech
  const mm = site.map(([a, b, c, d]) => [a * 1000, b * 1000, c * 1000, d * 1000])
  const p = dxfToPrims(makeDxf(mm, 6))
  ok(p.unit === 0.001, `„metry" v hlavičce, souřadnice v mm → milimetry (${p.unit}×)`)
  near(p.midX, CX + 95, 60, 'po přepočtu medián X v Křováku')
}
{
  // bez hlavičky, souřadnice v milimetrech Křováku
  const mm = site.map(([a, b, c, d]) => [a * 1000, b * 1000, c * 1000, d * 1000])
  const p = dxfToPrims(makeDxf(mm, undefined))
  ok(p.unit === 0.001, `bez hlavičky, souřadnice v mm → milimetry (${p.unit}×)`)
}
{
  // lokální výkres (stavba kolem nuly) v milimetrech: o velikosti rozhoduje hlavička jako dřív
  const local = []
  for (let i = 0; i < 50; i++) local.push([i * 1000, 0, i * 1000 + 500, 500])
  const p = dxfToPrims(makeDxf(local, 4))
  ok(p.unit === 0.001 && !p.unitNote, `lokální výkres v mm → milimetry podle hlavičky (${p.unit}×)`)
  near(p.maxX - p.minX, 49.5, 1, 'lokální výkres má 49,5 m')
}

console.log('\n── zápisy S-JTSK: záporný (CAD), kladný, kladný s prohozenými osami ──')
{
  ok(krovakForm(-675000, -980000) === 'neg', 'záporný zápis z CADu')
  ok(krovakForm(675000, 980000) === 'pos', 'kladný (Y, X)')
  ok(krovakForm(980000, 675000) === 'swap', 'kladný s prohozenými osami (X, Y)')
  ok(krovakForm(1200, 300) === null, 'lokální souřadnice nejsou Křovák')
  const a = toKrovakNeg('pos', 675000, 980000), b = toKrovakNeg('swap', 980000, 675000)
  ok(a[0] === -675000 && a[1] === -980000 && b[0] === -675000 && b[1] === -980000, 'všechny zápisy vedou na stejný bod')
  // a jednotky se poznají i u prohozených os
  const swapped = site.map(([x1, y1, x2, y2]) => [-y1, -x1, -y2, -x2])
  const p = dxfToPrims(makeDxf(swapped, 4))
  ok(p.unit === 1 && krovakForm(p.midX, p.midY) === 'swap', `prohozené osy v metrech s „mm" v hlavičce → metry (${p.unit}×)`)
}

console.log('\n── spliny a oblouky: hladké křivky, žádné rohy ──')
{
  /** DXF s jednou entitou (pole group codů za `0 <typ>`) */
  const one = (type, codes) => ['0', 'SECTION', '2', 'ENTITIES', '0', type, '8', 'K', ...codes.map(String), '0', 'ENDSEC', '0', 'EOF'].join('\r\n') + '\r\n'
  const polyOf = text => dxfToPrims(text).prims.filter(p => p.kind === 'poly').flatMap(p => p.pts)

  // kvadratický spline z řídicích bodů (0,0) (1,2) (2,0): vrchol křivky je (1,1), NE řídicí bod (1,2)
  const q = polyOf(one('SPLINE', [70, 8, 71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 10, 0, 20, 0, 10, 1, 20, 2, 10, 2, 20, 0]))
  const top = Math.max(...q.map(p => p[1]))
  near(top, 1, 0.01, 'spline jde vrcholem (1, 1), ne řídicím bodem (1, 2)')
  ok(q.length > 10, `spline je hladký — ${q.length} bodů, ne 3 rohy`)
  ok(Math.hypot(q[0][0], q[0][1]) < 1e-9 && Math.hypot(q[q.length - 1][0] - 2, q[q.length - 1][1]) < 1e-9, 'začíná a končí v krajních bodech')

  // racionální spline = čtvrtkruh (váhy 1, √2/2, 1): všechny body musí ležet na kružnici r = 1
  const c = polyOf(one('SPLINE', [70, 8, 71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 10, 1, 20, 0, 41, 1, 10, 1, 20, 1, 41, Math.SQRT1_2, 10, 0, 20, 1, 41, 1]))
  const dev = Math.max(...c.map(p => Math.abs(Math.hypot(p[0], p[1]) - 1)))
  ok(dev < 1e-9, `čtvrtkruh zapsaný jako NURBS leží na kružnici (odchylka ${dev.toExponential(1)})`)

  // spline jen z bodů proložení: prochází jimi a mezi nimi je hladký
  const fitPts = [[0, 0], [10, 5], [20, 0], [30, 5]]
  const f = polyOf(one('SPLINE', [70, 8, 71, 3, 74, 4, ...fitPts.flatMap(([x, y]) => [11, x, 21, y])]))
  ok(fitPts.every(([x, y]) => f.some(p => Math.hypot(p[0] - x, p[1] - y) < 1e-6)), 'prochází všemi body proložení')
  ok(f.length > 30, `mezi body proložení je hladký (${f.length} bodů)`)

  // hustá skoro rovná křivka (vrstevnice jako spline, 300 řídicích bodů) nesmí ztěžknout
  const dense = Array.from({ length: 300 }, (_, i) => [i, Math.sin(i / 40) * 3])
  const d = polyOf(one('SPLINE', [70, 8, 71, 3, 73, 300, ...dense.flatMap(([x, y]) => [10, x, 20, y])]))
  ok(d.length < 900, `hustá mírná křivka: ${d.length} bodů na 300 řídicích (ne 16× víc)`)

  // polylinie vyhlazená na spline: řídicí rám (VERTEX 70=16) se nekreslí, jen spočítané body (70=8)
  const vtx = (x, y, fl) => ['0', 'VERTEX', '8', 'K', '10', x, '20', y, '70', fl]
  const pl = ['0', 'SECTION', '2', 'ENTITIES', '0', 'POLYLINE', '8', 'K', '66', '1', '70', '4', '75', '6',
    ...vtx(0, 0, 16), ...vtx(5, 10, 16), ...vtx(10, 0, 16),
    ...vtx(0, 0, 8), ...vtx(2.5, 3.75, 8), ...vtx(5, 5, 8), ...vtx(7.5, 3.75, 8), ...vtx(10, 0, 8),
    '0', 'SEQEND', '0', 'ENDSEC', '0', 'EOF'].map(String).join('\r\n') + '\r\n'
  const s = polyOf(pl)
  ok(!s.some(p => p[0] === 5 && p[1] === 10), 'řídicí rám vyhlazené polylinie se nekreslí (žádný zub do (5, 10))')
  ok(s.length === 5, `kreslí se jen spočítané body křivky (${s.length})`)

  // velký oblouk (R 500 m, hlavička v metrech): tětivy nesmí od oblouku utéct o víc než pár cm
  const arcDxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', '0', 'ARC', '8', 'K', '10', '0', '20', '0', '40', '500', '50', '0', '51', '30',
    '0', 'ENDSEC', '0', 'EOF'].join('\r\n') + '\r\n'
  const a = polyOf(arcDxf)
  let sag = 0
  for (let i = 1; i < a.length; i++) sag = Math.max(sag, 500 - Math.hypot((a[i][0] + a[i - 1][0]) / 2, (a[i][1] + a[i - 1][1]) / 2))
  ok(sag < 0.03, `oblouk R 500 m: tětiva se odchýlí nejvýš ${(sag * 100).toFixed(1)} cm (dřív zhruba 1 m)`)
}

console.log('\n── kódování: UTF-8 i WINDOWS-1250 (tak ukládá AutoCAD u nás) ──')
{
  const label = 'Žluťoučký kůň'
  const withText = makeDxf(site.slice(0, 5), 6)
    .replace('0\r\nENDSEC\r\n0\r\nEOF', `0\r\nTEXT\r\n8\r\nPOPIS\r\n10\r\n${CX}\r\n20\r\n${CY}\r\n40\r\n2\r\n1\r\n${label}\r\n0\r\nENDSEC\r\n0\r\nEOF`)
  // ruční převod do 1250 — Node umí kódovat jen do UTF-8
  const CP1250 = { Ž: 0x8e, ť: 0x9d, č: 0xe8, ý: 0xfd, ů: 0xf9, ň: 0xf2 }
  const cp = Uint8Array.from([...withText].map(ch => CP1250[ch] ?? ch.charCodeAt(0)))
  const utf = new TextEncoder().encode(withText)
  const textOf = buf => dxfToPrims(decodeDxf(buf.buffer)).prims.find(p => p.kind === 'text')?.text
  ok(textOf(utf) === label, `UTF-8 → „${textOf(utf)}"`)
  ok(textOf(cp) === label, `WINDOWS-1250 → „${textOf(cp)}"`)

  // worker i záložní cesta jdou přes parseDrawing — musí dát totéž co přímé volání
  const viaParse = await parseDrawing('vykres.DXF', cp.buffer)
  ok(viaParse.prims.length === 6 && viaParse.prims.some(p => p.kind === 'text' && p.text === label), 'parseDrawing(.DXF) = dxfToPrims(decodeDxf)')
  const err = await parseDrawing('vykres.dwg', cp.buffer).then(() => '', e => e.message)
  ok(err.includes('nevypadá na DWG'), `DXF s příponou .dwg → srozumitelná chyba („${err.slice(0, 40)}…")`)
}

console.log(fails ? `\n${fails} SELHÁNÍ` : '\nVŠE PROŠLO')
process.exit(fails ? 1 : 0)
