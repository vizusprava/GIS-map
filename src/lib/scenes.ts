/**
 * Scény uživatele — přehled, zakládání, přejmenování, mazání a ukládání stavu.
 *
 * Stav scény (pohledy kamery, popisky, měření, parcely…) je jeden JSON blob. Ukládá se
 * ODLOŽENĚ (debounce): při tahání sliderem nebo posunu popisku by jinak letěl request na
 * každý pixel. Před zavřením/refreshem se rozpracované uložení ještě dopíše (`flushScene`).
 *
 * Posílají se jen klíče, které se změnily (`patch_scene_state` je vmíchá do uloženého stavu) —
 * sdílenou scénu můžou mít otevřenou dva lidi naráz a celý stav by si navzájem přepisovali.
 * Bez migrace 003 se posílá celý stav jako dřív.
 */
import { supabase } from './supabase'
import { removeFiles, uploadFile } from './storage'
import { createSaveQueue } from './saveQueue'
import { createDirtyKeys, pickPatch } from './dirtyKeys'
import { myMemberships } from './sharing'
import { useAuthStore } from '../stores/authStore'
import type { AssetRow, SceneItem, SceneRow, SceneState } from './types'

/** Kolik čekat od poslední změny, než se stav pošle na server. */
const SAVE_DEBOUNCE_MS = 1200

/**
 * Moje scény i ty, které se mnou někdo nasdílel. U sdílené scény se „naposledy otevřeno" bere
 * z mého otevření, ne z vlastníkova — jinak by mi v přehledu poskakovala podle cizí práce.
 */
export async function listScenes(): Promise<SceneItem[]> {
  const uid = useAuthStore.getState().user?.id
  const { data, error } = await supabase.from('geo_scenes').select('*')
  if (error) throw new Error(`Seznam scén se nepodařilo načíst: ${error.message}`)
  const rows = (data ?? []) as SceneRow[]
  const mine = rows.some(r => r.owner !== uid) ? await myMemberships() : new Map()
  const items: SceneItem[] = rows.map(r => {
    if (r.owner === uid) return { ...r, role: 'owner' }
    const m = mine.get(r.id)
    return { ...r, role: m?.role ?? 'viewer', opened_at: m?.openedAt ?? null }
  })
  // naposledy otevřené první, nikdy neotevřené podle poslední změny
  const t = (iso: string | null) => (iso ? Date.parse(iso) : -Infinity)
  return items.sort((a, b) => t(b.opened_at) - t(a.opened_at) || t(b.updated_at) - t(a.updated_at))
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

/** Chybí v databázi funkce (migrace ještě neběžela)? */
const isMissingFn = (e: { code?: string; message: string }) => e.code === 'PGRST202' || /could not find the function/i.test(e.message)

/** Označí scénu jako právě otevřenou — přehled podle toho řadí (u sdílené scény jen mně). */
export async function touchScene(id: string): Promise<void> {
  const { error } = await supabase.rpc('touch_scene', { p_scene: id })
  if (error && isMissingFn(error)) await supabase.from('geo_scenes').update({ opened_at: new Date().toISOString() }).eq('id', id)
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
const dirty = createDirtyKeys()
/** Umí databáze ukládat po klíčích? (null = ještě nevíme, zjistí se prvním zápisem) */
let canPatch: boolean | null = null

const sceneSaves = createSaveQueue<SceneState>({
  debounceMs: SAVE_DEBOUNCE_MS,
  label: 'Uložení stavu scény',
  send: async (sceneId, state) => {
    const snap = dirty.take(sceneId)
    if (!snap.size) return
    if (canPatch !== false) {
      const { error } = await supabase.rpc('patch_scene_state', { p_scene: sceneId, p_patch: pickPatch(state, snap.keys()) })
      if (!error) { canPatch = true; dirty.done(sceneId, snap); return }
      if (!isMissingFn(error)) throw error
      canPatch = false
    }
    const { error } = await supabase.from('geo_scenes').update({ state }).eq('id', sceneId)
    if (error) throw error
    dirty.done(sceneId, snap)
  },
})

/**
 * Naplánuje uložení stavu scény (sloučí rychlé změny do jednoho zápisu). `keys` = které klíče
 * stavu se touhle změnou pohnuly; na server půjdou jen ty.
 */
export function saveSceneState(sceneId: string, state: SceneState, keys: string[]): void {
  dirty.mark(sceneId, keys)
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
