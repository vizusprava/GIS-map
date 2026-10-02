/**
 * Scény uživatele — přehled, zakládání, přejmenování, mazání a ukládání stavu.
 *
 * Stav scény (pohledy kamery, popisky, měření, parcely…) je jeden JSON blob. Ukládá se
 * ODLOŽENĚ (debounce): při tahání sliderem nebo posunu popisku by jinak letěl request na
 * každý pixel. Před zavřením/refreshem se rozpracované uložení ještě dopíše (`flushScene`).
 */
import { supabase } from './supabase'
import { removeFiles, uploadFile } from './storage'
import { createSaveQueue } from './saveQueue'
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

/**
 * Uloží náhled scény (zmenšený snímek mapy) a zapíše cestu do řádku.
 *
 * Náhled býval PNG (`thumb.png`), teď je JPEG — při prvním uložení se starý soubor uklidí
 * (`prevPath`), ať v úložišti nestraší. Smazání scény maže jen soubor, na který řádek ukazuje.
 */
export async function saveSceneThumb(sceneId: string, ownerId: string, img: Blob, prevPath?: string | null): Promise<string> {
  const path = `${ownerId}/${sceneId}/thumb.${img.type === 'image/png' ? 'png' : 'jpg'}`
  await uploadFile(path, img, img.type || 'image/jpeg')
  // cesta se mění jen při přechodu z PNG, ale zapisuje se vždy — první náhled scény ji ještě nemá
  const { error } = await supabase.from('geo_scenes').update({ thumb_path: path }).eq('id', sceneId)
  if (error) throw new Error(`Zápis náhledu selhal: ${error.message}`)
  if (prevPath && prevPath !== path) await removeFiles([prevPath]).catch(() => { /* jen úklid */ })
  return path
}

// ── Odložené ukládání stavu ─────────────────────────────────────────────────────
// Slučování, pořadí zápisů i opakování po chybě řeší `createSaveQueue`. Uživateli se o chybě
// neříká při každém zaškobrtnutí sítě — zápis se zopakuje sám a před zavřením okna se
// prohlížeč zeptá, pokud pořád něco čeká (viz ScenePage).
const sceneSaves = createSaveQueue<SceneState>({
  debounceMs: SAVE_DEBOUNCE_MS,
  label: 'Uložení stavu scény',
  send: async (sceneId, state) => {
    const { error } = await supabase.from('geo_scenes').update({ state }).eq('id', sceneId)
    if (error) throw error
  },
})

/** Naplánuje uložení stavu scény (sloučí rychlé změny do jednoho zápisu). */
export function saveSceneState(sceneId: string, state: SceneState): void {
  sceneSaves.save(sceneId, state)
}

/** Dopíše rozpracované uložení hned (odchod ze scény, zavření okna). */
export function flushScene(sceneId: string): Promise<void> {
  return sceneSaves.flush(sceneId)
}

/** Čeká někde neuložená změna? (Pro varování „máte neuložené změny“.) */
export function hasPendingSave(sceneId?: string): boolean {
  return sceneSaves.hasPending(sceneId)
}
