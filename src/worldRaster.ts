/**
 * Import georeferencovaného rastru: obrázek + world file (.jgw/.pgw/.tfw/.wld), volitelně .prj.
 * GeoTIFF (.tif) si georeferenci nese sám, tam world file potřeba není.
 *
 * Rastr se do scény přidá jako běžná imagery vrstva NAD ČÚZK podkladem — drapuje se na terén
 * úplně stejně jako ortofoto, takže jde „přelepit" kus mapy aktuálním snímkem (dron, čerstvé
 * ortofoto odjinud). Průhledností se překryv jen přimíchá, na 100 % ten kus mapy nahradí.
 *
 * ZAROVNÁNÍ je tady to jediné podstatné: world file je afinní převod pixel → souřadnice v CRS
 * souboru (u nás skoro vždy S-JTSK). Křovák je ale vůči zeměpisné síti POOTOČENÝ (v ČR o ~7°),
 * takže obdélník v S-JTSK NENÍ obdélník v lon/lat — kdyby se jen přepočítaly rohy a snímek se
 * natáhl do obdélníku (SingleTileImageryProvider), byl by po okrajích posunutý o desítky metrů.
 * Proto se rastr přepočítává po dlaždicích: pro každou dlaždici se z 3×3 přesně převedených
 * vzorků proloží afinní mapa zdroj→dlaždice a canvas ji vykreslí přes `setTransform`. Uvnitř
 * jedné dlaždice je Křovák prakticky afinní, takže zbytková chyba je hluboko pod pixelem —
 * a kreslí to prohlížeč, ne JS smyčka, takže to zvládne i velké snímky.
 */
import * as Cesium from 'cesium'
import proj4 from 'proj4'
import { fromBlob } from 'geotiff'
// Kvůli vedlejšímu efektu: `tiles.ts` je jediné místo, kde žije definice EPSG:5514 pro proj4.
import './tiles'

// UTM 33N pokrývá skoro celou ČR — běžný výstup dronové fotogrammetrie (Pix4D, Agisoft).
proj4.defs('EPSG:32633', '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs')

// Dlaždice 512 jako u ČÚZK WMS (viz imagery.ts): míň dlaždic, míň švů, míň režie na stejnou plochu.
const TILE = 512
// Strop dekódování. Kvalita má přednost, tak je nastavený vysoko — jde jen o to, aby se
// prohlížeč nesložil (snímek se v paměti rozbalí na 4 B/px) a aby šel pak vůbec vykreslit.
const MAX_DIM = 16_384
const MAX_PIXELS = 150_000_000
// Strop jednoho patra pyramidy. Nulté patro je nativní bitmap (ten se nezmenšuje nikdy),
// tohle omezuje jen zmenšené kopie, aby si velký snímek nevzal víc paměti, než musí.
const PYR_MAX_PIXELS = 40_000_000

// ── world file ──────────────────────────────────────────────────────────────────────

/**
 * Afinní převod pixel → souřadnice v CRS souboru. Pořadí polí kopíruje řádky world filu:
 * X = ax*sloupec + bx*řádek + x0, Y = ay*sloupec + by*řádek + y0.
 * `x0`/`y0` míří na STŘED levého horního pixelu (tak je world file definovaný).
 */
export type WorldAffine = { ax: number; ay: number; bx: number; by: number; x0: number; y0: number }

/** Přečte world file (6 čísel na 6 řádcích). null = nejsou to čísla nebo je matice singulární. */
export function parseWorldFile(text: string): WorldAffine | null {
  const n = text.trim().split(/\s+/).map(Number)
  if (n.length < 6 || n.slice(0, 6).some(v => !Number.isFinite(v))) return null
  const w: WorldAffine = { ax: n[0], ay: n[1], bx: n[2], by: n[3], x0: n[4], y0: n[5] }
  if (Math.abs(w.ax * w.by - w.bx * w.ay) < 1e-12) return null // nulová plocha pixelu = nesmysl
  return w
}

