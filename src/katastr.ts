/**
 * Katastr a správní členění z ČÚZK: parcely přes WFS, kraj/okres/obec/k.ú. přes RÚIAN.
 *
 * S-JTSK / Křovák (EPSG:5514) — obě služby vrací geometrii v něm a my ji přepočítáváme na WGS84
 * přes `wgsOf` z `./tiles`; ten import zároveň zaručí, že je definice EPSG:5514 v proj4 zaregistrovaná.
 */
import * as Cesium from 'cesium'
import { wgsOf } from './tiles'
import { pointInRing, ringCentroid } from './rings'
import type { Parcel } from './types'

// ── Správní jednotky (kraj/okres/obec + k.ú.) z ČÚZK RÚIAN (ArcGIS REST) ─────────────────
// RÚIAN MapServer má vrstvy s názvy i kódy a jde dotazovat bodem/jménem/kódem obce.
export type AdminUnit = { level: string; name: string; kod: number; layer: number; obec?: number; rings?: [number, number][][] }
const RUIAN = 'https://ags.cuzk.gov.cz/arcgis/rest/services/RUIAN/MapServer'
const RUIAN_LEVELS: [number, string][] = [[17, 'Kraj'], [15, 'Okres'], [12, 'Obec']] // od největší po nejmenší

