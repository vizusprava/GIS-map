/**
 * Rastrové podklady z ČÚZK: ortofoto, základní topografická mapa (ZTM) a katastrální překryv.
 *
 * Ortofoto i topografická mapa jedou z DLAŽDICOVÉ CACHE ČÚZK — hotové dlaždice, které server jen
 * pošle. Dřív šlo ortofoto přes WMS, který každou dlaždici renderoval na dotaz. Změřeno na Liberci:
 *
 *     WMS (PNG 512 px) … 449 kB, 0,8–1,0 s na dlaždici
 *     cache ORTOFOTO_WM …  27 kB, 0,1 s na dlaždici (256 px, tedy čtvrtina plochy)
 *
 * Kvalita se tím nemění: cache jde do úrovně 20, tedy ~9 cm na pixel na zemi, což je jemnější než
 * zdrojový snímek. Katastr zůstává na WMS — jeho kresba se mění a hotovou cache ČÚZK nemá.
 */
import * as Cesium from 'cesium'
import { bakedGet } from './cache'
import { CR_EXTENT, LIBEREC_EXTENT } from './config'
import { KATASTR_LAYERS, KATASTR_WMS } from './tiles'

// Volitelný externí lokální dlaždicový server (viz scripts/tile-server.mjs) — má přednost.
export const LOCAL_TILES = import.meta.env.VITE_LOCAL_TILES as string | undefined

// ── Dlaždicové cache ČÚZK (Web Mercator, XYZ jako OpenStreetMap) ──

const ORTO_CACHE = 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile'
const ZTM_CACHE = 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ZTM_WM/MapServer/tile'

/**
 * Nejjemnější úroveň ortofota. Ověřeno dotazem na službu: úroveň 20 (~9 cm/px na zemi u nás)
 * ještě nese detail navíc proti 19, od 21 výš cache vrací 404. Hlouběji si Cesium dlaždici
 * jen zvětší samo — přesně tam, kde dřív WMS na serveru renderoval zvětšeninu bez detailu.
 */
export const ORTO_MAX_LEVEL = 20
/** Hrubší úrovně ČÚZK nemá (jen pár dlaždic na celý svět) a pod tou se mapa stejně nekreslí. */
const CACHE_MIN_LEVEL = 6

/**
 * Velikost dlaždice ortofota, jak ji hlásíme Cesiu. Dlaždice mají ve skutečnosti 256 px; poloviční
 * údaj je ZÁMĚR, stejný trik jako u topa (viz `ztmProvider`).
 *
 * Cesium volí úroveň ortofota podle dlaždice terénu, na kterou se kreslí, a ta se řídí chybou
 * v CSS pixelech. Na displeji se škálováním 150 % tak jeden pixel ortofota zabral skoro čtyři
 * fyzické pixely a mapa byla rozmazaná, přestože ČÚZK má detail o dvě úrovně jemnější. Poloviční
 * údaj sáhne o úroveň hloub JEN u ortofota — glóbus, terén a počet dlaždic k vykreslení zůstanou.
 *
 * Změřeno na Českých Budějovicích, pohled shora s 30 cm na CSS pixel, škálování 150 %,
 * kvalitní profil, prázdná cache:
 *
 *     256 px … úroveň 17, 3,9 fyz. px na pixel ortofota,  48 dlaždic /  1,9 MB,  5,7 s
 *     128 px … úroveň 18, 1,9 fyz. px na pixel ortofota, 147 dlaždic /  5,1 MB,  5,8 s
 *      64 px … úroveň 19, 1,0 fyz. px na pixel ortofota, 522 dlaždic / 16,9 MB, 11,7 s
 *
 * 128 je kompromis: viditelně ostřejší za stejný čas načtení. 64 by přidalo už jen trochu ostrosti
 * za trojnásobek dat a dvojnásobný čas. Úsporný profil nepředstahuje okolní dlaždice, takže tam
 * vyjde 84 dlaždic / 2,8 MB (proti 43 / 1,7 MB).
 */
const ORTO_TILE_PX = 128

/** URL jedné dlaždice ortofota z cache — pro zobrazení i napečení lokální mapy. */
export function orthoTileUrl(level: number, x: number, y: number): string {
  return `${ORTO_CACHE}/${level}/${y}/${x}`
}

/**
 * Index napečených ortofoto dlaždic („lokální mapa") v paměti — synchronní kontrola v requestImage.
 * Plní se z IndexedDB (store BAKED) při startu. Klíč viz `orthoBakedKey`.
 */
export const bakedKeys = new Set<string>()

/**
 * Klíč napečené dlaždice: mřížka cache ORTOFOTO_WM (Web Mercator, z/x/y).
 *
 * Předpona `owm/` se liší od staré `owms/` (geografická mřížka WMS) schválně: staré dlaždice
 * se do nové mřížky nedají přepočítat, takže je MapView při startu najde a smaže.
 */
export const orthoBakedKey = (level: number, x: number, y: number) => `owm/${level}/${x}/${y}`
/** Předpona klíčů staré lokální mapy (WMS), kterou je potřeba uklidit. */
export const LEGACY_BAKED_PREFIX = 'owms/'