/**
 * Přepočet world filu na ZMENŠENÝ rastr. World file platí pro původní mřížku W×H; když se
 * obrázek při dekódování zmenšil, musí se posunout i střed prvního pixelu, jinak je snímek
 * o půl pixelu vedle. `sx`/`sy` = kolik původních pixelů připadá na jeden nový.
 */
function rescaleWorld(w: WorldAffine, sx: number, sy: number): WorldAffine {
  if (sx === 1 && sy === 1) return w
  return {
    ax: w.ax * sx, bx: w.bx * sy, x0: w.x0 + w.ax * (sx - 1) / 2 + w.bx * (sy - 1) / 2,
    ay: w.ay * sx, by: w.by * sy, y0: w.y0 + w.ay * (sx - 1) / 2 + w.by * (sy - 1) / 2,
  }
}

// ── souřadnicové systémy ────────────────────────────────────────────────────────────

export const CRS_IDS = ['sjtsk', 'wgs84', 'webmerc', 'utm33n'] as const
export type CrsId = (typeof CRS_IDS)[number]
export const CRS_LABELS: Record<CrsId, string> = {
  sjtsk: 'S-JTSK (Křovák)',
  wgs84: 'WGS84 (°)',
  webmerc: 'Web Mercator',
  utm33n: 'UTM 33N',
}

type Crs = { fromWgs(lon: number, lat: number): [number, number]; toWgs(x: number, y: number): [number, number] }

/**
 * Převodník mezi WGS84 a soustavou souboru.
 *
 * S-JTSK je zvláštní případ: proj4 vydává obě souřadnice ZÁPORNÉ a v ČR vždy platí |X| < |Y|.
 * Soubory ale chodí i s kladnými hodnotami a/nebo s prohozenými osami („jihozápadní" JTSK).
 * Konvenci si proto přečteme z levého horního rohu world filu a pak ji držíme v OBOU směrech —
 * normalizace bod po bodu by nešla obrátit a snímek by skončil zrcadlově.
 */
function makeCrs(id: CrsId, w: WorldAffine): Crs {
  if (id === 'sjtsk') {
    const swap = Math.abs(w.x0) > Math.abs(w.y0) // první složka je ta „velká" → osy prohozené
    const neg = w.x0 < 0                          // uloženo záporně = tak, jak to dává proj4
    return {
      fromWgs(lon, lat) {
        const [px, py] = proj4('EPSG:4326', 'EPSG:5514', [lon, lat]) as [number, number]
        const a = neg ? px : -px, b = neg ? py : -py
        return swap ? [b, a] : [a, b]
      },
      toWgs(x, y) {
        let a = swap ? y : x, b = swap ? x : y
        if (!neg) { a = -a; b = -b }
        return proj4('EPSG:5514', 'EPSG:4326', [a, b]) as [number, number]
      },
    }
  }
  if (id === 'wgs84') return { fromWgs: (lon, lat) => [lon, lat], toWgs: (x, y) => [x, y] }
  const code = id === 'webmerc' ? 'EPSG:3857' : 'EPSG:32633'
  return {
    fromWgs: (lon, lat) => proj4('EPSG:4326', code, [lon, lat]) as [number, number],
    toWgs: (x, y) => proj4(code, 'EPSG:4326', [x, y]) as [number, number],
  }
}

/** Odhad soustavy: nejdřív z .prj (když je), jinak podle řádu souřadnic levého horního rohu. */
export function detectCrs(w: WorldAffine, prj?: string | null): CrsId {
  if (prj) {
    const t = prj.toLowerCase()
    if (/krovak|s-jtsk|s_jtsk|jtsk|5514|5513/.test(t)) return 'sjtsk'
    if (/pseudo-mercator|3857|900913/.test(t)) return 'webmerc'
    if (/utm[\s_-]*zone[\s_-]*33|32633/.test(t)) return 'utm33n'
    if (/4326|wgs[\s_]*84/.test(t) && !/projcs/.test(t)) return 'wgs84'
  }
  const ax = Math.abs(w.x0), ay = Math.abs(w.y0)
  if (ax <= 180 && ay <= 90) return 'wgs84'
  const lo = Math.min(ax, ay), hi = Math.max(ax, ay)
  if (lo > 400_000 && lo < 950_000 && hi > 900_000 && hi < 1_250_000) return 'sjtsk'
  if (ay > 5_000_000 && ay < 7_500_000 && ax < 1_000_000) return 'utm33n' // UTM: sever ~5,4 mil. m
  if (ay > 5_000_000) return 'webmerc'                                    // Mercator: sever ~6,4 mil. m
  return 'sjtsk'
}