/** Dotaz na RÚIAN vrstvu (Esri JSON, geometrie v S-JTSK). geom=true → i prstence. */
export async function ruianQuery(layer: number, where: string, geom: boolean): Promise<Array<{ kod: number; nazev: string; obec?: number; rings: [number, number][][] }>> {
  const url = `${RUIAN}/${layer}/query?where=${encodeURIComponent(where)}&outFields=kod,nazev&returnGeometry=${geom}&outSR=5514&f=json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`RÚIAN: HTTP ${res.status}`)
  const data = await res.json() as { features?: Array<{ attributes?: { kod?: number; nazev?: string; obec?: number }; geometry?: { rings?: number[][][] } }> }
  const out: Array<{ kod: number; nazev: string; obec?: number; rings: [number, number][][] }> = []
  for (const f of data.features || []) {
    const rings = (f.geometry?.rings || []).filter(r => r.length >= 3).map(r => r.map(([x, y]) => [x, y] as [number, number]))
    out.push({ kod: Number(f.attributes?.kod), nazev: (f.attributes?.nazev || '').trim(), obec: f.attributes?.obec, rings })
  }
  return out
}
/** Bodový dotaz na vrstvu (jednotka obsahující bod) — bez geometrie, jen název+kód (rychlé). */
export async function ruianAtPoint(layer: number, lon: number, lat: number): Promise<{ kod: number; nazev: string } | null> {
  const url = `${RUIAN}/${layer}/query?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=kod,nazev&returnGeometry=false&f=json`
  const res = await fetch(url); if (!res.ok) throw new Error(`RÚIAN: HTTP ${res.status}`)
  const data = await res.json() as { features?: Array<{ attributes?: { kod?: number; nazev?: string } }> }
  const a = data.features?.[0]?.attributes
  return a?.nazev ? { kod: Number(a.kod), nazev: a.nazev.trim() } : null
}

/** Kraj/okres/obec obsahující bod (bez geometrie — ta se dotáhne až při výběru). */
export async function fetchAdminUnits(lon: number, lat: number): Promise<AdminUnit[]> {
  // souběžně, každá vrstva sama za sebe; pořadí (kraj → okres → obec) drží `RUIAN_LEVELS`
  const hits = await Promise.all(RUIAN_LEVELS.map(async ([layer, level]): Promise<AdminUnit | null> => {
    try {
      const u = await ruianAtPoint(layer, lon, lat)
      return u ? { level, name: u.nazev, kod: u.kod, layer, obec: level === 'Obec' ? u.kod : undefined } : null
    } catch { return null }
  }))
  return hits.filter((u): u is AdminUnit => u !== null)
}
/** Katastrální území dané obce (kód obce) — názvy + kódy, bez geometrie. */
export async function fetchAdminParts(obecKod: number): Promise<AdminUnit[]> {
  const ku = await ruianQuery(7, `obec=${obecKod}`, false)
  return ku.filter(u => u.nazev).map(u => ({ level: 'k.ú.', name: u.nazev, kod: u.kod, layer: 7 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'))
}
/** Dotáhne prstence (S-JTSK) jednotky podle vrstvy+kódu. */
export async function fetchAdminGeom(layer: number, kod: number): Promise<[number, number][][]> {
  const r = await ruianQuery(layer, `kod=${kod}`, true)
  return r[0]?.rings || []
}

/**
 * Jedna parcela z GML odpovědi ČÚZK WFS. `id` = národní číslo parcely „kód k.ú.-štítek"
 * (`621919-95/1`, `700002-st. 866`), `iskn` = identifikátor parcely v katastru (pro odkaz
 * do Nahlížení do KN), `ku` = název katastrálního území.
 */
export type WfsParcel = { id: string; label: string; knArea: number; iskn?: number; ku?: string; outer: number[][]; holes: number[][][] }

const xmlText = (t: string) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Parcely z GML (= výchozí výstup WFS; `OUTPUTFORMAT=application/json` téže služby nese jen
 * styl a interní id, takže z JSONu výměru ani číslo parcely nedostaneme).
 *
 * `cp:areaValue` je výměra ZAPSANÁ v katastru — není přepočítaná z mapy, proto je to ta,
 * kterou ukazuje ikatastr i list vlastnictví, a v územích s mapou 1:2880 se od geometrie
 * liší o jednotky procent. `cp:label` je číslo parcely („354“, „st. 557“).
 *
 * Geometrie: jeden gml:Polygon, gml:exterior + 0..n gml:interior (vykrojené parcely uvnitř),
 * souřadnice v posList po párech X Y v S-JTSK (EPSG:5514, záporné jako u proj4).
 */
function parseParcelsGml(gml: string): WfsParcel[] {
  const out: WfsParcel[] = []
  for (const chunk of gml.split('<cp:CadastralParcel').slice(1)) {
    const label = (/<cp:label>([^<]*)/.exec(chunk) || [])[1] || ''
    const ref = (/<cp:nationalCadastralReference>([^<]*)/.exec(chunk) || [])[1] || ''
    const kn = parseFloat((/<cp:areaValue[^>]*>([^<]*)/.exec(chunk) || [])[1])
    const iskn = Number((/<base:localId>CP\.(\d+)</.exec(chunk) || [])[1]) || undefined
    const ku = (/<cp:zoning[^>]*xlink:title="([^"]*)"/.exec(chunk) || [])[1]
    let outer: number[][] | null = null
    const holes: number[][][] = []
    for (const m of chunk.matchAll(/<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([\s\S]*?)<\/gml:posList>/g)) {
      const n = m[2].trim().split(/\s+/)
      const ring: number[][] = []
      for (let i = 0; i + 1 < n.length; i += 2) ring.push([parseFloat(n[i]), parseFloat(n[i + 1])])
      if (ring.length < 3) continue
      if (m[1] === 'interior') holes.push(ring)
      else if (!outer) outer = ring
    }
    if (!outer) continue
    out.push({ id: ref || label, label, knArea: isFinite(kn) ? kn : 0, iskn, ku: ku ? xmlText(ku) : undefined, outer, holes })
  }
  return out
}

/**
 * Z kliku najde katastrální parcelu (ČÚZK WFS, GML v S-JTSK) a vrátí obrys ve WGS84.
 * Stáhne víc kandidátů (BBOX matchuje obálky) a vybere tu, jejíž geometrie bod opravdu obsahuje.
 *
 * `null` = v místě žádná parcela není. Výpadek nebo chyba ČÚZK se HÁZÍ — dřív to bylo taky
 * `null` a klik pak tiše neudělal nic, takže se nedalo poznat, jestli je chyba v kliknutí.
 */
export async function fetchParcelAt(lon: number, lat: number): Promise<Parcel | null> {
  // ~10 m bbox, víc kandidátů; BBOX se NEkóduje (ČÚZK chce literální čárky/dvojtečky)
  const d = 0.0001
  const bbox = `${lat - d},${lon - d},${lat + d},${lon + d},urn:ogc:def:crs:EPSG::4326`
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralParcel&COUNT=10&BBOX=${bbox}`
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Katastr (WFS): HTTP ${res.status}`)
  const feats = parseParcelsGml(await res.text())
  if (!feats.length) return null
  const toWgs = (r: number[][]) => r.map(([x, y]) => wgsOf(x, y))
  const cands = feats.map(f => ({ ...f, outerW: toWgs(f.outer), holesW: f.holes.map(toWgs) }))
  // Parcela, která bod skutečně obsahuje. Klik v díře patří té VNITŘNÍ parcele, ne téhle —
  // proto se díry z testu vylučují (dřív klik na dům v zahradě vybral zahradu).
  let chosen = cands.find(c => pointInRing(lon, lat, c.outerW) && !c.holesW.some(h => pointInRing(lon, lat, h)))
  if (!chosen) { // nic netrefeno (klik mimo/na hranu) → nejbližší podle těžiště
    let best = Infinity
    for (const c of cands) {
      const [cx, cy] = ringCentroid(c.outerW)
      const dist = (cx - lon) ** 2 + (cy - lat) ** 2
      if (dist < best) { best = dist; chosen = c }
    }
  }
  if (!chosen) return null
  const toCart = (r: [number, number][]) => r.map(([lo, la]) => Cesium.Cartesian3.fromDegrees(lo, la))
  return {
    id: chosen.id, label: chosen.label, knArea: chosen.knArea, iskn: chosen.iskn, ku: chosen.ku,
    positions: toCart(chosen.outerW), holes: chosen.holesW.map(toCart),
  }
}

// ring/holes = surová geometrie v S-JTSK (EPSG:5514); holes jsou vykrojené parcely uvnitř
export type RawParcel = { id: string; label: string; knArea: number; iskn?: number; ku?: string; ring: number[][]; holes: number[][][] }

/** Všechny katastrální parcely v bboxu (surová S-JTSK geometrie, pro výběr oblastí polygonem).
 *  ČÚZK WFS ignoruje STARTINDEX, ale respektuje vysoký COUNT → jeden dotaz. Reprojekci děláme až u volajícího
 *  (jen těžiště pro test, plnou geometrii pro vybrané) — reprojektovat tisíce parcel celé je zbytečně drahé. */
export async function fetchParcelsInBbox(minLon: number, minLat: number, maxLon: number, maxLat: number): Promise<RawParcel[]> {
  const bbox = `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326`
  const url = `https://services.cuzk.cz/wfs/inspire-cp-wfs.asp?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=cp:CadastralParcel&COUNT=30000&BBOX=${bbox}`
  try {
    // GML i tady, ať mají hromadně vybrané parcely stejná čísla jako ty naklikané
    return parseParcelsGml(await (await fetch(url)).text())
      .map(f => ({ id: f.id, label: f.label, knArea: f.knArea, iskn: f.iskn, ku: f.ku, ring: f.outer, holes: f.holes }))
  } catch { return [] }
}

