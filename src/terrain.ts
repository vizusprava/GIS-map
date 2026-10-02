/**
 * Terén celé mapy z ČÚZK DMR 5G jako Cesium terrain provider.
 *
 * Výšky se tahají z ImageServeru po dlaždicích za běhu, takže ortofoto, ZTM i vložené plochy
 * a modely leží na jednom a tomtéž přesném terénu.
 */
import * as Cesium from 'cesium'
import { fromArrayBuffer } from 'geotiff'
import { cacheGet, cachePut } from './cache'
import { geoidN } from './geoid'
import { nearestToFocus, resampleTile, sliceBlock } from './terrainTiles'

/**
 * Kam se zrovna dívá kamera, zeměpisně ve stupních. Hlásí to MapView (`setTerrainFocus`).
 *
 * Než se ozve poprvé, je to střed Čech — pro první snímek stejně dobrý odhad jako cokoli jiného.
 */
let focusLon = 15.5, focusLat = 49.8

/** Řekne terénu, na co se člověk dívá. Fronta dlaždic se podle toho přerovná. */
export function setTerrainFocus(lon: number, lat: number) { focusLon = lon; focusLat = lat }

/**
 * Kolik dlaždic terénu se smí stahovat naráz.
 *
 * Semafor je tu původně proto, že velká plocha jinak vystřelí tisíce fetchů naráz
 * → ERR_INSUFFICIENT_RESOURCES; cache dlaždic k tomu šetří opakované dotazy,
 * protože sampleTerrain často žádá tytéž dlaždice znovu.
 *
 * Číslo je schválně MENŠÍ, než kolik prohlížeč na jednoho hostitele dovolí (u HTTP/1.1 je to
 * šest). Ortofoto, topografická mapa i terén jedou z téhož `ags.cuzk.gov.cz`, takže si těch
 * šest spojení dělí. Při šesti si terén vezme všechna a na mapu nezbude ani jedno — a protože
 * se dlaždice mapy kreslí až na hotový terén, čeká se dvakrát. Se třemi zbývají tři na mapu:
 * terén doběhne o chlup později, ale to, co je vidět, se objeví hned.
 */
const DMR_MAX_CONCURRENT = 3

/**
 * Jak dlouho se čeká na jednu dlaždici terénu.
 *
 * Bez stropu by se zaseknutý požadavek na ČÚZK držel ve frontě, dokud ho neshodí prohlížeč
 * (minuty) — a stačí tři takové, aby se zastavil celý terén, protože semafor pouští jen tři.
 */
const DMR_TIMEOUT_MS = 15_000

let dmrActive = 0
const dmrQueue: { lon: number; lat: number; go: () => void }[] = []

/**
 * Pustí dlaždici ke stažení, nebo ji postaví do fronty. Bere se z ní vždycky ta nejblíž
 * ke středu pohledu, takže terén — a s ním i mapa, která se na něj kreslí — naskakuje
 * od prostředka obrazovky ven.
 *
 * Pořadí se rozhoduje až při uvolňování, ne při zařazení. Když se člověk mezitím jinam
 * podívá, fronta se tím sama přerovná a dlaždice ze starého pohledu ustoupí novým.
 * Dřív se odbavovalo v pořadí příchodu, tedy i to, na co se už dávno nikdo nedívá.
 */
function dmrAcquire(lon: number, lat: number): Promise<void> {
  if (dmrActive < DMR_MAX_CONCURRENT) { dmrActive++; return Promise.resolve() }
  return new Promise<void>(res => { dmrQueue.push({ lon, lat, go: () => { dmrActive++; res() } }) })
}
function dmrRelease() {
  dmrActive--
  const i = nearestToFocus(dmrQueue, focusLon, focusLat)
  if (i >= 0) dmrQueue.splice(i, 1)[0].go()
}
const dmrTileCache = new Map<string, Float32Array>()
/** Strop dlaždic v paměti (jedna = 16 kB). Nastavuje ho profil výkonu, viz `setDmrCacheMax`. */
let dmrCacheMax = 4000

/** Profil výkonu: kolik dlaždic terénu držet v paměti. Přebytek se zahodí hned (nejstarší první). */
export function setDmrCacheMax(n: number) {
  dmrCacheMax = Math.max(100, n)
  while (dmrTileCache.size > dmrCacheMax) dmrTileCache.delete(dmrTileCache.keys().next().value as string)
}