/** EPSG kód z GeoTIFF geokeys → naše id (co neznáme, se doodhadne podle rozsahu souřadnic). */
function crsFromEpsg(epsg: number | undefined): CrsId | null {
  if (epsg === 5514 || epsg === 5513 || epsg === 2065) return 'sjtsk'
  if (epsg === 3857 || epsg === 900913 || epsg === 3785) return 'webmerc'
  if (epsg === 32633) return 'utm33n'
  if (epsg === 4326) return 'wgs84'
  return null
}

// ── dekódování obrázku + pyramida ───────────────────────────────────────────────────

type PyrLevel = { img: CanvasImageSource; w: number; h: number; scale: number }
/** Dekódovaný rastr: nulté patro je nativní bitmap, další jsou zmenšené kopie (kvůli oddálení). */
export type RasterSrc = { levels: PyrLevel[]; width: number; height: number }

/**
 * Zmenšené kopie snímku po mocninách dvou. Bez nich by prohlížeč při oddálení mačkal celý
 * snímek do jedné dlaždice jediným `drawImage` — to je pomalé a hlavně to nehezky šumí.
 *
 * Kroky jsou přesně 2×, aby se při výběru patra nikdy nemuselo zvětšovat (viz `requestImage`).
 * Patra nad `PYR_MAX_PIXELS` se přeskočí — u obřích snímků by si vzala stovky MB; přeskočené
 * patro stojí jen o něco větší zmenšování z toho nejbližšího, což `imageSmoothingQuality`
 * odfiltruje.
 */
function buildPyramid(base: ImageBitmap): PyrLevel[] {
  const W = base.width, H = base.height
  const levels: PyrLevel[] = [{ img: base, w: W, h: H, scale: 1 }]
  let prev = levels[0]
  for (let d = 2; Math.max(W, H) / d >= 128; d *= 2) {
    const cw = Math.max(1, Math.round(W / d)), ch = Math.max(1, Math.round(H / d))
    if (cw * ch > PYR_MAX_PIXELS) continue // moc velké patro → přeskočit, zmenší se z předchozího
    const c = document.createElement('canvas'); c.width = cw; c.height = ch
    const g = c.getContext('2d')
    if (!g) break
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
    g.drawImage(prev.img, 0, 0, prev.w, prev.h, 0, 0, cw, ch)
    prev = { img: c, w: cw, h: ch, scale: cw / W }
    levels.push(prev)
  }
  return levels
}

/** Uvolní nativní bitmap (canvasy sebere GC sám). */
export function disposeRasterSrc(src: RasterSrc) {
  const base = src.levels[0]?.img
  if (base instanceof ImageBitmap) base.close()
}

/**
 * Rozměry z hlavičky souboru, bez dekódování. Potřebné proto, aby se dalo případné zmenšení
 * zadat rovnou do `createImageBitmap` — prohlížeč pak u JPEGu škáluje už při dekódování
 * (DCT), což je rychlejší i hezčí než dekódovat naplno a teprve pak zmenšovat.
 */
async function sniffSize(file: File): Promise<{ w: number; h: number } | null> {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  if (head.length > 24 && head[0] === 0x89 && head[1] === 0x50) // PNG: IHDR hned za signaturou
    return { w: dv.getUint32(16), h: dv.getUint32(20) }
  if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) { // JPEG: projít markery po SOFn
    let i = 2
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) { i++; continue }
      const m = head[i + 1]
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) }
      i += 2 + dv.getUint16(i + 2)
    }
  }
  return null // neznámý formát → zkusí se rovnou nativní dekódování
}

