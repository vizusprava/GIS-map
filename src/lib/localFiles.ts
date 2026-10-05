/**
 * Soubory scény uložené JEN V TOMHLE POČÍTAČI — ty, které se nevešly do úložiště Supabase
 * (bere jen do `MAX_UPLOAD_BYTES` na soubor, viz storage.ts), a ty, které má uživatel u sebe
 * schválně (přepínač „Cloud / Tento počítač" u scény, přesun souboru — viz assets.ts).
 *
 * Scéna o nich ví: v `geo_assets` mají normální řádek, jen cesta místo bucketu začíná `local:`.
 * Bajty leží v trvalém úložišti prohlížeče (vlastní IndexedDB) — ne v cache dlaždic, kterou maže
 * LRU i tlačítko „vymazat". Na jiném počítači nebo po vymazání dat prohlížeče soubor chybí;
 * scéna se pak zeptá, kde je (sekce „Chybějící soubory"), a vybraný soubor si sem uloží.
 *
 * Prohlížeč smí úložiště při nedostatku místa vyklidit; o trvalé uložení se proto žádá
 * (`navigator.storage.persist()`), a i kdyby ho odmítl, scéna se pak jen zeptá znovu.
 */
const DB_NAME = 'geo-local-files'
const STORE = 'files'

export const LOCAL_PREFIX = 'local:'
/** Cesta souboru, který je jen v tomhle počítači (`local:<asset>/file`)? */
export const isLocalPath = (p?: string | null): p is string => !!p && p.startsWith(LOCAL_PREFIX)
export const localPath = (assetId: string, part: 'file' | 'sidecar') => `${LOCAL_PREFIX}${assetId}/${part}`

let dbP: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  dbP ??= new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => res(req.result)
    req.onerror = () => { dbP = null; rej(req.error) }
  })
  return dbP
}
function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(d => new Promise<T>((res, rej) => {
    const t = d.transaction(STORE, mode)
    const r = run(t.objectStore(STORE))
    t.oncomplete = () => res(r.result)
    t.onerror = () => rej(t.error ?? r.error)
    t.onabort = () => rej(t.error ?? new Error('Zápis do úložiště prohlížeče se přerušil'))
  }))
}

/** Uloží soubor (Blob jde do IndexedDB přímo — prohlížeč ho drží jako soubor, ne v paměti). */
export async function localPut(path: string, file: Blob): Promise<void> {
  await tx('readwrite', s => s.put(file, path))
}

/** Soubor z tohohle počítače, nebo null, když tu není (jiný počítač, vymazaná data). */
export async function localGet(path: string): Promise<Blob | null> {
  try { return (await tx<Blob | undefined>('readonly', s => s.get(path))) ?? null } catch { return null }
}

export async function localDel(path: string): Promise<void> {
  try { await tx('readwrite', s => s.delete(path)) } catch { /* nic tu nebylo */ }
}

/**
 * Požádá prohlížeč, ať úložiště stránky nevyklízí při nedostatku místa. Chrome to obvykle
 * povolí bez ptaní (podle toho, jak moc se stránka používá), Firefox se zeptá uživatele.
 */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false } catch { return false }
}

/** Soubor patřící ke scéně chybí v tomhle počítači — obnova ho nabídne k dohledání. */
export class MissingLocalFile extends Error {
  constructor(readonly part: 'file' | 'sidecar') {
    super(part === 'file' ? 'Soubor je uložený jen v počítači, kde se nahrál' : 'Doprovodný soubor je uložený jen v počítači, kde se nahrál')
    this.name = 'MissingLocalFile'
  }
}