/**
 * Nad tuhle úroveň se na ČÚZK už nechodí.
 *
 * Dlaždice úrovně 16 je zhruba 300 m široká a vzorkuje se 64×64, tedy po ~4,8 m — přesně tak
 * hustý je zdroj (DMR 5G stojí na mřížce 5 m). Když si řekneme o dlaždici hloub, víc informace
 * nedostaneme: server tutéž mřížku jen proloží. Dlaždic je přitom na každou další úroveň
 * čtyřikrát tolik a při přiblížení k domu si o ně Cesium říká až po úroveň 19 — to je 64×
 * víc dotazů za nic. A každý z nich je render na serveru (`exportImage`) z téhož hostitele,
 * odkud se tahá ortofoto i topo, takže mapě ubírá spojení právě tehdy, kdy je potřebuje.
 *
 * Hlubší dlaždice se proto dopočítají z té šestnácté u nás (`resampleTile`) a předek už
 * skoro vždycky leží v cache — Cesium ho cestou dolů načetlo. Dělení glóbu se nemění,
 * takže ortofoto i topo zůstávají stejně ostré; ubyde jen síťový provoz terénu.
 */
const DMR_MAX_LEVEL = 16

/**
 * Klíč dlaždice v trvalé cache. V cache jsou výšky už nad elipsoidem, takže se klíč mění vždycky,
 * když se mění převod: `dmrterr2/` = bloky vzorkované do uzlů mřížky, `dmrterr3/` = kvazigeoid
 * podle místa (geoid.ts) místo konstanty 44 m. Staré dlaždice by s novými na švech nelícovaly;
 * nikdo je nečte a vypadnou samy, až je LRU vytlačí.
 */
const diskKey = (level: number, x: number, y: number) => `dmrterr3/${level}/${x}/${y}`

