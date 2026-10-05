/**
 * Worker na textury pozadí (landscape.ts). Generování krajiny a kreslení vrstev trvá na slabším
 * notebooku i půl vteřiny — na hlavním vlákně by mezitím zamrzlo přihlašovací okno. Svět se
 * spočítá jednou a drží se tu pro další žádosti (terén ve vyšším rozlišení pro přehled scén).
 *
 * Textury se posílají jako surové pixely, ne jako ImageBitmap: bitmapa z workeru se na Linuxu
 * se softwarovým vykreslováním při předání ztratila (plátna zůstala průhledná). Pixely projdou
 * všude a ArrayBuffer se předá bez kopírování.
 */
import { drawSet, makeWorld, toPixels, type LayerSet, type Pixels, type World } from './landscape'

export type LandscapeRequest = { id: number; set: LayerSet; res: number }
export type LandscapeResponse =
  | { id: number; ok: true; pixels: Pixels[] }
  | { id: number; ok: false; message: string }

let world: World | null = null
// typy jdou přes DOM knihovnu projektu (jako drawingWorker.ts); postMessage s přenosem bufferů
const post = (m: LandscapeResponse, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(m, transfer)

self.onmessage = (e: MessageEvent<LandscapeRequest>) => {
  const { id, set, res } = e.data
  try {
    world ??= makeWorld()
    const pixels = drawSet(world, set, res).map(toPixels)
    post({ id, ok: true, pixels }, pixels.map(p => p.data))
  } catch (err) {
    post({ id, ok: false, message: err instanceof Error ? err.message : String(err) })
  }
}