// ── Parcela podle čísla (RÚIAN) a odkaz do katastru ──────────────────────────────────────

/** Parcela v katastru — Nahlížení do KN ji ukáže i s listem vlastnictví. */
export const knUrl = (iskn: number) => `https://nahlizenidokn.cuzk.gov.cz/ZobrazObjekt.aspx?typ=parcela&id=${iskn}`

/** Parcelní číslo rozložené na části: `st. 866` → stavební 866, `95/1` → pozemková 95 lomeno 1. */
export type ParcelNumber = { st: boolean; kmen: number; sub: number | null }
const NUM_RE = /^(st\.?\s*)?(\d+)(?:\s*\/\s*(\d+))?$/i
export function parseParcelNumber(s: string): ParcelNumber | null {
  const m = NUM_RE.exec(s.trim())
  return m ? { st: !!m[1], kmen: Number(m[2]), sub: m[3] ? Number(m[3]) : null } : null
}
/** Štítek jako v katastru (a v národním čísle parcely): `st. 866`, `95/1`. */
export const parcelLabel = (n: ParcelNumber) => `${n.st ? 'st. ' : ''}${n.kmen}${n.sub != null ? `/${n.sub}` : ''}`

// číslo parcely s volitelným „p.č." a „st.", k.ú. s volitelným „k.ú."
const Q_NUM = String.raw`(?:p\.?\s*č\.?\s*)?((?:st\.?\s*)?\d+(?:\s*\/\s*\d+)?)`
const Q_KU = String.raw`(?:k\.?\s*ú\.?\s*)?(.+?)`
const Q_FIRST = new RegExp(String.raw`^${Q_NUM}(?:\s*,?\s+${Q_KU})?$`, 'i')
const Q_LAST = new RegExp(String.raw`^${Q_KU}\s*,?\s+${Q_NUM}$`, 'i')