/**
 * JPG/PNG/WEBP přes prohlížeč, přednostně v NATIVNÍM rozlišení — kvalita je tady priorita.
 * Zmenšuje se jen tehdy, když by se snímek do paměti nevešel (v RAM je to 4 B/px) nebo když
 * dekódování opravdu selže; pak se jde po polovinách dolů. Vrací i měřítko a původní rozměry,
 * aby se dal přepočítat world file a dalo se uživateli říct, že se muselo slevit.
 */
async function decodePlain(file: File) {
  const size = await sniffSize(file)
  const fits = (d: number) => !size
    || ((size.w / d) * (size.h / d) <= MAX_PIXELS && Math.max(size.w, size.h) / d <= MAX_DIM)
  const steps = [1, 2, 4, 8, 16]
  const first = Math.max(0, steps.findIndex(fits))
  for (let i = first; i < steps.length; i++) {
    const d = steps[i]
    try {
      const bmp = d === 1 || !size
        ? await createImageBitmap(file)
        : await createImageBitmap(file, {
          resizeWidth: Math.max(1, Math.round(size.w / d)),
          resizeHeight: Math.max(1, Math.round(size.h / d)),
          resizeQuality: 'high',
        })
      const native = size ?? { w: bmp.width, h: bmp.height }
      return { bmp, sx: native.w / bmp.width, sy: native.h / bmp.height, native }
    } catch { if (!size) break /* bez rozměrů se zmenšit nedá */ }
  }
  throw new Error(`Obrázek „${file.name}" se nepodařilo dekódovat`)
}

/**
 * GeoTIFF: dekóduje rovnou na cílové rozlišení (geotiff.js umí převzorkovat při čtení, takže
 * obří listy neprojdou pamětí v plné velikosti) a zároveň vytáhne georeferenci z tagů.
 */
async function decodeTiff(file: File) {
  const img = await (await fromBlob(file)).getImage()
  const W = img.getWidth(), H = img.getHeight()
  const s = Math.min(1, MAX_DIM / Math.max(W, H), Math.sqrt(MAX_PIXELS / (W * H)))
  const tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s))
  const spp = img.getSamplesPerPixel()
  const raw = await img.readRasters({ width: tw, height: th, interleave: true }) as unknown as ArrayLike<number>

  // 8bitové ortofoto je pravidlo, ale 16bit se občas objeví → podle maxima to srovnáme do 0..255
  let max = 0
  const step = Math.max(1, Math.floor(raw.length / 100_000))
  for (let i = 0; i < raw.length; i += step) if (raw[i] > max) max = raw[i]
  const k = max > 255 ? 255 / max : 1

  const rgba = new Uint8ClampedArray(tw * th * 4)
  for (let p = 0, o = 0; p < tw * th; p++, o += 4) {
    const b = p * spp
    if (spp >= 3) {
      rgba[o] = raw[b] * k; rgba[o + 1] = raw[b + 1] * k; rgba[o + 2] = raw[b + 2] * k
      rgba[o + 3] = spp >= 4 ? raw[b + 3] * k : 255
    } else {
      const g = raw[b] * k
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255
    }
  }
  const bmp = await createImageBitmap(new ImageData(rgba, tw, th))

  // georeference z tagů: origin je ROH rastru, world file chce STŘED prvního pixelu
  let world: WorldAffine | null = null
  let crsId: CrsId | null = null
  try {
    const res = img.getResolution() as number[]
    const org = img.getOrigin() as number[]
    if (Number.isFinite(res?.[0]) && Number.isFinite(org?.[0])) {
      const rx = res[0] * (W / tw), ry = res[1] * (H / th)
      world = { ax: rx, ay: 0, bx: 0, by: ry, x0: org[0] + rx / 2, y0: org[1] + ry / 2 }
    }
    const keys = (img.getGeoKeys?.() ?? {}) as { ProjectedCSTypeGeoKey?: number; GeographicTypeGeoKey?: number }
    crsId = crsFromEpsg(keys.ProjectedCSTypeGeoKey) ?? crsFromEpsg(keys.GeographicTypeGeoKey)
  } catch { /* tagy chybí → dojede se na world file */ }

  return { bmp, sx: W / tw, sy: H / th, native: { w: W, h: H }, world, crsId }
}

