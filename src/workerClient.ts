/**
 * Těžká práce mimo hlavní vlákno — společný základ pro výkresy, modely a rastry.
 *
 * Worker se pouští až s první úlohou a po chvíli nečinnosti se zase ukončí: po velkém souboru
 * v sobě drží desítky MB (WASM převodník DWG, scénu three.js…) a na slabším notebooku nemá
 * smysl je nechat ležet. Když worker nejde vůbec spustit (prohlížeč bez modulových workerů,
 * zakázané workery), úloha poběží postaru na hlavním vlákně — mapa po tu dobu stojí, ale
 * soubor se načte.
 *
 * Zprávy: do workeru `{ id, req }`, zpátky `{ id, ok: true, res }` nebo `{ id, ok: false, message }`
 * (viz `serveWorker`).
 */

export type WorkerReply<Res> = { id: number; ok: true; res: Res } | { id: number; ok: false; message: string }

/** po jaké nečinnosti se worker ukončí */
const IDLE_MS = 30_000

export function workerClient<Req, Res>(opts: {
  create: () => Worker
  /** stejná práce na hlavním vlákně (když worker nejde, případně viz `retryOnMain`) */
  onMain: (req: Req) => Promise<Res>
  /** worker běžel a spadl celý (typicky došla paměť) — hláška pro úlohy, které na něj čekaly */
  crashMessage: string
  /**
   * Chyba hlášená workerem se zkusí ještě jednou na hlavním vlákně. Pro práci, která ve
   * workeru nemusí jít celá (starší Safari neumí obrázky bez DOMu), ne pro vadné soubory.
   */
  retryOnMain?: boolean
}): (req: Req) => Promise<Res> {
  let worker: Worker | null = null
  /** worker už aspoň jednou odpověděl — spadne-li potom, není to tím, že by workery nešly */
  let worked = false
  let broken = false
  let nextId = 1
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<number, { req: Req; resolve: (r: Res) => void; reject: (e: Error) => void }>()

  function stop() {
    clearTimeout(idleTimer)
    worker?.terminate()
    worker = null
  }

  function fail(reason: unknown) {
    stop()
    const waiting = [...pending.values()]
    pending.clear()
    if (!worked) {
      console.warn('Worker nejde spustit, počítám na hlavním vlákně:', reason)
      broken = true
      for (const p of waiting) opts.onMain(p.req).then(p.resolve, p.reject)
    } else {
      // Běžel a spadl celý. Zkoušet totéž na hlavním vlákně by shodilo celou záložku;
      // další úloha si pustí nový worker.
      for (const p of waiting) p.reject(new Error(opts.crashMessage))
    }
  }

  function getWorker(): Worker | null {
    if (broken) return null
    if (worker) return worker
    try {
      worker = opts.create()
    } catch (e) {
      fail(e)
      return null
    }
    worker.onmessage = (e: MessageEvent<WorkerReply<Res>>) => {
      worked = true
      const r = e.data
      const p = pending.get(r.id)
      if (!p) return
      pending.delete(r.id)
      if (r.ok) p.resolve(r.res)
      else if (opts.retryOnMain) {
        console.warn('Ve workeru to nešlo, zkouším na hlavním vlákně:', r.message)
        opts.onMain(p.req).then(p.resolve, p.reject)
      } else p.reject(new Error(r.message))
      if (!pending.size) idleTimer = setTimeout(stop, IDLE_MS)
    }
    // chyba na workeru samotném (ne ve zprávě): nenačetl se modul, nebo spadl celý
    worker.onerror = (e) => { e.preventDefault(); fail(e.message || e) }
    return worker
  }

  return (req: Req) => {
    const w = getWorker()
    if (!w) return opts.onMain(req)
    clearTimeout(idleTimer)
    const id = nextId++
    return new Promise<Res>((resolve, reject) => {
      pending.set(id, { req, resolve, reject })
      w.postMessage({ id, req })
    })
  }
}

/**
 * Strana workeru: odpoví na každou úlohu výsledkem nebo chybou. `transfer` vybere z výsledku
 * buffery, které se předají bez kopírování.
 */
export function serveWorker<Req, Res>(handle: (req: Req) => Promise<Res>, transfer?: (res: Res) => Transferable[]) {
  // Typy jdou přes DOM knihovnu projektu (lib „webworker" se s ní v jednom tsconfigu pere);
  // postMessage s přenosem bufferů má ve workeru tenhle tvar.
  const post = (m: WorkerReply<Res>, t: Transferable[] = []) =>
    (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(m, t)
  self.onmessage = async (e: MessageEvent<{ id: number; req: Req }>) => {
    const { id, req } = e.data
    try {
      const res = await handle(req)
      post({ id, ok: true, res }, transfer?.(res) ?? [])
    } catch (err) {
      post({ id, ok: false, message: err instanceof Error ? err.message : String(err) })
    }
  }
}