// Terén celé mapy z ČÚZK DMR 5G — výšky se tahají z exportImage za běhu.
// Tím ortofoto/ZTM i vložené plochy/modely leží na stejném přesném terénu.
export function makeDmrTerrain(): Cesium.CustomHeightmapTerrainProvider {
  const tilingScheme = new Cesium.GeographicTilingScheme()
  const W = 64, H = 64
  /** vzorků na stranu bloku přes rodiče: čtyři dětské dlaždice se sdílenými okraji */
  const BLOCK = 2 * (W - 1) + 1

  const remember = (key: string, tile: Float32Array) => {
    if (dmrTileCache.size >= dmrCacheMax) dmrTileCache.delete(dmrTileCache.keys().next().value as string)
    dmrTileCache.set(key, tile)
  }

  /**
   * Výšky pro obdélník jako mřížka `n`×`n` UZLŮ — uzly leží na okrajích, tak je chce Cesium.
   * Obálka se proto roztáhne o půl buňky, ať středy pixelů rastru padnou přesně na uzly
   * (stejný trik jako `fetchTileHeights` v tiles.ts). Jediné místo v souboru, které sahá na síť.
   *
   * Chyba (výpadek, timeout) se SCHVÁLNĚ propouští ven. Cesium pak dlaždici označí za nedostupnou
   * a dopočítá ji z rodiče, takže terén je na chvíli jen hrubší. Dřív se vracely nulové výšky,
   * a protože Cesium kreslí nad elipsoidem, byla z toho jáma o ~400 m níž.
   */
  const fetchGrid = async (rect: Cesium.Rectangle, n: number): Promise<Float32Array> => {
    const west = Cesium.Math.toDegrees(rect.west), south = Cesium.Math.toDegrees(rect.south)
    const east = Cesium.Math.toDegrees(rect.east), north = Cesium.Math.toDegrees(rect.north)
    const hx = (east - west) / (n - 1) / 2, hy = (north - south) / (n - 1) / 2
    await dmrAcquire((west + east) / 2, (south + north) / 2)
    try {
      const url = `https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage?bbox=${west - hx},${south - hy},${east + hx},${north + hy}&bboxSR=4326&imageSR=4326&size=${n},${n}&format=tiff&pixelType=F32&f=image`
      const res = await fetch(url, { signal: AbortSignal.timeout(DMR_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`DMR 5G: HTTP ${res.status}`)
      const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage()
      if (img.getWidth() !== n || img.getHeight() !== n) throw new Error(`DMR 5G vrátil ${img.getWidth()}×${img.getHeight()}, čekal ${n}×${n}`)
      const r = (await img.readRasters())[0] as unknown as ArrayLike<number>
      const out = new Float32Array(n * n)
      // Bpv → nad elipsoidem podle místa každého uzlu (řádky jdou od severu)
      const stepX = (east - west) / (n - 1), stepY = (north - south) / (n - 1)
      for (let row = 0; row < n; row++) {
        const lat = north - row * stepY
        for (let col = 0; col < n; col++) {
          const i = row * n + col
          const e = r[i] as number
          out[i] = Number.isFinite(e) && e > -500 && e < 3000 ? e + geoidN(west + col * stepX, lat) : 0
        }
      }
      return out
    } finally {
      dmrRelease()
    }
  }

  /**
   * Rozpracované bloky (klíč = rodič). Cesium si při zjemňování řekne o všechny čtyři děti
   * najednou — tady se postarají, aby z toho byl jeden dotaz, ne čtyři stejné.
   */
  const blocks = new Map<string, Promise<Float32Array[]>>()

  /**
   * Čtyři dětské dlaždice rodiče jedním dotazem.
   *
   * ČÚZK posílá rastr po blocích 128×128, takže dotaz na 127×127 vzorků stojí totéž co na 64×64
   * (změřeno: stejných 65 kB, ~0,2 s). Terénu na nový pohled je tak čtyřikrát méně dotazů —
   * a terén byl při načítání nového místa to nejpomalejší (šikmý pohled: 92 dotazů).
   */
  const fetchChildren = (px: number, py: number, pl: number): Promise<Float32Array[]> => {
    const pk = `${pl}/${px}/${py}`
    let p = blocks.get(pk)
    if (!p) {
      p = fetchGrid(tilingScheme.tileXYToRectangle(px, py, pl), BLOCK).then(block => {
        const kids: Float32Array[] = []
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
          const tile = sliceBlock(block, BLOCK, W, H, sx, sy)
          const cx = px * 2 + sx, cy = py * 2 + sy, cl = pl + 1
          remember(`${cl}/${cx}/${cy}`, tile)
          void cachePut(diskKey(cl, cx, cy), new Uint8Array(tile.buffer.slice(0)))
          kids.push(tile)
        }
        return kids
      }).finally(() => { blocks.delete(pk) })
      blocks.set(pk, p)
    }
    return p
  }

  /** Dlaždice terénu: paměť → disk → síť (u úrovně 1+ po blocích čtyř sourozenců). */
  const fetchTile = async (x: number, y: number, level: number): Promise<Float32Array> => {
    const rect = tilingScheme.tileXYToRectangle(x, y, level)
    const west = Cesium.Math.toDegrees(rect.west), south = Cesium.Math.toDegrees(rect.south)
    const east = Cesium.Math.toDegrees(rect.east), north = Cesium.Math.toDegrees(rect.north)
    if (east < 12.0 || west > 18.9 || north < 48.5 || south > 51.1) return new Float32Array(W * H) // mimo ČR
    const key = `${level}/${x}/${y}`
    const cached = dmrTileCache.get(key)
    if (cached) return cached
    // trvalá cache (disk) — přežije refresh; klíč odlišený od exportních dlaždic (jiné dláždění + GEOID)
    const disk = await cacheGet(diskKey(level, x, y))
    if (disk && disk.byteLength === W * H * 4) {
      const out = new Float32Array(disk.slice().buffer)
      remember(key, out)
      return out
    }
    const hit = dmrTileCache.get(key) // mezitím mohla dorazit se sourozencem
    if (hit) return hit
    if (level === 0) { // nejhrubší úroveň rodiče nemá — tu jedinou stáhnout samotnou
      const out = await fetchGrid(rect, W)
      remember(key, out)
      return out
    }
    const kids = await fetchChildren(x >> 1, y >> 1, level - 1)
    return kids[(y & 1) * 2 + (x & 1)]
  }

  return new Cesium.CustomHeightmapTerrainProvider({
    width: W,
    height: H,
    tilingScheme,
    callback: (x, y, level) => {
      if (level <= DMR_MAX_LEVEL) return fetchTile(x, y, level)
      const d = level - DMR_MAX_LEVEL
      const ax = x >>> d, ay = y >>> d
      return fetchTile(ax, ay, DMR_MAX_LEVEL)
        .then(base => resampleTile(base, W, H, x - (ax << d), y - (ay << d), 1 << d))
    },
  })
}
