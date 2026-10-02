/**
 * Parsování výkresu mimo hlavní vlákno (worker v drawingWorker.ts).
 *
 * Worker se pouští až s prvním výkresem a po chvíli nečinnosti se zase ukončí: po DWG v sobě
 * drží WASM převodník s desítkami MB paměti a na slabším notebooku nemá smysl ho nechat ležet.
 * Když worker nejde vůbec spustit (prohlížeč bez modulových workerů, zakázané workery),
 * výkres se rozparsuje postaru na hlavním vlákně — mapa po tu dobu stojí, ale načte se.
 */
import type { DrawParse } from './dxf'
import { parseDrawing, type DrawingRequest, type DrawingResponse } from './drawingParse'

/** po jaké nečinnosti se worker ukončí */
const IDLE_MS = 30_000

let worker: Worker | null = null
/** worker už aspoň jednou odpověděl — spadne-li potom, není to tím, že by workery nešly */
let worked = false
let broken = false
let nextId = 1
let idleTimer: ReturnType<typeof setTimeout> | undefined
const pending = new Map<number, { file: File; resolve: (p: DrawParse) => void; reject: (e: Error) => void }>()

const onMainThread = (file: File) => file.arrayBuffer().then(buf => parseDrawing(file.name, buf))

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
    console.warn('Worker na výkresy nejde spustit, parsuju na hlavním vlákně:', reason)
    broken = true
    for (const p of waiting) onMainThread(p.file).then(p.resolve, p.reject)
  } else {
    // Běžel a spadl celý — typicky došla paměť na obřím výkresu. Zkoušet totéž na hlavním
    // vlákně by shodilo celou záložku; další výkres si pustí nový worker.
    for (const p of waiting) p.reject(new Error('Zpracování výkresu spadlo — nejspíš na něj nestačila paměť prohlížeče.'))
  }
}

function getWorker(): Worker | null {
  if (broken) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./drawingWorker.ts', import.meta.url), { type: 'module', name: 'vykresy' })
  } catch (e) {
    fail(e)
    return null
  }
  worker.onmessage = (e: MessageEvent<DrawingResponse>) => {
    worked = true
    const r = e.data
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    if (r.ok) p.resolve(r.parse)
    else p.reject(new Error(r.message))
    if (!pending.size) idleTimer = setTimeout(stop, IDLE_MS)
  }
  // chyba na workeru samotném (ne ve zprávě): nenačetl se modul, nebo spadl celý
  worker.onerror = (e) => { e.preventDefault(); fail(e.message || e) }
  return worker
}

export function parseDrawingFile(file: File): Promise<DrawParse> {
  const w = getWorker()
  if (!w) return onMainThread(file)
  clearTimeout(idleTimer)
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { file, resolve, reject })
    w.postMessage({ id, file } satisfies DrawingRequest)
  })
}