// ── načtení rastru ze souborů ───────────────────────────────────────────────────────

const IMG_RE = /\.(jpe?g|png|webp|tiff?)$/i
const WLD_RE = /\.(jgw|jpgw|jpegw|pgw|pngw|tfw|tifw|wld)$/i
const stem = (n: string) => n.replace(/\.[^.]+$/, '').toLowerCase()

/** Rozdělí vybrané soubory na trojice obrázek + world file + .prj (páruje se podle názvu). */
export function pairRasterFiles(files: File[]): { image: File; world?: File; prj?: File }[] {
  return files.filter(f => IMG_RE.test(f.name)).map(image => ({
    image,
    world: files.find(f => WLD_RE.test(f.name) && stem(f.name) === stem(image.name)),
    prj: files.find(f => /\.prj$/i.test(f.name) && stem(f.name) === stem(image.name)),
  }))
}

/**
 * Rastr připravený k zobrazení — pixely + georeference. `crsId` jde pak ještě přepnout ručně.
 * `native` = rozměry PŮVODNÍHO souboru; když se liší od `src.width/height`, musel se snímek
 * kvůli paměti prohlížeče zmenšit (viz `decodePlain`) a je fér to říct.
 */
export type GeoRaster = { name: string; src: RasterSrc; world: WorldAffine; crsId: CrsId; native: { w: number; h: number } }

export async function loadGeoRaster(image: File, world?: File, prj?: File): Promise<GeoRaster> {
  const prjText = prj ? await prj.text() : null
  const fromFile = world ? parseWorldFile(await world.text()) : null
  const isTiff = /\.tiff?$/i.test(image.name)

  const dec = isTiff
    ? await decodeTiff(image)
    : { ...await decodePlain(image), world: null as WorldAffine | null, crsId: null as CrsId | null }

  // world file má přednost před tagy v TIFFu: když ho uživatel přiložil, chce ho použít
  const raw = fromFile ?? dec.world
  if (!raw) {
    dec.bmp.close()
    throw new Error(`K souboru „${image.name}" chybí world file (.jgw/.pgw/.tfw) — vyber ho spolu s obrázkem`)
  }

  return {
    name: image.name,
    src: { levels: buildPyramid(dec.bmp), width: dec.bmp.width, height: dec.bmp.height },
    // .jgw platí pro PŮVODNÍ mřížku → přepočítat na (případně zmenšený) rastr;
    // georeference z TIFF tagů je naopak dopočítaná už pro zmenšenou mřížku
    world: fromFile ? rescaleWorld(raw, dec.sx, dec.sy) : raw,
    crsId: (fromFile ? null : dec.crsId) ?? detectCrs(raw, prjText),
    native: dec.native,
  }
}

// ── imagery provider ────────────────────────────────────────────────────────────────

/** Průhledná zástupná dlaždice (mimo snímek). Vlastní canvas pokaždé — Cesium si texturu bere samo. */
function blank(): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = 1; c.height = 1
  return c
}

/** Gaussova eliminace 3×3 s částečnou pivotací. null = singulární (vzorky na přímce). */
function solve3(m: number[][], r: number[]): number[] | null {
  const a = [[...m[0], r[0]], [...m[1], r[1]], [...m[2], r[2]]]
  for (let i = 0; i < 3; i++) {
    let p = i
    for (let k = i + 1; k < 3; k++) if (Math.abs(a[k][i]) > Math.abs(a[p][i])) p = k
    if (Math.abs(a[p][i]) < 1e-9) return null
    const t = a[i]; a[i] = a[p]; a[p] = t
    for (let k = 0; k < 3; k++) {
      if (k === i) continue
      const f = a[k][i] / a[i][i]
      for (let j = i; j < 4; j++) a[k][j] -= f * a[i][j]
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]]
}

const scratchRect = new Cesium.Rectangle()

