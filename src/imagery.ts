/**
 * Rastrové podklady z ČÚZK: ortofoto, základní topografická mapa (ZTM) a katastrální překryv.
 *
 * Topografická mapa jede z DLAŽDICOVÉ CACHE ČÚZK (rychlé, hotové dlaždice), ortofoto a katastr
 * pořád přes WMS. U ortofota je to zatím schválně: lokální pyramida („napečené" dlaždice
 * v IndexedDB) je klíčovaná podle GEOGRAFICKÉ mřížky WMS, takže přechod na mercatorovou cache
 * `ORTOFOTO_WM` by ji celou zneplatnil. Zrychlilo by to i ortofoto, ale je to samostatná úloha.
 */
import * as Cesium from 'cesium'
import { bakedGet } from './cache'
import { CR_EXTENT, LIBEREC_EXTENT } from './config'

// ── ČÚZK WMS služby (ověřeno přes GetCapabilities — všechny podporují EPSG:3857) ──

// větší dlaždice = méně requestů = méně opakujících se ČÚZK log v mapě
export const WMS_TILE = 512

// Volitelný externí lokální dlaždicový server (viz scripts/tile-server.mjs) — má přednost.
export const LOCAL_TILES = import.meta.env.VITE_LOCAL_TILES as string | undefined

// Index napečených ortofoto dlaždic („lokální mapa") v paměti — synchronní kontrola v requestImage.
// Klíč = 'owms/{level}/{x}/{y}' (GEOGRAPHIC dlaždice WMS). Plní se z IndexedDB (store BAKED) při startu.
export const bakedKeys = new Set<string>()

// čerstvá průhledná 1×1 dlaždice (Cesium ImageBitmap po použití zavírá → nesdílet jednu instanci)
function blankTile(): Promise<ImageBitmap> {
  const c = document.createElement('canvas'); c.width = 1; c.height = 1
  return createImageBitmap(c)
}

/**
 * Ortofoto WMS s lokální dlaždicovou pyramidou. Zobrazení jde DÁL přes WMS (`super.requestImage`) —
 * jen dlaždice NAPEČENÉ do localu (`bakedKeys`) se vezmou z IndexedDB (nativní rozlišení, offline,
 * okamžité). Prázdný `bakedKeys` = 100 % čisté WMS → mapa se nemůže rozbít. Napečené dlaždice se
 * dekódují STEJNOU cestou jako živé WMS (`Resource.fetchImage` s flipY) → orientace/zarovnání sedí.
 */
export class CachedWmsOrtho extends Cesium.WebMapServiceImageryProvider {
  requestImage(x: number, y: number, level: number, request?: Cesium.Request): Promise<Cesium.ImageryTypes> | undefined {
    const key = `owms/${level}/${x}/${y}`
    if (!bakedKeys.has(key)) return super.requestImage(x, y, level, request) // nenapečené = živé WMS jako dosud
    return bakedGet(key).then(b => {
      if (!b) return (super.requestImage(x, y, level, request) ?? blankTile()) as Promise<Cesium.ImageryTypes>
      const url = URL.createObjectURL(new Blob([b as BlobPart], { type: 'image/jpeg' }))
      const img = new Cesium.Resource({ url }).fetchImage({ preferImageBitmap: true, flipY: true })
      return Promise.resolve((img ?? blankTile()) as Promise<Cesium.ImageryTypes>).finally(() => URL.revokeObjectURL(url))
    })
  }
}

export function ortofotoProvider() {
  if (LOCAL_TILES) {
    return new Cesium.UrlTemplateImageryProvider({
      url: `${LOCAL_TILES.replace(/\/$/, '')}/orto/{z}/{x}/{y}.jpg`,
      rectangle: LIBEREC_EXTENT,
      minimumLevel: 10,
      maximumLevel: 19,
      tileWidth: 256,
      tileHeight: 256,
    })
  }
  // transparent=true: ČÚZK vrací mimo hranice ČR PRŮHLEDNÉ pixely místo bílé výplně (ověřeno: PNG32, alfa 0).
  // Bez toho svítí kolem republiky bílý obdélník ve výřezu `cartographicLimitRectangle`.
  return new CachedWmsOrtho({
    url: 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer',
    layers: '0',
    tileWidth: WMS_TILE,
    tileHeight: WMS_TILE,
    parameters: { format: 'image/png', transparent: true },
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
export function ztmProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ZTM_WM/MapServer/tile/{z}/{y}/{x}',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: 256,
    tileHeight: 256,
    // 19 je poslední úroveň, kterou služba má — 20 už vrací 404 (ověřeno)
    maximumLevel: 19,
    rectangle: CR_EXTENT,
    credit: 'ČÚZK',
  })
}

export function katastrProvider() {
  return new Cesium.WebMapServiceImageryProvider({
    url: 'https://services.cuzk.cz/wms/wms.asp',
    layers: 'hranice_parcel,parcelni_cisla,obrazy_parcel,DEF_BUDOVY',
    parameters: { format: 'image/png', transparent: true },
  })
}
