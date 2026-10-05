/**
 * Nahrané soubory scény — modely, výkresy, rastry.
 *
 * Řádek v `geo_assets` vzniká PŘED nahráním binárky, protože jeho id je zároveň jméno
 * souboru v bucketu (`{owner}/{scene}/{asset}.glb`). Když nahrávání selže, řádek smažeme
 * zpátky — jinak by v přehledu zůstal soubor, který se nedá otevřít.
 *
 * `config` (usazení modelu, výška výkresu, průhlednost rastru) se ukládá odloženě: tahání
 * sliderem jinak vystřelí request na každý pixel.
 *
 * Soubor větší, než úložiště bere, může zůstat jen v tomhle počítači (`local: true`): řádek
 * vznikne stejně, jen cesta začíná `local:` a bajty jdou do úložiště prohlížeče (localFiles.ts).
 */
import { supabase } from './supabase'
import { cacheDel, cacheGet, cachePut } from '../cache'
import { downloadFile, extOf, removeFiles, uploadFile } from './storage'
import { MissingLocalFile, isLocalPath, localGet, localPath, localPut, requestPersistence } from './localFiles'
import { createSaveQueue } from './saveQueue'
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
  /** vlastník scény (ve sdílené scéně to nemusí být přihlášený) — do jeho složky jde soubor */
  ownerId: string
  kind: AssetKind
  name: string
  file: File
  sidecar?: File | null
  config?: AssetConfig
  /** nenahrávat, nechat jen v tomhle počítači (soubor je na úložiště moc velký) */
  local?: boolean
}): Promise<AssetRow> {
  const { sceneId, ownerId, kind, name, file, sidecar, config, local } = opts

  const { data: row, error } = await supabase
    .from('geo_assets')
    .insert({
      // vlastník SCÉNY, ne přihlášený: i soubor nahraný kolegou patří vlastníkovi (sql/003_sharing.sql)
      scene_id: sceneId, owner: ownerId, kind, name,
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
  const filePath = local ? localPath(asset.id, 'file') : `${ownerId}/${sceneId}/${asset.id}${extOf(file.name)}`
  const sidecarPath = !sidecar ? null : local ? localPath(asset.id, 'sidecar') : `${ownerId}/${sceneId}/${asset.id}${extOf(sidecar.name)}`

  try {
    if (local) {
      void requestPersistence()
      await localPut(filePath, file)
      if (sidecar && sidecarPath) await localPut(sidecarPath, sidecar)
    } else {
      await uploadFile(filePath, file)
      if (sidecar && sidecarPath) await uploadFile(sidecarPath, sidecar)
    }
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

/**
 * Klíč do lokální cache. Stačí `asset.id`, a to je podstatné: `createAsset` zakládá pro každé
 * nahrání NOVÝ řádek s novým id a to id je součástí cesty v bucketu, takže se binárka nikdy
 * nepřepisuje na místě — jedno id znamená navždycky tytéž bajty.
 *
 * Schválně NE `updated_at`: ten hlídá trigger a mění se i při pouhé změně `config`, tedy při
 * každém posunutí modelu. Cache by se tím zahazovala pořád dokola.
 */
const assetKey = (id: string, part: 'file' | 'sidecar') => `asset/${id}/${part}`

/**
 * Stáhne binárku souboru zpátky jako `File` — do stejného importu jako z disku.
 *
 * Napřed se kouká na disk prohlížeče. Bez toho stahovalo každé otevření scény všechny modely,
 * výkresy i rastry znovu ze Supabase, což je na free tarifu (5 GB přenosu měsíčně) ta věc, která
 * dojde jako první — úložiště na 1 GB vydrží dýl než přenos, když scénu otevíráš denně.
 *
 * Cache je best-effort: cokoliv se pokazí (kvóta, privátní režim), tiše se stáhne ze sítě.
 */
export async function fetchAssetFile(asset: AssetRow): Promise<File> {
  if (isLocalPath(asset.file_path)) return localFile(asset.file_path, asset.file_name, 'file')
  return cachedDownload(assetKey(asset.id, 'file'), asset.file_path, asset.file_name)
}

/** Stáhne doprovodný soubor rastru (world file), pokud ho asset má. */
export async function fetchAssetSidecar(asset: AssetRow): Promise<File | null> {
  if (!asset.sidecar_path || !asset.sidecar_name) return null
  if (isLocalPath(asset.sidecar_path)) return localFile(asset.sidecar_path, asset.sidecar_name, 'sidecar')
  return cachedDownload(assetKey(asset.id, 'sidecar'), asset.sidecar_path, asset.sidecar_name)
}

/** Soubor jen z tohohle počítače — když tu není, `MissingLocalFile` (obnova se zeptá, kde je). */
async function localFile(path: string, fileName: string, part: 'file' | 'sidecar'): Promise<File> {
  const b = await localGet(path)
  if (!b) throw new MissingLocalFile(part)
  return b instanceof File ? b : new File([b], fileName, { type: b.type || 'application/octet-stream' })
}

/** Je soubor scény uložený jen v tomhle počítači? */
export const isLocalAsset = (a: Pick<AssetRow, 'file_path'>) => isLocalPath(a.file_path)

/**
 * Dohledaný soubor (jiný počítač, vymazaná data prohlížeče) se uloží zpátky do tohohle
 * počítače, ať se příště načte sám.
 */
export async function relinkLocalAsset(asset: AssetRow, file: File, sidecar?: File | null): Promise<void> {
  void requestPersistence()
  if (isLocalPath(asset.file_path)) await localPut(asset.file_path, file)
  if (sidecar && isLocalPath(asset.sidecar_path)) await localPut(asset.sidecar_path, sidecar)
}

async function cachedDownload(key: string, path: string, fileName: string): Promise<File> {
  const hit = await cacheGet(key)
  if (hit) {
    // kopie do čerstvého bufferu: to, co vrací IndexedDB, si nechceme nechat držet
    return new File([new Uint8Array(hit)], fileName, { type: 'application/octet-stream' })
  }
  const file = await downloadFile(path, fileName)
  // uložení běží na pozadí — na výsledek nemá vliv a velký soubor by jinak zdržel zobrazení
  void file.arrayBuffer().then(b => cachePut(key, new Uint8Array(b))).catch(() => {})
  return file
}

// ── Přesun mezi cloudem a tímhle počítačem ─────────────────────────────────────
// Pořadí je vždycky stejné: nejdřív zapsat na nové místo, pak přepsat cestu v řádku, a teprve
// pak smazat ze starého. Kdyby cokoliv spadlo uprostřed (výpadek sítě, plné úložiště), soubor
// pořád leží tam, kam ukazuje řádek — nic se neztratí, nanejvýš zůstane kopie navíc.

async function getAsset(assetId: string): Promise<AssetRow> {
  const { data, error } = await supabase.from('geo_assets').select('*').eq('id', assetId).single()
  if (error || !data) throw new Error(`Soubor scény se nepodařilo načíst: ${error?.message ?? 'nenalezen'}`)
  return data as AssetRow
}

async function setPaths(asset: AssetRow, filePath: string, sidecarPath: string | null): Promise<AssetRow> {
  const { data, error } = await supabase.from('geo_assets')
    .update({ file_path: filePath, sidecar_path: sidecarPath })
    .eq('id', asset.id).select('*').single()
  if (error || !data) throw new Error(`Zápis nového umístění selhal: ${error?.message ?? 'bez odpovědi'}`)
  return data as AssetRow
}

/** Stáhne soubor z cloudu sem (do tohoto počítače) a z cloudu ho smaže. */
export async function moveAssetToLocal(assetId: string): Promise<AssetRow> {
  const asset = await getAsset(assetId)
  if (isLocalAsset(asset)) return asset
  const file = await fetchAssetFile(asset)
  const side = await fetchAssetSidecar(asset)
  void requestPersistence()
  const fp = localPath(asset.id, 'file'), sp = side ? localPath(asset.id, 'sidecar') : null
  await localPut(fp, file)
  if (side && sp) await localPut(sp, side)
  let moved: AssetRow
  try { moved = await setPaths(asset, fp, sp) } catch (e) { await removeFiles([fp, sp]); throw e }
  await removeFiles([asset.file_path, asset.sidecar_path]).catch(() => { /* v cloudu zůstane kopie — nevadí */ })
  return moved
}

/**
 * Nahraje soubor z tohoto počítače do cloudu a místní kopii smaže. Soubor musí být tady
 * (jinak `MissingLocalFile`) a vejít se do úložiště (jinak chyba s velikostí).
 */
export async function moveAssetToCloud(assetId: string, ownerId: string): Promise<AssetRow> {
  const asset = await getAsset(assetId)
  if (!isLocalAsset(asset)) return asset
  const file = await localGet(asset.file_path)
  if (!file) throw new MissingLocalFile('file')
  const side = isLocalPath(asset.sidecar_path) ? await localGet(asset.sidecar_path) : null
  if (isLocalPath(asset.sidecar_path) && !side) throw new MissingLocalFile('sidecar')
  const fp = `${ownerId}/${asset.scene_id}/${asset.id}${extOf(asset.file_name)}`
  const sp = side ? `${ownerId}/${asset.scene_id}/${asset.id}${extOf(asset.sidecar_name ?? '')}` : null
  // uploadFile sám zkontroluje velikost a řekne ji v chybě
  await uploadFile(fp, file)
  try {
    if (side && sp) await uploadFile(sp, side)
  } catch (e) { await removeFiles([fp]); throw e }
  let moved: AssetRow
  try { moved = await setPaths(asset, fp, sp) } catch (e) { await removeFiles([fp, sp]); throw e }
  await removeFiles([asset.file_path, asset.sidecar_path])   // místní kopie (local:…)
  return moved
}

/** Smaže soubor scény i jeho binárky. Cesty si dohledá sám, stačí id. */
export async function deleteAsset(assetId: string): Promise<void> {
  cancelConfigSave(assetId)
  const { data } = await supabase.from('geo_assets').select('file_path, sidecar_path').eq('id', assetId).maybeSingle()
  const row = data as Pick<AssetRow, 'file_path' | 'sidecar_path'> | null
  if (row) await removeFiles([row.file_path, row.sidecar_path])
  const { error } = await supabase.from('geo_assets').delete().eq('id', assetId)
  if (error) throw new Error(`Smazání souboru selhalo: ${error.message}`)
  // ať smazaný stomegový model nezabírá místo na disku, než na něj dojde LRU
  void cacheDel(assetKey(assetId, 'file')).catch(() => {})
  void cacheDel(assetKey(assetId, 'sidecar')).catch(() => {})
}

export async function renameAsset(assetId: string, name: string): Promise<void> {
  const { error } = await supabase.from('geo_assets').update({ name }).eq('id', assetId)
  if (error) throw new Error(`Přejmenování souboru selhalo: ${error.message}`)
}

// ── Odložené ukládání `config` ──────────────────────────────────────────────────
// Stejná fronta jako u stavu scény: slučuje, řadí zápisy za sebe a po chybě zkouší znovu.
const configSaves = createSaveQueue<AssetConfig>({
  debounceMs: CONFIG_DEBOUNCE_MS,
  label: 'Uložení nastavení souboru',
  send: async (assetId, config) => {
    const { error } = await supabase.from('geo_assets').update({ config }).eq('id', assetId)
    if (error) throw error
  },
})

/** Naplánuje uložení nastavení souboru (usazení modelu, výška výkresu, alfa rastru). */
export function saveAssetConfig(assetId: string, config: AssetConfig): void {
  configSaves.save(assetId, config)
}

/** Dopíše rozpracovaná nastavení hned (odchod ze scény). */
export function flushAssetConfigs(): Promise<void> {
  return configSaves.flush()
}

/** Čeká nějaké nastavení souboru na zápis? */
export function hasPendingAssetConfigs(): boolean {
  return configSaves.hasPending()
}

/** Zahodí naplánované uložení — soubor se maže, není kam ho zapsat. */
function cancelConfigSave(assetId: string): void {
  configSaves.cancel(assetId)
}