/**
 * Rastr jako dlaždicová imagery vrstva. Dědí z `UrlTemplateImageryProvider` jen kvůli hotové
 * mechanice dlaždic (rozsah, úrovně, cache) — `url` se nikdy nepoužije, `requestImage` je celý náš.
 */
class WarpedRaster extends Cesium.UrlTemplateImageryProvider {
  private src: RasterSrc
  private crs: Crs
  private wf: WorldAffine
  private det: number

  constructor(o: { src: RasterSrc; crs: Crs; world: WorldAffine; rectangle: Cesium.Rectangle; maximumLevel: number }) {
    super({
      url: 'data:,', // nikdy se nestahuje
      rectangle: o.rectangle,
      tilingScheme: new Cesium.GeographicTilingScheme(),
      tileWidth: TILE, tileHeight: TILE,
      minimumLevel: 0, maximumLevel: o.maximumLevel,
      hasAlphaChannel: true,
      enablePickFeatures: false,
    })
    this.src = o.src; this.crs = o.crs; this.wf = o.world
    this.det = o.world.ax * o.world.by - o.world.bx * o.world.ay
  }

  /** souřadnice v CRS souboru → pixel rastru (inverze world filu) */
  private pixOf(X: number, Y: number): [number, number] {
    const w = this.wf, dx = X - w.x0, dy = Y - w.y0
    return [(w.by * dx - w.bx * dy) / this.det, (-w.ay * dx + w.ax * dy) / this.det]
  }

  /**
   * Afinní mapa pixel rastru → pixel dlaždice, proložená nejmenšími čtverci přes 3×3 vzorků.
   * Vzorkuje se v PRŮNIKU dlaždice se snímkem, ne přes celou dlaždici: při velkém oddálení
   * pokrývá dlaždice půl republiky, kde už zakřivení Křováku znát je — takhle se proložení drží
   * tam, kde jsou opravdu data.
   */
  private fit(rect: Cesium.Rectangle, hit: Cesium.Rectangle) {
    let Scc = 0, Scr = 0, Sc = 0, Srr = 0, Sr = 0, S1 = 0
    let Scx = 0, Srx = 0, Sx = 0, Scy = 0, Sry = 0, Sy = 0
    const N = 4 // 4×4 vzorků: dlaždice je 512 px, tedy 4× větší plocha než dříve při 256
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const lon = hit.west + (hit.east - hit.west) * (i / (N - 1))
      const lat = hit.south + (hit.north - hit.south) * (j / (N - 1))
      const [X, Y] = this.crs.fromWgs(Cesium.Math.toDegrees(lon), Cesium.Math.toDegrees(lat))
      const [col, row] = this.pixOf(X, Y)
      if (!Number.isFinite(col) || !Number.isFinite(row)) return null
      const px = (lon - rect.west) / rect.width * TILE
      const py = (rect.north - lat) / rect.height * TILE
      Scc += col * col; Scr += col * row; Sc += col; Srr += row * row; Sr += row; S1 += 1
      Scx += col * px; Srx += row * px; Sx += px
      Scy += col * py; Sry += row * py; Sy += py
    }
    const m = [[Scc, Scr, Sc], [Scr, Srr, Sr], [Sc, Sr, S1]]
    const u = solve3(m, [Scx, Srx, Sx]) // px = u0*sloupec + u1*řádek + u2
    const v = solve3(m, [Scy, Sry, Sy])
    if (!u || !v) return null
    return { a: u[0], b: v[0], c: u[1], d: v[1], e: u[2], f: v[2] }
  }

  requestImage(x: number, y: number, level: number): Promise<Cesium.ImageryTypes> | undefined {
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level)
    const hit = Cesium.Rectangle.intersection(rect, this.rectangle, scratchRect)
    if (!hit || hit.width <= 0 || hit.height <= 0) return Promise.resolve(blank())
    const m = this.fit(rect, hit)
    if (!m) return Promise.resolve(blank())

    // Patro pyramidy: nejmenší kopie, která se ještě NEMUSÍ ZVĚTŠOVAT. Zvětšovat zmenšenou
    // kopii je ta nejhorší varianta — detail už je z ní pryč a rozmazáním se nevrátí. Takhle
    // se vždycky jen zmenšuje (a kroky pyramidy jsou 2×, takže nanejvýš dvakrát).
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) // zdrojový px → px dlaždice
    let k = 0
    for (let i = 1; i < this.src.levels.length; i++) {
      if (this.src.levels[i].scale < scale) break
      k = i
    }
    const lv = this.src.levels[k]

    const c = document.createElement('canvas'); c.width = TILE; c.height = TILE
    const g = c.getContext('2d')
    if (!g) return Promise.resolve(blank())
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
    // souřadnice patra jsou zdrojové krát `lv.scale` → matici o to zpátky roztáhnout
    const s = 1 / lv.scale
    g.setTransform(m.a * s, m.b * s, m.c * s, m.d * s, m.e, m.f)
    g.drawImage(lv.img, 0, 0)
    return Promise.resolve(c)
  }
}

