/**
 * Scény uživatele — přehled, zakládání, přejmenování, mazání a ukládání stavu.
 *
 * Stav scény (pohledy kamery, popisky, měření, parcely…) je jeden JSON blob. Ukládá se
 * ODLOŽENĚ (debounce): při tahání sliderem nebo posunu popisku by jinak letěl request na
 * každý pixel. Před zavřením/refreshem se rozpracované uložení ještě dopíše (`flushScene`).
 */
import { supabase } from './supabase'
import { removeFiles, uploadFile } from './storage'
import type { AssetRow, SceneRow, SceneState } from './types'

/** Kolik čekat od poslední změny, než se stav pošle na server. */
const SAVE_DEBOUNCE_MS = 1200

export async function listScenes(): Promise<SceneRow[]> {
  const { data, error } = await supabase
    .from('geo_scenes')
    .select('*')
    .order('opened_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
  if (error) throw new Error(`Seznam scén se nepodařilo načíst: ${error.message}`)
  return (data ?? []) as SceneRow[]
}

export async function getScene(id: string): Promise<SceneRow | null> {
  const { data, error } = await supabase.from('geo_scenes').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`Scénu se nepodařilo načíst: ${error.message}`)
  return (data as SceneRow | null) ?? null
}

export async function createScene(name: string, note?: string): Promise<SceneRow> {
  const { data, error } = await supabase
    .from('geo_scenes')
    .insert({ name, note: note ?? null, state: {} })
    .select('*')
    .single()
  if (error) throw new Error(`Scénu se nepodařilo vytvořit: ${error.message}`)
  return data as SceneRow
}

export async function renameScene(id: string, name: string, note?: string | null): Promise<void> {
  const patch: Record<string, unknown> = { name }
  if (note !== undefined) patch.note = note
  const { error } = await supabase.from('geo_scenes').update(patch).eq('id', id)
  if (error) throw new Error(`Přejmenování selhalo: ${error.message}`)
}

/** Označí scénu jako právě otevřenou — přehled podle toho řadí. */
export async function touchScene(id: string): Promise<void> {
  await supabase.from('geo_scenes').update({ opened_at: new Date().toISOString() }).eq('id', id)
}

/**
 * Smaže scénu i všechny její soubory. Řádky v `geo_assets` zmizí kaskádou z databáze,
 * binárky ve Storage ale ne — ty musíme uklidit sami, jinak by v bucketu zůstaly navždy.
 */
export async function deleteScene(scene: SceneRow): Promise<void> {
  const { data } = await supabase.from('geo_assets').select('file_path, sidecar_path').eq('scene_id', scene.id)
  const paths = (data ?? []).flatMap((a: Pick<AssetRow, 'file_path' | 'sidecar_path'>) => [a.file_path, a.sidecar_path])
  await removeFiles([...paths, scene.thumb_path])

  const { error } = await supabase.from('geo_scenes').delete().eq('id', scene.id)
  if (error) throw new Error(`Smazání scény selhalo: ${error.message}`)
}

/** Uloží náhled scény (snímek plátna) a zapíše cestu do řádku. */
export async function saveSceneThumb(sceneId: string, ownerId: string, png: Blob): Promise<string> {
  const path = `${ownerId}/${sceneId}/thumb.png`
  await uploadFile(path, png, 'image/png')
  // `thumb_path` se nemění, ale ukládáme ho i tak — první náhled scény ho ještě nemá
  await supabase.from('geo_scenes').update({ thumb_path: path }).eq('id', sceneId)
  return path
}

// ── Odložené ukládání stavu ─────────────────────────────────────────────────────
// Jeden timer na scénu. `pending` drží poslední známý stav, takže rychlé změny za sebou
// se sloučí do jednoho requestu s tou nejnovější hodnotou.
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const pending = new Map<string, SceneState>()
const inFlight = new Set<string>()

async function push(sceneId: string): Promise<void> {
  const state = pending.get(sceneId)
  if (!state) return
  pending.delete(sceneId)
  inFlight.add(sceneId)
  try {
    const { error } = await supabase.from('geo_scenes').update({ state }).eq('id', sceneId)
    if (error) throw error
  } catch (e) {
    // Neúspěch nesmí sebrat rozdělanou práci: stav vrátíme do fronty a zkusí se s další
    // změnou. Uživateli o tom neříkáme při každém zaškobrtnutí sítě.
    if (!pending.has(sceneId)) pending.set(sceneId, state)
    console.error('Uložení stavu scény selhalo:', e)
  } finally {
    inFlight.delete(sceneId)
  }
}

/** Naplánuje uložení stavu scény (sloučí rychlé změny do jednoho zápisu). */
export function saveSceneState(sceneId: string, state: SceneState): void {
  pending.set(sceneId, state)
  const t = timers.get(sceneId)
  if (t) clearTimeout(t)
  timers.set(sceneId, setTimeout(() => { timers.delete(sceneId); void push(sceneId) }, SAVE_DEBOUNCE_MS))
}

/** Dopíše rozpracované uložení hned (odchod ze scény, zavření okna). */
export async function flushScene(sceneId: string): Promise<void> {
  const t = timers.get(sceneId)
  if (t) { clearTimeout(t); timers.delete(sceneId) }
  await push(sceneId)
}

/** Čeká někde neuložená změna? (Pro varování „máte neuložené změny“.) */
export function hasPendingSave(sceneId?: string): boolean {
  if (sceneId) return pending.has(sceneId) || inFlight.has(sceneId)
  return pending.size > 0 || inFlight.size > 0
}