// čerstvá průhledná 1×1 dlaždice (Cesium ImageBitmap po použití zavírá → nesdílet jednu instanci)
function blankTile(): Promise<ImageBitmap> {
  const c = document.createElement('canvas'); c.width = 1; c.height = 1
  return createImageBitmap(c)
}

/**
 * Dlaždicová cache ČÚZK jako vrstva Cesia, se dvěma úpravami proti obyčejnému UrlTemplate:
 *
 *  - Dlaždice, kterou cache NEMÁ (za hranicí ČR, ale uvnitř obdélníku republiky), vrací 404.
 *    Cesium by ji ohlásilo jako chybu do konzole — a u hranic takových jsou desítky. Tady se
 *    místo ní vrátí průhledná dlaždice. Jiné chyby (výpadek sítě) se propouští, ať to Cesium
 *    může zkusit znovu.
 *  - Volitelně napečená lokální mapa (`baked`): co je v IndexedDB, nejde na síť.
 */
class CuzkTileCache extends Cesium.UrlTemplateImageryProvider {
  private baked: boolean

  constructor(o: Cesium.UrlTemplateImageryProvider.ConstructorOptions & { baked?: boolean }) {
    super(o)
    this.baked = !!o.baked
  }

  requestImage(x: number, y: number, level: number, request?: Cesium.Request): Promise<Cesium.ImageryTypes> | undefined {
    if (this.baked) {
      const key = orthoBakedKey(level, x, y)
      if (bakedKeys.has(key)) return this.fromBaked(key, x, y, level, request)
    }
    return this.live(x, y, level, request)
  }

  private live(x: number, y: number, level: number, request?: Cesium.Request): Promise<Cesium.ImageryTypes> | undefined {
    const p = super.requestImage(x, y, level, request)
    if (!p) return undefined // fronta požadavků je plná — Cesium to zkusí v dalším snímku
    return Promise.resolve(p).catch((e: unknown) => {
      if ((e as { statusCode?: number })?.statusCode === 404) return blankTile() as Promise<Cesium.ImageryTypes>
      throw e
    })
  }

  /** Napečená dlaždice se dekóduje stejnou cestou jako živá (`fetchImage` s flipY), ať sedí orientace. */
  private fromBaked(key: string, x: number, y: number, level: number, request?: Cesium.Request): Promise<Cesium.ImageryTypes> | undefined {
    return bakedGet(key).then(b => {
      if (!b) return (this.live(x, y, level, request) ?? blankTile()) as Promise<Cesium.ImageryTypes>
      // cache je „MIXED": JPEG uvnitř, PNG s průhledností u hranic — typ podle prvních bajtů
      const type = b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : 'image/jpeg'
      const url = URL.createObjectURL(new Blob([b as BlobPart], { type }))
      const img = new Cesium.Resource({ url }).fetchImage({ preferImageBitmap: true, flipY: true })
      return Promise.resolve((img ?? blankTile()) as Promise<Cesium.ImageryTypes>).finally(() => URL.revokeObjectURL(url))
    })
  }
}

export function ortofotoProvider(): Cesium.ImageryProvider {
  if (LOCAL_TILES) {
    return new Cesium.UrlTemplateImageryProvider({
      url: `${LOCAL_TILES.replace(/\/$/, '')}/orto/{z}/{x}/{y}.jpg`,
      rectangle: LIBEREC_EXTENT,
      minimumLevel: 10,
      maximumLevel: 19,
      tileWidth: ORTO_TILE_PX,
      tileHeight: ORTO_TILE_PX,
    })
  }
  // Formát cache je „MIXED": dlaždice celé uvnitř ČR jsou JPEG, ty na hranici PNG s průhledností,
  // takže obrys republiky zůstává průhledný (bez bílého obdélníku ve výřezu glóbu).
  return new CuzkTileCache({
    url: `${ORTO_CACHE}/{z}/{y}/{x}`,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: ORTO_TILE_PX,
    tileHeight: ORTO_TILE_PX,
    minimumLevel: CACHE_MIN_LEVEL,
    maximumLevel: ORTO_MAX_LEVEL,
    rectangle: CR_EXTENT,
    credit: 'ČÚZK',
    baked: true,
  })
}

/**
 * Topografická mapa jako HOTOVÉ DLAŽDICE, ne WMS.
 *
 * ČÚZK publikuje ZTM dvakrát. Služba `ZTM/<tier>` je WMS, který obrázek renderuje na každý dotaz —
 * proto se mapa v appce plazila. Vedle toho je `ZTM_WM`: předpřipravená pyramida
 * (`singleFusedMapCache: true`), kde je dlaždice hotová a jen se pošle. Změřeno na Liberci:
 * ~0,1 s a 8–47 kB na dlaždici napříč úrovněmi. Tohle používá i web ČÚZK, proto jim to lítá.
 *
 * Klíčové je to „_WM" — Web Mercator. Necachovaná `ZTM` má mřížku v S-JTSK (wkid 102067) a tu
 * Cesium neumí, protože v Křováku nejsou dlaždice v zeměpisných souřadnicích obdélníky. Proto
 * se dřív muselo přes WMS, který reprojekci udělá na serveru.
 *
 * Odpadá tím i přepínání pěti vrstev podle měřítka: pyramida má kartografii zapečenou pro každou
 * úroveň sama, takže stačí JEDNA vrstva.
 */
