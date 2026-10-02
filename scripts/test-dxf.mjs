/**
 * Kontrola čtení DXF (`src/dxf.ts`) — jednotky z hlavičky a odolnost středu proti úletům.
 *
 * Obojí se pozná až v mapě a pozdě: špatné jednotky posunou výkres o tři řády, rozhozený střed
 * ho vyhodí z Křováku a položí „doprostřed pohledu". Na reálném výkresu (VRT_Test.dxf) udělaly
 * dva zatoulané prvky z obálky 2 386 × 2 293 km, takže to není teoretická starost.
 *
 * Spustit: `npm run test:dxf` (Node 24 čte .ts přímo, žádný build není potřeba).
 */
import { decodeDxf, dxfToPrims } from '../src/dxf.ts'
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