/**
 * Hledaná parcela: „95/1 České Budějovice 1", „České Budějovice 1 95/1", „st. 866 Mrač",
 * nebo jen číslo — pak v k.ú. uprostřed obrazovky (`ku: null`). `explicitKind` = číslo
 * nese „st." nebo lomítko, takže je jasné, ve které řadě hledat.
 */
export function parseParcelQuery(q: string): { num: ParcelNumber; ku: string | null; explicitKind: boolean } | null {
  const t = q.trim().replace(/\s+/g, ' ')
  const first = Q_FIRST.exec(t)
  const hit = first ? { n: first[1], ku: first[2] } : (() => { const l = Q_LAST.exec(t); return l ? { n: l[2], ku: l[1] } : null })()
  if (!hit) return null
  const num = parseParcelNumber(hit.n)
  if (!num) return null
  return { num, ku: hit.ku?.trim() || null, explicitKind: num.st }
}

/** Nalezená parcela — geometrie v S-JTSK jako u WFS, `id` ve stejném tvaru jako národní číslo. */
export type ParcelHit = RawParcel & { kuKod: number; obec?: string }

const RUIAN_PARCEL_FIELDS = 'id,kmenovecislo,poddelenicisla,druhcislovanikod,vymeraparcely,katastralniuzemi'
type RuianParcelFeature = {
  attributes?: { id?: number; kmenovecislo?: number; poddelenicisla?: number | null; druhcislovanikod?: number; vymeraparcely?: number; katastralniuzemi?: number }
  geometry?: { rings?: number[][][] }
}
const ringArea = (r: number[][]) => {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]
  return Math.abs(a / 2)
}

/**
 * Dotaz na vrstvu parcel RÚIAN. Obrys = největší prstenec, díry = prstence uvnitř něj (na směru
 * obíhání nezáleží). Parcela z víc oddělených kusů je vzácná; bere se ten největší.
 */
async function ruianParcels(where: string, geom: boolean): Promise<Array<{ iskn: number; num: ParcelNumber; knArea: number; kuKod: number; ring: number[][]; holes: number[][][] }>> {
  const url = `${RUIAN}/5/query?where=${encodeURIComponent(where)}&outFields=${RUIAN_PARCEL_FIELDS}&returnGeometry=${geom}&outSR=5514&f=json`
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`RÚIAN: HTTP ${res.status}`)
  const data = await res.json() as { features?: RuianParcelFeature[]; error?: { message?: string } }
  if (data.error) throw new Error(`RÚIAN: ${data.error.message ?? 'chyba dotazu'}`)
  return (data.features || []).map(f => {
    const a = f.attributes || {}
    const rings = (f.geometry?.rings || []).filter(r => r.length >= 3)
    const ring = rings.reduce<number[][]>((best, r) => (ringArea(r) > ringArea(best) ? r : best), rings[0] ?? [])
    const holes = rings.filter(r => r !== ring && pointInRing(r[0][0], r[0][1], ring))
    return {
      iskn: Number(a.id), knArea: Number(a.vymeraparcely) || 0, kuKod: Number(a.katastralniuzemi),
      num: { st: a.druhcislovanikod === 1, kmen: Number(a.kmenovecislo), sub: a.poddelenicisla ?? null },
      ring, holes,
    }
  })
}
// RÚIAN: druhcislovanikod 1 = stavební parcela („st. 866"), 2 = pozemková
const numWhere = (n: ParcelNumber, anyKind: boolean) =>
  `kmenovecislo=${n.kmen} AND poddelenicisla ${n.sub != null ? `=${n.sub}` : 'IS NULL'}${anyKind ? '' : ` AND druhcislovanikod=${n.st ? 1 : 2}`}`

/**
 * Parcely podle čísla v k.ú. daném začátkem názvu, nebo rovnou kódem. Víc k.ú. stejného jména
 * (Lhota…) se rozliší obcí. Bez „st." v čísle (`explicitKind` false) se berou obě řady.
 */