/** Hotová vrstva pro panel: provider, obálka pro přelet a velikost pixelu v terénu. */
export type RasterView = { provider: Cesium.ImageryProvider; rectangle: Cesium.Rectangle; gsd: number }

/**
 * Postaví provider pro daný rastr v dané soustavě. Obálka se počítá vzorkováním PO OBVODU
 * (ne jen ze 4 rohů) — pootočený a mírně zakřivený obdélník jinak z obálky kouskem vyčuhuje.
 */
export function makeRasterView(r: GeoRaster, crsId: CrsId): RasterView {
  const crs = makeCrs(crsId, r.world)
  const w = r.world
  const at = (col: number, row: number) => crs.toWgs(w.ax * col + w.bx * row + w.x0, w.ay * col + w.by * row + w.y0)

  // rohy pixelové mřížky leží na -0,5 a (n-1)+0,5, protože world file míří na střed pixelu
  const c0 = -0.5, c1 = r.src.width - 0.5, r0 = -0.5, r1 = r.src.height - 0.5
  let west = 180, east = -180, south = 90, north = -90
  for (let i = 0; i <= 16; i++) {
    const t = i / 16
    const edge: [number, number][] = [
      [c0 + (c1 - c0) * t, r0], [c0 + (c1 - c0) * t, r1],
      [c0, r0 + (r1 - r0) * t], [c1, r0 + (r1 - r0) * t],
    ]
    for (const [col, row] of edge) {
      const [lon, lat] = at(col, row)
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      if (lon < west) west = lon
      if (lon > east) east = lon
      if (lat < south) south = lat
      if (lat > north) north = lat
    }
  }
  if (!(east > west && north > south)) throw new Error('Souřadnice ze world filu nedávají platnou obálku — zkontroluj soustavu')
  const rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north)

  // Nejvyšší úroveň = ta, kde je dlaždice právě tak jemná jako nativní pixel snímku. Jemnější
  // strop by nic nepřidal: sítě by se natahoval už jednou zvětšený obraz a pak ho ještě zvětšila
  // grafika (dvojí rozmazání) — takhle se do textury dostanou nativní pixely a zvětšuje se jen
  // jednou, až na kartě. Bere se JEMNĚJŠÍ z obou směrů: dlaždice jsou čtvercové ve stupních,
  // ale pixel snímku je čtvercový v metrech, takže v zeměpisné šířce vychází ~1,6× hustší.
  const p0 = at(0, 0), p1 = at(1, 0), p2 = at(0, 1)
  const degPx = Math.min(
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
    Math.hypot(p2[0] - p0[0], p2[1] - p0[1]),
  )
  const lvl = degPx > 0 ? Math.ceil(Math.log2(180 / (TILE * degPx))) : 18
  const maximumLevel = Math.max(1, Math.min(22, lvl))

  const gsd = Cesium.Cartesian3.distance(
    Cesium.Cartesian3.fromDegrees(p0[0], p0[1]),
    Cesium.Cartesian3.fromDegrees(p1[0], p1[1]),
  )

  return { provider: new WarpedRaster({ src: r.src, crs, world: w, rectangle, maximumLevel }), rectangle, gsd }
}
