/**
 * Kam scéna ukládá soubory: cloud, nebo jen tento počítač (přepínač v sekci Import).
 *
 * Drží i to, kde který soubor scény zrovna leží (štítky v panelu), přesun jednoho souboru
 * i všech při přepnutí — a hlavně ukládací kanál scény (`sceneRef`): nahrání a mazání
 * souborů jde přes obal, který ví, kam ukládat, a poznamená si, kde soubor skončil.
 */
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ask } from './dialog'
import { isLocalAsset } from './lib/assets'
import { MissingLocalFile } from './lib/localFiles'
import type { FileStorage } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'

/** Kam ukládat soubory v nové scéně: poslední volba uživatele v tomhle prohlížeči, jinak cloud. */
const STORAGE_KEY = 'geo.fileStorage'
function readStorageDefault(): FileStorage {
  try { return localStorage.getItem(STORAGE_KEY) === 'local' ? 'local' : 'cloud' } catch { return 'cloud' }
}

const placeName = (to: FileStorage) => (to === 'local' ? 'do tohoto počítače' : 'do cloudu')
const moveError = (e: unknown) => e instanceof MissingLocalFile
  ? 'soubor v tomhle počítači není (nahrál se jinde)'
  : e instanceof Error ? e.message : String(e)

export type FileStorageTool = ReturnType<typeof useFileStorage>

export function useFileStorage(scene: ScenePersist) {
  const [fileStorage, setFileStorage] = useState<FileStorage>(() => scene.initial.fileStorage ?? readStorageDefault())
  const storageRef = useRef(fileStorage); storageRef.current = fileStorage
  // kde který soubor scény leží (podle id řádku) — štítky v panelu a přesun při přepnutí
  const [files, setFiles] = useState<Record<string, { at: FileStorage; name: string }>>(
    () => Object.fromEntries(scene.assets.map(a => [a.id, { at: isLocalAsset(a) ? 'local' : 'cloud', name: a.name }])),
  )
  const warnedShared = useRef(false)
  // Ukládací kanál si držíme v refu: volají ho i callbacky Cesia, které se registrují jednou
  // při startu a jinak by pořád koukaly na první verzi propu. Nahrání a mazání jde přes obal:
  // nahrání dostane, kam ukládat, a obojí si poznamená, kde soubor leží.
  const sceneRef = useRef(scene)
  sceneRef.current = useMemo<ScenePersist>(() => ({
    ...scene,
    uploadAsset: async opts => {
      const row = await scene.uploadAsset({ ...opts, local: opts.local ?? storageRef.current === 'local' })
      const local = isLocalAsset(row)
      setFiles(f => ({ ...f, [row.id]: { at: local ? 'local' : 'cloud', name: row.name } }))
      if (local && scene.shared && !warnedShared.current) {
        warnedShared.current = true
        toast.info(`„${row.name}" zůstal jen v tomto počítači — kolegové ani návštěvníci odkazu ho neuvidí.`, { duration: 9000 })
      }
      return row
    },
    deleteAsset: async id => {
      await scene.deleteAsset(id)
      setFiles(f => { const n = { ...f }; delete n[id]; return n })
    },
  }), [scene])

  const [movingFiles, setMovingFiles] = useState(false)

  /** Přesune jeden soubor; vrátí, jestli se to povedlo. */
  async function moveFile(assetId: string, to: FileStorage): Promise<boolean> {
    try {
      const row = await sceneRef.current.moveAsset(assetId, to)
      setFiles(f => ({ ...f, [assetId]: { at: isLocalAsset(row) ? 'local' : 'cloud', name: row.name } }))
      return true
    } catch (e) {
      console.error('Přesun souboru selhal:', e)
      throw e
    }
  }

  /** Přesun jednoho souboru z panelu (s potvrzením — do počítače se z cloudu smaže). */
  async function moveOne(assetId: string, to: FileStorage) {
    const name = files[assetId]?.name ?? 'soubor'
    const msg = to === 'local'
      ? 'Stáhne se do tohoto počítače a z cloudu se smaže. Na jiném počítači se pak scéna zeptá, kde soubor je.'
        + (scene.shared ? '\n\nScénu vidí i další lidé — tenhle soubor pak neuvidí.' : '')
      : 'Nahraje se do cloudu a tady se smaže — pak půjde otevřít odkudkoliv a uvidí ho i kolegové.'
    if (!(await ask({ title: `Přesunout „${name}" ${placeName(to)}?`, message: msg, okLabel: 'Přesunout' }))) return
    const t = toast.loading(`Přesouvám „${name}" ${placeName(to)}…`)
    try { await moveFile(assetId, to); toast.success(`„${name}" je ${to === 'local' ? 'jen v tomto počítači' : 'v cloudu'}`, { id: t }) } catch (e) { toast.error(`„${name}" se nepřesunul: ${moveError(e)}`, { id: t }) }
  }

  /**
   * Přepnutí, kam scéna ukládá soubory. Platí hned pro nové importy; když už scéna nějaké
   * soubory na druhém místě má, zeptá se, jestli je přesunout taky (jinak zůstanou, kde jsou).
   */
  async function changeStorage(to: FileStorage) {
    if (to === fileStorage || movingFiles) return
    if (to === 'local' && scene.shared && !(await ask({
      title: 'Ukládat jen do tohoto počítače?',
      message: 'Scénu vidí i další lidé (kolegové nebo odkaz pro prohlížení). Soubory, které zůstanou jen tady, neuvidí — u nich se scéna zeptá, kde jsou.',
      okLabel: 'Přesto jen do počítače',
    }))) return
    setFileStorage(to)
    sceneRef.current.patchState({ fileStorage: to })
    try { localStorage.setItem(STORAGE_KEY, to) } catch { /* jen výchozí pro nové scény */ }
    const others = Object.entries(files).filter(([, f]) => f.at !== to).map(([id]) => id)
    if (!others.length) { toast.success(`Nové soubory se budou ukládat ${placeName(to)}`); return }
    const move = await ask({
      title: `Přesunout i stávající soubory (${others.length}) ${placeName(to)}?`,
      message: to === 'local'
        ? 'Stáhnou se z cloudu do tohoto počítače a z cloudu se smažou. Na jiném počítači se pak scéna zeptá, kde jsou.'
        : 'Nahrají se z tohoto počítače do cloudu a tady se smažou. Pak půjdou otevřít odkudkoliv.',
      okLabel: 'Přesunout', cancelLabel: 'Jen nové soubory',
    })
    if (!move) { toast.success(`Nové soubory se budou ukládat ${placeName(to)}, stávající zůstanou, kde jsou`); return }
    setMovingFiles(true)
    const t = toast.loading(`Přesouvám soubory ${placeName(to)} (0/${others.length})…`)
    const failed: string[] = []
    let done = 0
    for (const id of others) {
      try { await moveFile(id, to) } catch (e) { failed.push(`„${files[id]?.name ?? id}": ${moveError(e)}`) }
      done++
      toast.loading(`Přesouvám soubory ${placeName(to)} (${done}/${others.length})…`, { id: t })
    }
    setMovingFiles(false)
    if (!failed.length) toast.success(`Přesunuto ${others.length} ${others.length === 1 ? 'soubor' : others.length < 5 ? 'soubory' : 'souborů'} ${placeName(to)}`, { id: t })
    else toast.warning(`Přesunuto ${others.length - failed.length} z ${others.length}. Nepovedlo se: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ' …' : ''}`, { id: t, duration: 15000 })
  }

  return { sceneRef, fileStorage, files, movingFiles, moveOne, changeStorage }
}