export async function findParcels(num: ParcelNumber, ku: { name: string } | { kod: number; name: string }, explicitKind: boolean): Promise<ParcelHit[]> {
  let kus: Array<{ kod: number; nazev: string; obec?: number }>
  if ('kod' in ku) kus = [{ kod: ku.kod, nazev: ku.name }]
  else {
    const like = `UPPER(nazev) LIKE UPPER('${ku.name.replace(/'/g, "''")}%')`
    const res = await fetch(`${RUIAN}/7/query?where=${encodeURIComponent(like)}&outFields=kod,nazev,obec&returnGeometry=false&f=json`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`RÚIAN: HTTP ${res.status}`)
    const data = await res.json() as { features?: Array<{ attributes?: { kod?: number; nazev?: string; obec?: number } }> }
    kus = (data.features || []).map(f => ({ kod: Number(f.attributes?.kod), nazev: (f.attributes?.nazev || '').trim(), obec: f.attributes?.obec }))
    // přesná shoda názvu napřed, pak podle abecedy; víc než 12 k.ú. je spíš překlep nebo moc krátký název
    const exact = ku.name.toLocaleLowerCase('cs')
    const isExact = (k: { nazev: string }) => Number(k.nazev.toLocaleLowerCase('cs') === exact)
    kus.sort((a, b) => isExact(b) - isExact(a) || a.nazev.localeCompare(b.nazev, 'cs'))
    kus = kus.slice(0, 12)
  }
  if (!kus.length) return []
  const found = await ruianParcels(`katastralniuzemi IN (${kus.map(k => k.kod).join(',')}) AND ${numWhere(num, !explicitKind)}`, true)
  // obec jen tam, kde by se k.ú. stejného jména jinak nedala rozlišit
  const dup = new Set(kus.filter((k, i) => kus.findIndex(o => o.nazev === k.nazev) !== i).map(k => k.nazev))
  const need = [...new Set(kus.filter(k => dup.has(k.nazev) && k.obec != null).map(k => k.obec as number))]
  const obce = new Map<number, string>()
  if (need.length) for (const o of await ruianQuery(12, `kod IN (${need.join(',')})`, false).catch(() => [])) obce.set(o.kod, o.nazev)
  return found.filter(p => p.ring.length).map(p => {
    const k = kus.find(x => x.kod === p.kuKod)
    const label = parcelLabel(p.num)
    return {
      id: `${p.kuKod}-${label}`, label, knArea: p.knArea, iskn: p.iskn, ku: k?.nazev, kuKod: p.kuKod,
      obec: k?.obec != null && dup.has(k.nazev) ? obce.get(k.obec) : undefined, ring: p.ring, holes: p.holes,
    }
  })
}

/** Názvy katastrálních území podle kódů (pro parcely uložené dřív, než se název ukládal). */
const kuNameCache = new Map<number, string>()
export async function kuNames(codes: number[]): Promise<Map<number, string>> {
  const missing = [...new Set(codes)].filter(c => !kuNameCache.has(c))
  if (missing.length) for (const k of await ruianQuery(7, `kod IN (${missing.join(',')})`, false)) kuNameCache.set(k.kod, k.nazev)
  return new Map(codes.filter(c => kuNameCache.has(c)).map(c => [c, kuNameCache.get(c) as string]))
}

/** Kód k.ú. a štítek z národního čísla parcely (`621919-95/1`), nebo null. */
export function splitParcelId(id: string): { kuKod: number; label: string } | null {
  const m = /^(\d+)-(.+)$/.exec(id)
  return m ? { kuKod: Number(m[1]), label: m[2] } : null
}

/**
 * Identifikátory parcel v katastru podle národního čísla (`621919-95/1`) — pro parcely uložené
 * dřív, než se identifikátor ukládal. Po dávkách, ať se dotaz vejde do adresy.
 */
export async function parcelIskns(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const parsed = ids.flatMap(id => {
    const sp = splitParcelId(id)
    const num = sp ? parseParcelNumber(sp.label) : null
    return sp && num ? [{ id, kuKod: sp.kuKod, num }] : []
  })
  for (let i = 0; i < parsed.length; i += 25) {
    const batch = parsed.slice(i, i + 25)
    const where = batch.map(p => `(katastralniuzemi=${p.kuKod} AND ${numWhere(p.num, false)})`).join(' OR ')
    for (const r of await ruianParcels(where, false)) {
      const id = `${r.kuKod}-${parcelLabel(r.num)}`
      if (batch.some(p => p.id === id)) out.set(id, r.iskn)
    }
  }
  return out
}
