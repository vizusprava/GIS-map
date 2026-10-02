/**
 * Práce s privátním bucketem `geo` — nahrání, podepsané URL, stažení, smazání.
 *
 * Bucket je privátní, takže se k souborům nedostane nikdo bez platné session. Odkazy jsou
 * dočasné (signed URL) a drží se v paměti, aby se stejný model nepodepisoval dokola —
 * Cesium si o URL řekne při každém načtení scény.
 */
import { supabase, BUCKET } from './supabase'
import { isLocalPath, localDel } from './localFiles'

const SIGN_TTL = 60 * 60 // 1 h — po tu dobu je odkaz na model/výkres platný

/**
 * Strop na velikost jednoho souboru. Supabase ho hlídá na serveru („The object exceeded the
 * maximum allowed size"), jenže to se pozná až po nahrání celého souboru a hláška neřekne
 * ani velikost, ani limit. Kontrolujeme proto předem.
 *
 * 50 MB je tvrdý strop tarifu Free a NEJDE ho zvednout ani resumable uploadem — je to limit
 * projektu, ne způsobu nahrávání. Po přechodu na Pro se zvedne v Storage Settings a sem se
 * nová hodnota dostane přes `VITE_MAX_UPLOAD_MB`.
 */
const MAX_UPLOAD_MB = Number(import.meta.env.VITE_MAX_UPLOAD_MB ?? 50)
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

export const fmtMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

const signCache = new Map<string, { url: string; exp: number }>()

/** Vrátí dočasné URL pro soubor v bucketu. Vyhodí chybu — bez souboru scéna nejde složit. */
export async function signedUrl(path: string, ttl = SIGN_TTL): Promise<string> {
  const now = Date.now()
  const hit = signCache.get(path)
  if (hit && hit.exp > now + 60_000) return hit.url

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, ttl)
  if (error || !data) throw new Error(`Soubor ${path} se nepodařilo zpřístupnit: ${error?.message ?? 'neznámá chyba'}`)
  signCache.set(path, { url: data.signedUrl, exp: now + ttl * 1000 })
  return data.signedUrl
}

/** Stejné jako `signedUrl`, ale místo chyby vrátí null (náhledy, kde selhání nevadí). */
export async function signedUrlOrNull(path: string | null | undefined): Promise<string | null> {
  if (!path) return null
  try { return await signedUrl(path) } catch { return null }
}

/** Odmítlo úložiště soubor kvůli velikosti (náš strop, nebo nižší strop serveru)? */
export function isTooLargeError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /maximum allowed size|too large|413|úložiště bere nejvýš/i.test(m)
}

/** Nahraje soubor na danou cestu (upsert — opakované nahrání přepíše). */
export async function uploadFile(path: string, file: Blob, contentType?: string): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`má ${fmtMb(file.size)}, úložiště bere nejvýš ${fmtMb(MAX_UPLOAD_BYTES)} na soubor`)
  }
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true,
    contentType: contentType ?? (file instanceof File ? file.type : undefined) ?? 'application/octet-stream',
  })
  if (error) throw new Error(`Nahrání souboru selhalo: ${error.message}`)
  signCache.delete(path) // po přepsání je staré URL na starý obsah
}

/** Stáhne soubor jako `File`, aby se dal poslat do stejného importu jako z disku. */
export async function downloadFile(path: string, fileName: string): Promise<File> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error || !data) throw new Error(`Stažení souboru ${fileName} selhalo: ${error?.message ?? 'neznámá chyba'}`)
  return new File([data], fileName, { type: data.type || 'application/octet-stream' })
}

/**
 * Smaže soubory (chybějící cesty se ignorují — mazání nesmí spadnout na půl cesty). Soubory
 * uložené jen v tomhle počítači (`local:…`, viz localFiles.ts) se smažou z prohlížeče.
 */
export async function removeFiles(paths: (string | null | undefined)[]): Promise<void> {
  const all = paths.filter((p): p is string => !!p)
  for (const p of all) if (isLocalPath(p)) await localDel(p)
  const list = all.filter(p => !isLocalPath(p))
  if (!list.length) return
  await supabase.storage.from(BUCKET).remove(list)
  for (const p of list) signCache.delete(p)
}

/** Přípona souboru včetně tečky (`.glb`), nebo prázdno. Storage podle ní pozná typ. */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i).toLowerCase() : ''
}
