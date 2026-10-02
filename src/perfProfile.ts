/**
 * Profil výkonu — kolik si scéna smí vzít z grafiky a paměti.
 *
 * Dvě úrovně, ne posuvník: „úsporný" je pro notebooky s integrovanou grafikou a málo pamětí,
 * „kvalitní" je to, jak appka vypadala dosud. Volba „auto" (výchozí) vybere podle počítače.
 *
 * Volba patří k TOMUHLE POČÍTAČI, ne ke scéně — proto localStorage, stejně jako ostrost obrazu
 * (viz config.ts). Tutéž scénu může jeden otevírat na pracovní stanici a druhý na notebooku.
 *
 * Kde se co projeví, je popsané u `PerfSettings`; aplikuje to MapView.
 */
import { GLOBE_SSE_PHOTO, GLOBE_SSE_TOPO, GOOGLE_SSE_MOVING, GOOGLE_SSE_STILL } from './config'
import { parseGpu } from './gpu'

export type PerfChoice = 'auto' | 'usporny' | 'kvalitni'
export type PerfLevel = 'usporny' | 'kvalitni'

const KEY = 'geo.vykon'

export function readPerfChoice(): PerfChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'usporny' || v === 'kvalitni' || v === 'auto') return v
  } catch { /* privátní režim */ }
  return 'auto'
}

export function savePerfChoice(c: PerfChoice): void {
  try { localStorage.setItem(KEY, c) } catch { /* privátní režim */ }
}

/**
 * Paměť počítače v GB, jak ji hlásí prohlížeč. Chrome a Edge ji zaokrouhlují a končí na 8,
 * takže „8" znamená „8 GB a víc". Firefox ani Safari ji nehlásí — tam se bere 8.
 */
export const DEVICE_MEMORY_GB = (navigator as { deviceMemory?: number }).deviceMemory || 8
/** Málo paměti: tady se stropy cache snižují i v kvalitním profilu, ať prohlížeč kartu neshodí. */
export const LOW_MEMORY = DEVICE_MEMORY_GB <= 4

export type PerfDetection = { level: PerfLevel; gpu: string; reasons: string[] }
let detected: PerfDetection | null = null

/** Grafika podle WebGL. Testovací kontext se hned zase uvolní, ať nebere místo tomu skutečnému. */
function readGpu(): { name: string; weak: boolean; software: boolean } {
  try {
    const c = document.createElement('canvas')
    // `failIfMajorPerformanceCaveat`: prohlížeč vrátí null, když by kreslil softwarově (bez GPU)
    const opts = { failIfMajorPerformanceCaveat: true }
    const gl = (c.getContext('webgl2', opts) ?? c.getContext('webgl', opts)) as WebGLRenderingContext | null
    if (!gl) return { name: 'bez hardwarové akcelerace', weak: true, software: true }
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return { ...parseGpu(raw), software: false }
  } catch {
    return { name: 'neznámá', weak: false, software: false }
  }
}

/**
 * Odhad, jak silný je tenhle počítač. Počítá se jednou za sezení.
 *
 * Rozhoduje hlavně grafika: integrované čipy dávají Cesiu v plném rozlišení displeje s MSAA
 * jednotky snímků za vteřinu. Paměť a počet jader jsou pojistka pro stroje, kde se jméno
 * grafiky nedá přečíst.
 */
export function detectPerf(): PerfDetection {
  if (detected) return detected
  const gpu = readGpu()
  const cores = navigator.hardwareConcurrency || 8
  const reasons: string[] = []
  if (gpu.software) reasons.push('grafika bez hardwarové akcelerace')
  else if (gpu.weak) reasons.push(`slabší grafika (${gpu.name})`)
  if (LOW_MEMORY) reasons.push(`${DEVICE_MEMORY_GB} GB paměti`)
  if (cores <= 2) reasons.push(`${cores} jádra procesoru`)
  detected = { level: reasons.length ? 'usporny' : 'kvalitni', gpu: gpu.name, reasons }
  return detected
}

