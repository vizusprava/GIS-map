/**
 * Smlouva mezi mapou a backendem.
 *
 * `MapView` je pořád jen mapa — o Supabase nic neví. Dostane tenhle objekt a přes něj hlásí
 * „tohle si zapamatuj" (stav scény, nahraný soubor, usazení modelu). Kdo to ukládá a kam,
 * řeší `ScenePage`. Persistence se injektuje, nesahá se na ni z komponenty.
 */
import type { AssetConfig, AssetKind, AssetRow, SceneRole, SceneState } from './types'

export type ScenePersist = {
  sceneId: string
  sceneName: string
  /** vlastník scény — do jeho složky v úložišti jdou soubory, i ty nahrané kolegou */
  ownerId: string
  /**
   * Moje role ve scéně. `viewer` nic neukládá: všechno se dá vyzkoušet, ale po zavření scéna
   * zůstane, jak byla (hlášení níž se tiše zahodí, nahrání souboru skončí hláškou).
   */
  access: SceneRole
  /** jméno vlastníka, když scéna není moje (hlavička panelu) */
  ownerName?: string | null
  /** Otevři okno sdílení (jen vlastník; jinak chybí). */
  share?: () => void
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
  /** Přejmenuj soubor scény (jméno, pod kterým se ukazuje v panelu). */
  renameAsset: (assetId: string, name: string) => Promise<void>
  /** Smaž soubor ze scény i z úložiště. */
  deleteAsset: (assetId: string) => Promise<void>
  /** Ulož náhled scény do přehledu (zmenšený JPEG záběru, viz `captureThumb`). */
  saveThumb: (img: Blob) => Promise<void>
  /** Zpět na přehled scén. */
  exit: () => void
}
