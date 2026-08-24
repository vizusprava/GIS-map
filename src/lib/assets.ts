/**
 * Nahrané soubory scény — modely, výkresy, rastry.
 *
 * Řádek v `geo_assets` vzniká PŘED nahráním binárky, protože jeho id je zároveň jméno
 * souboru v bucketu (`{owner}/{scene}/{asset}.glb`). Když nahrávání selže, řádek smažeme
 * zpátky — jinak by v přehledu zůstal soubor, který se nedá otevřít.
 *
 * `config` (usazení modelu, výška výkresu, průhlednost rastru) se ukládá odloženě: tahání
 * sliderem jinak vystřelí request na každý pixel.
 */
import { supabase } from './supabase'
import { downloadFile, extOf, removeFiles, uploadFile } from './storage'
import type { AssetConfig, AssetKind, AssetRow } from './types'

const CONFIG_DEBOUNCE_MS = 800

export async function listAssets(sceneId: string): Promise<AssetRow[]> {
  const { data, error } = await supabase
    .from('geo_assets')
    .select('*')
    .eq('scene_id', sceneId)
    .order('sort_order')
    .order('created_at')
  if (error) throw new Error(`Soubory scény se nepodařilo načíst: ${error.message}`)
  return (data ?? []) as AssetRow[]
}

/**
 * Uloží nahraný soubor do scény. `sidecar` je doprovodný soubor rastru (.jgw/.tfw/.prj).
 * Vrací hotový řádek — volající si z něj vezme `id`, kterým pak hlásí změny usazení.
 */
export async function createAsset(opts: {
  sceneId: string
  ownerId: string
  kind: AssetKind
  name: string
  file: File
  sidecar?: File | null
  config?: AssetConfig
}): Promise<AssetRow> {
  const { sceneId, ownerId, kind, name, file, sidecar, config } = opts

  const { data: row, error } = await supabase
    .from('geo_assets')
    .insert({
      scene_id: sceneId, kind, name,
      file_name: file.name,
      // dočasně; skutečné cesty dopíšeme, jak známe id (to je součást cesty)
      file_path: 'pending',
      sidecar_name: sidecar?.name ?? null,
      size_bytes: file.size + (sidecar?.size ?? 0),
      config: config ?? {},
    })
    .select('*')
    .single()
  if (error) throw new Error(`Zápis souboru do scény selhal: ${error.message}`)

  const asset = row as AssetRow
  const filePath = `${ownerId}/${sceneId}/${asset.id}${extOf(file.name)}`
  const sidecarPath = sidecar ? `${ownerId}/${sceneId}/${asset.id}${extOf(sidecar.name)}` : null

  try {
    await uploadFile(filePath, file)
    if (sidecar && sidecarPath) await uploadFile(sidecarPath, sidecar)
    const { data: updated, error: upErr } = await supabase
      .from('geo_assets')
      .update({ file_path: filePath, sidecar_path: sidecarPath })
      .eq('id', asset.id)
      .select('*')
      .single()
    if (upErr) throw upErr
    return updated as AssetRow
  } catch (e) {
    // uklidit po sobě, ať v přehledu nezůstane rozbitý záznam
    await removeFiles([filePath, sidecarPath])
    await supabase.from('geo_assets').delete().eq('id', asset.id)
    throw new Error(`Nahrání souboru „${name}“ selhalo: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function getAsset(assetId: string): Promise<AssetRow | null> {
  const { data, error } = await supabase.from('geo_assets').select('*').eq('id', assetId).maybeSingle()
  if (error) throw new Error(`Soubor se nepodařilo načíst: ${error.message}`)
  return (data as AssetRow | null) ?? null
}

/** Stáhne binárku souboru zpátky jako `File` — do stejného importu jako z disku. */
export function fetchAssetFile(asset: AssetRow): Promise<File> {
  return downloadFile(asset.file_path, asset.file_name)
}

/** Stáhne doprovodný soubor rastru (world file), pokud ho asset má. */
export async function fetchAssetSidecar(asset: AssetRow): Promise<File | null> {
  if (!asset.sidecar_path || !asset.sidecar_name) return null
  return downloadFile(asset.sidecar_path, asset.sidecar_name)
}

/** Smaže soubor scény i jeho binárky. Cesty si dohledá sám, stačí id. */
export async function deleteAsset(assetId: string): Promise<void> {
  cancelConfigSave(assetId)
  const { data } = await supabase.from('geo_assets').select('file_path, sidecar_path').eq('id', assetId).maybeSingle()
  const row = data as Pick<AssetRow, 'file_path' | 'sidecar_path'> | null
  if (row) await removeFiles([row.file_path, row.sidecar_path])
  const { error } = await supabase.from('geo_assets').delete().eq('id', assetId)
  if (error) throw new Error(`Smazání souboru selhalo: ${error.message}`)
}

export async function renameAsset(assetId: string, name: string): Promise<void> {
  const { error } = await supabase.from('geo_assets').update({ name }).eq('id', assetId)
  if (error) throw new Error(`Přejmenování souboru selhalo: ${error.message}`)
}

// ── Odložené ukládání `config` ──────────────────────────────────────────────────
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const pending = new Map<string, AssetConfig>()

async function push(assetId: string): Promise<void> {
  const config = pending.get(assetId)
  if (!config) return
  pending.delete(assetId)
  const { error } = await supabase.from('geo_assets').update({ config }).eq('id', assetId)
  if (error) {
    if (!pending.has(assetId)) pending.set(assetId, config)
    console.error('Uložení nastavení souboru selhalo:', error)
  }
}

/** Naplánuje uložení nastavení souboru (usazení modelu, výška výkresu, alfa rastru). */
export function saveAssetConfig(assetId: string, config: AssetConfig): void {
  pending.set(assetId, config)
  const t = timers.get(assetId)
  if (t) clearTimeout(t)
  timers.set(assetId, setTimeout(() => { timers.delete(assetId); void push(assetId) }, CONFIG_DEBOUNCE_MS))
}

/** Dopíše rozpracovaná nastavení hned (odchod ze scény). */
export async function flushAssetConfigs(): Promise<void> {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  await Promise.all([...pending.keys()].map(push))
}

/** Zahodí naplánované uložení — soubor se maže, není kam ho zapsat. */
function cancelConfigSave(assetId: string): void {
  const t = timers.get(assetId)
  if (t) { clearTimeout(t); timers.delete(assetId) }
  pending.delete(assetId)
}
