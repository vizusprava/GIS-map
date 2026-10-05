/**
 * Smlouva mezi mapou a backendem.
 *
 * `MapView` je pořád jen mapa — o Supabase nic neví. Dostane tenhle objekt a přes něj hlásí
 * „tohle si zapamatuj" (stav scény, nahraný soubor, usazení modelu). Kdo to ukládá a kam,
 * řeší `ScenePage`. Persistence se injektuje, nesahá se na ni z komponenty.
 */
import type { AssetConfig, AssetKind, AssetRow, FileStorage, SceneRole, SceneState } from './types'

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
  /**
   * Veřejný prohlížeč (odkaz bez registrace, `access` je pak `viewer`): navíc bez exportů,
   * importu, výběru parcel/dlaždic/území, odečtu souřadnic a úprav pohledů či popisků.
   * Zůstává prohlížení, vrstvy, pohledy, prezentace a měření (bez ukládání).
   */
  guest?: boolean
  /** Otevři okno sdílení (jen vlastník; jinak chybí). */
  share?: () => void
  /**
   * Vidí scénu i někdo jiný (kolegové, odkaz pro prohlížení)? Soubor jen v tomhle počítači
   * by neviděli — mapa na to upozorní.
   */
  shared?: boolean
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
    /** nenahrávat do cloudu, nechat jen v tomhle počítači (přepínač ve scéně) */
    local?: boolean
  }) => Promise<AssetRow>
  /** Přesuň soubor do cloudu, nebo jen do tohoto počítače. Vrací řádek s novým umístěním. */
  moveAsset: (assetId: string, to: FileStorage) => Promise<AssetRow>
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
