/**
 * Worker na textury pozadí (landscape.ts). Generování krajiny a kreslení vrstev trvá na slabším
 * notebooku i půl vteřiny — na hlavním vlákně by mezitím zamrzlo přihlašovací okno. Svět se
 * spočítá jednou a drží se tu pro další žádosti (terén ve vyšším rozlišení pro přehled scén).
 */
import { drawSet, makeWorld, type LayerSet, type World } from './landscape'

export type LandscapeRequest = { id: number; set: LayerSet; res: number }
export type LandscapeResponse =
  | { id: number; ok: true; bitmaps: ImageBitmap[] }
  | { id: number; ok: false; message: string }

let world: World | null = null
// typy jdou přes DOM knihovnu projektu (jako drawingWorker.ts); postMessage s přenosem bitmap
const post = (m: LandscapeResponse, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(m, transfer)

self.onmessage = (e: MessageEvent<LandscapeRequest>) => {
  const { id, set, res } = e.data
  try {
    world ??= makeWorld()
    const bitmaps = drawSet(world, set, res).map(c => (c as OffscreenCanvas).transferToImageBitmap())
    post({ id, ok: true, bitmaps }, bitmaps)
  } catch (err) {
    post({ id, ok: false, message: err instanceof Error ? err.message : String(err) })
  }
}