export function resolvePerf(choice: PerfChoice): PerfLevel {
  return choice === 'auto' ? detectPerf().level : choice
}

export type PerfSettings = {
  /**
   * Strop fyzických pixelů na jeden CSS pixel. `Infinity` = plné rozlišení displeje.
   * Na displeji se škálováním 150 % je rozdíl mezi 1 a 1,5 víc než dvojnásobek pixelů —
   * to je u integrované grafiky ta největší položka.
   */
  pixelRatioCap: number
  /** MSAA vzorků na pixel; 1 = vypnuto. Úsporný profil místo toho pouští levnější FXAA. */
  msaaSamples: number
  fxaa: boolean
  /** povolená chyba dlaždic glóbu v px (viz GLOBE_SSE_* v config.ts) — vyšší = méně dlaždic */
  globeSsePhoto: number
  globeSseTopo: number
  /**
   * Kolik dlaždic glóbu drží Cesium v paměti i mimo obrazovku. Každá si nechává i své textury
   * ortofota — od jemnějšího ortofota (`ORTO_TILE_PX` v imagery.ts) zhruba čtyři —, takže tohle
   * číslo je hlavně strop paměti grafiky. Změřeno po projetí mapy šikmo nad Č. Budějovicemi
   * (textury ortofota v grafice):
   *
   *     kvalitní 1000 … 527 MB      300 … 143 MB   (s hrubším ortofotem a 1000 bylo 149 MB)
   *     úsporný   300 … 116 MB      100 …  44 MB   (s hrubším ortofotem a 300 bylo 37 MB)
   *
   * Co z cache vypadne, se při návratu nestahuje znovu — ČÚZK posílá dlaždice s `max-age`
   * na den, takže se vezmou z cache prohlížeče a jen znovu rozbalí.
   */
  tileCacheSize: number
  /** předstahovat dlaždice kousek za okrajem obrazovky (plynulejší posun, víc stahování) */
  preloadSiblings: boolean
  /** Google 3D: povolená chyba v klidu a za pohybu */
  googleSseStill: number
  googleSseMoving: number
  /** Google 3D: cache dlaždic a její dočasný přetok */
  googleCacheBytes: number
  googleCacheOverflowBytes: number
  /** kolik dlaždic terénu DMR drží terrain.ts v paměti (jedna = 16 kB) */
  dmrCacheTiles: number
}

const MB = 1024 * 1024

export function perfSettings(level: PerfLevel): PerfSettings {
  if (level === 'usporny') {
    return {
      pixelRatioCap: 1,
      msaaSamples: 1,
      fxaa: true,
      // o stupeň hrubší než kvalitní: zhruba poloviční počet dlaždic glóbu
      globeSsePhoto: 3,
      globeSseTopo: 2,
      tileCacheSize: 100,
      preloadSiblings: false,
      googleSseStill: GOOGLE_SSE_MOVING,
      googleSseMoving: GOOGLE_SSE_MOVING * 2,
      googleCacheBytes: 256 * MB,
      googleCacheOverflowBytes: 128 * MB,
      dmrCacheTiles: 1500,
    }
  }
  return {
    pixelRatioCap: Infinity,
    msaaSamples: 4,
    fxaa: false,
    globeSsePhoto: GLOBE_SSE_PHOTO,
    globeSseTopo: GLOBE_SSE_TOPO,
    tileCacheSize: 300,
    preloadSiblings: true,
    googleSseStill: GOOGLE_SSE_STILL,
    googleSseMoving: GOOGLE_SSE_MOVING,
    // 1 GB + přetok by na stroji se 4 GB vzal prohlížeči skoro všechno a karta spadne
    googleCacheBytes: (LOW_MEMORY ? 256 : 1024) * MB,
    googleCacheOverflowBytes: (LOW_MEMORY ? 128 : 768) * MB,
    dmrCacheTiles: 4000,
  }
}