/**
 * Hrubší ortofoto POD ostré — záplata na bílé díry.
 *
 * WMS ČÚZK s `transparent=true` vrací jako průhledné i pixely, které jsou v samotném snímku
 * čistě bílé (255,255,255) — zřejmě má mozaika bílou jako „žádná data". Na přepálené bílé
 * střeše jich jsou stovky a v mapě z nich byly černé tečky. Dřív to nebylo vidět, protože pod
 * mapou ležel světový podklad Cesia; ten je pryč (`baseLayer: false`), takže dírami prosvítá
 * černý glóbus.
 *
 * Změřeno na centru Prahy, 512 px na různě velký výřez:
 *
 *     10 cm/px …  89 děr      39 cm/px …  8 děr
 *     20 cm/px … 226 děr      78 cm/px …  0 děr      156 cm/px … 0 děr
 *
 * a 100 % těch děr je bez `transparent` čistě bílých. Nad ~78 cm/px server převzorkovává,
 * přesná 255 se rozprůměruje a klíčovat není co. Odtud řešení: tatáž služba zastropovaná
 * na úrovni 14 (~1,5 m/px) se položí pod ostrou vrstvu. Prosvítá jen dírkami velkými jeden
 * pixel, a protože je díra vždycky bílý pixel obklopený bílou, není po ní poznat ani stopa.
 *
 * Za hranicemi ČR je průhledná stejně jako ostrá vrstva, takže obrys republiky zůstává.
 *
 * Měřené díry pocházejí z WMS. Cache se peče z téže mozaiky a průhlednost nese taky (PNG na
 * okrajích), takže se záplata nechává pro jistotu — z cache je levná a hrubé úrovně jsou pár dlaždic.
 */
export const ORTO_PATCH_MAX_LEVEL = 14
/** Zapíná se až od téhle úrovně glóbu — při pohledu na celou republiku by jen zdvojovala dotazy. */
export const ORTO_PATCH_MIN_TERRAIN = 16

export function ortofotoPatchProvider(): Cesium.ImageryProvider | undefined {
  if (LOCAL_TILES) return undefined // lokální dlaždice jsou JPEG, bez alfy — díry nemají z čeho vzniknout
  return new CuzkTileCache({
    url: `${ORTO_CACHE}/{z}/{y}/{x}`,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: 256,
    tileHeight: 256,
    minimumLevel: CACHE_MIN_LEVEL,
    maximumLevel: ORTO_PATCH_MAX_LEVEL,
    rectangle: CR_EXTENT,
  })
}

export function ztmProvider() {
  return new CuzkTileCache({
    url: `${ZTM_CACHE}/{z}/{y}/{x}`,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    /**
     * Dlaždice jsou ve skutečnosti 256 px. Že tu stojí 128, je ZÁMĚR, ne překlep.
     *
     * Cesium si podle `tileWidth` počítá, jaká úroveň pyramidy odpovídá rozlišení obrazovky.
     * Pyramida má ale pevné úrovně po dvojnásobcích, takže při zoomu „mezi" úrovněmi se dlaždice
     * zvětšuje až dvakrát — a právě z toho byla mapa měkká. WMS tenhle problém neměl, protože
     * vykreslil přesně tu velikost, o kterou se řeklo.
     *
     * Poloviční údaj přiměje Cesium sáhnout o úroveň hloub, takže se 256px dlaždice na obrazovku
     * ZMENŠUJE místo zvětšování. Text i čáry jsou ostré a jako vedlejší efekt se rozmělní i
     * artefakty JPEGu (cache je ukládá jako JPEG, byť ve vysoké kvalitě).
     *
     * Platí se za to čtyřnásobkem dlaždic — při 8–47 kB a ~0,1 s na kus je to pořád nesrovnatelně
     * rychlejší než WMS, který se na každý dotaz renderoval.
     */
    tileWidth: 128,
    tileHeight: 128,
    // Rozsah cache je 6–19, ověřeno dotazem na službu. Mimo něj vrací 404, a bez `minimumLevel`
    // po nich Cesium sáhne hned při startu (staví strom dlaždic od nuly) → plná konzole chyb.
    minimumLevel: 6,
    maximumLevel: 19,
    rectangle: CR_EXTENT,
    credit: 'ČÚZK',
  })
}

export function katastrProvider() {
  return new Cesium.WebMapServiceImageryProvider({
    url: KATASTR_WMS,
    layers: KATASTR_LAYERS, // tytéž vrstvy jdou volitelně i do 2D exportu (katastrBboxUrl)
    parameters: { format: 'image/png', transparent: true },
  })
}
