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
  bgMode?: string
  bgCustom?: string
  camera?: SavedCamera
  splat?: { on: boolean; placement?: Placement }
  /** Odečtené body a posun terénu (viz „Souřadnice" v panelu) — přežijí zavření scény. */
  coords?: { pts: CoordPoint[]; shift?: [number, number, number] }
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
  /** výška Bpv (ne nad elipsoidem — ta je o GEOID_CZ vyšší) */
  z: number
  lon: number
  lat: number
}
