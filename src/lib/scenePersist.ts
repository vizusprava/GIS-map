/**
 * Smlouva mezi mapou a backendem.
 *
 * `MapView` je pořád jen mapa — o Supabase nic neví. Dostane tenhle objekt a přes něj hlásí
 * „tohle si zapamatuj" (stav scény, nahraný soubor, usazení modelu). Kdo to ukládá a kam,
 * řeší `ScenePage`. Stejný trik jako `ViewerAdapter` u 3D vieweru: persistence se injektuje,
 * nesahá se na ni z komponenty.
 */
import type { AssetConfig, AssetKind, AssetRow, SceneState } from './types'

export type ScenePersist = {
  sceneId: string
  sceneName: string
  ownerId: string
  /** stav scény, jak byl při otevření — z něj se plní počáteční hodnoty */
  initial: SceneState
  /** soubory scény při otevření; mapa je po startu naskládá do 3D */
  assets: AssetRow[]
  /** Zapamatuj si změnu stavu scény (sloučí se se zbytkem, uloží odloženě). */
  patchState: (patch: Partial<SceneState>) => void
  /** Nahraj nový soubor do scény. Vrací řádek — z něj si mapa vezme `id` pro další hlášení. */
  uploadAsset: (opts: {
    kind: AssetKind
    name: string
    file: File
    sidecar?: File | null
    config?: AssetConfig
  }) => Promise<AssetRow>
  /** Zapamatuj si nastavení souboru (usazení modelu, výška výkresu, alfa rastru). */
  patchAssetConfig: (assetId: string, config: AssetConfig) => void
  /** Smaž soubor ze scény i z úložiště. */
  deleteAsset: (assetId: string) => Promise<void>
  /** Ulož náhled scény do přehledu (snímek plátna). */
  saveThumb: (png: Blob) => Promise<void>
  /** Otevři model v editoru modelu (viewer-core) — anotace, vegetace, materiály. */
  openModel: (assetId: string) => void
  /** Zpět na přehled scén. */
  exit: () => void
}
