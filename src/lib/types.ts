/**
 * Datové typy backendu — řádky tabulek a tvar JSON blobů, které do nich ukládáme.
 *
 * Jsou to jen popisy tvaru dat, žádná logika. Typy scény schválně odkazují na typy
 * jednotlivých vrstev (popisky, pulzy, měření), ať se JSON nikdy nerozejde s tím, co
 * vrstvy skutečně umí přečíst.
 */
import type { Callout } from '../callouts'
import type { PulseSet } from '../pulse'
import type { Ruler } from '../ruler'
import type { Base, CamView, Placement } from '../types'

export type Profile = {
  id: string
  email: string | null
  display_name: string | null
  created_at: string
}

export type SceneRow = {
  id: string
  owner: string
  name: string
  note: string | null
  thumb_path: string | null
  state: SceneState
  created_at: string
  updated_at: string
  opened_at: string | null
}

export type AssetKind = 'model' | 'drawing' | 'raster'

export type AssetRow = {
  id: string
  scene_id: string
  owner: string
  kind: AssetKind
  name: string
  file_name: string
  file_path: string
  sidecar_path: string | null
  sidecar_name: string | null
  size_bytes: number | null
  config: AssetConfig
  sort_order: number
  created_at: string
  updated_at: string
}

/**
 * `config` řádku souboru. Sjednocený tvar pro všechny tři druhy — každý si bere svoje
 * pole a zbytek nechává být, takže přidání dalšího druhu nevyžaduje migraci schématu.
 */
export type AssetConfig = {
  // model
  placement?: Placement
  yawDeg?: number
  visible?: boolean
  excavate?: boolean
  outline?: boolean
  /** obrys půdorysu (lon/lat prstence) — georeference z S-JTSK se nepočítá znovu při každém otevření */
  footprint?: [number, number][][]
  /** lokální souřadnice středu modelu (x, y, z) dopočítané po načtení — usazení pak sedí i po reloadu */
  center?: [number, number, number]

  // výkres
  heightOffset?: number
  alpha?: number
  /** vypnuté hladiny výkresu (jméno hladiny) — zapnuté je výchozí stav */
  hiddenLayers?: string[]

  // rastr
  crsId?: string
  rasterAlpha?: number
  rasterVisible?: boolean
}

/** Uložená parcela z katastru — prstence v lon/lat, ať se nemusí znovu ptát ČÚZK. */
export type SavedParcel = {
  pid: string
  label: string
  knArea: number
  ring: [number, number][]
  holes: [number, number][][]
}

/** Uložená pozice kamery scény (ECEF + orientace v radiánech). */
export type SavedCamera = { dest: [number, number, number]; h: number; p: number; r: number }

/**
 * Stav scény = všechno, co ve scéně není nahraný soubor. Každé pole je NEPOVINNÉ:
 * scéna uložená starší verzí ho nemusí mít a chybějící hodnota vždycky znamená „výchozí“.
 */
export type SceneState = {
  camViews?: CamView[]
  callouts?: Callout[]
  pulses?: PulseSet[]
  rulers?: Ruler[]
  parcels?: SavedParcel[]
  base?: Base
  bgMode?: string    // pozadí ploché mapy
  bgMode3d?: string  // pozadí 3D reality (pamatuje se zvlášť — v mapě obloha nedává smysl)
  bgCustom?: string
  camera?: SavedCamera
  /** Odečtené body a posun terénu (viz „Souřadnice" v panelu) — přežijí zavření scény. */
  coords?: { pts: CoordPoint[]; shift?: [number, number, number] }
  /** Pojmenované řezy modelem — dají se přepínat a přežijí zavření scény. */
  sections?: SavedSection[]
  /**
   * Vybrané dlaždice pro export.
   *
   * Ukládají se proto, že výkres se mění, ale území ne: po opravě výkresu je potřeba vyjet
   * PŘESNĚ tytéž dlaždice, a skládat je znovu ručně by znamenalo, že se výřez pokaždé o kus
   * liší. `size` je hrana čtverce v metrech (viz `TILE_SIZES`), `cells` jsou indexy mřížky
   * S-JTSK — tedy totéž, čím je dlaždice jednoznačně daná.
   */
  tiles?: { size: number; cells: [number, number][] }
  /**
   * Nastavení exportů — ze stejného důvodu jako dlaždice: po opravě výkresu se vyjíždí znovu
   * a má to vyjet stejně. Posun terénu je v `coords.shift` (sdílí ho i panel Souřadnice).
   */
  exportOpts?: ExportOpts
}

/**
 * Uložené volby exportu. Typy jsou schválně volné — přicházejí z JSONu scény a `useExports`
 * je při načtení porovná s povolenými hodnotami; co neprojde, nahradí výchozí.
 */
export type ExportOpts = {
  meshStep?: number
  texSize?: number
  /** 3D export s ortofotem jako texturou */
  ortho?: boolean
  katastr?: boolean
  buildings?: boolean
  mapLayer?: string
  mapRes?: number
  mapFormat?: string
  /** dokreslit do 2D exportu viditelné výkresy */
  drawings?: boolean
  /** dokreslit do 2D exportu katastrální mapu (`katastr` výš je DXF hranic u 3D exportu) */
  mapKatastr?: boolean
}

/**
 * Uložený řez.
 *
 * Čára se ukládá v LOKÁLNÍ soustavě modelu, ne ve světové. Kdyby se model ve scéně posunul
 * nebo pootočil, světové souřadnice by ukazovaly vedle — takhle jde řez s ním. Zbytek jsou
 * čísla z panelu, aby se řez obnovil přesně tak, jak byl zadaný.
 */
export type SavedSection = {
  id: string
  name: string
  /** který model se řeže; podle jména, protože id souboru se při novém nahrání změní */
  model: string
  /** konce čáry v lokální soustavě modelu (X=východ, Y=sever, Z=nahoru) */
  a: [number, number, number]
  b: [number, number, number]
  flip: boolean
  offset: number
  /** šířka výkresu; 0 = přes celý model */
  len: number
  height: number
  thick: number
  depth: number
  both: boolean
  /** k tomu i půdorys a v jaké výšce nad středem čáry */
  plan?: boolean
  planZ?: number
  viewLines: boolean
  occlusion: boolean
  edgeAngle: number
  clipMap: boolean
}

/**
 * Bod odečtený z mapy. Ukládá se v S-JTSK a Bpv, tedy PŘESNĚ v té soustavě, ve které vychází
 * exportovaný terén — jinak by se čísla z panelu a z modelu v Maxu nedala porovnat.
 */
export type CoordPoint = {
  id: string
  /** Křovák EPSG:5514 */
  x: number
  y: number
  /** výška Bpv (ne nad elipsoidem — ta je o kvazigeoid `geoidN` vyšší) */
  z: number
  lon: number
  lat: number
}
