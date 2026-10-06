/**
 * Parsování výkresu mimo hlavní vlákno (worker v drawingWorker.ts, společná mechanika
 * ve workerClient.ts). DWG navíc v sobě po parsování drží WASM převodník s desítkami MB
 * paměti — proto se worker po chvíli nečinnosti ukončí.
 */
import type { DrawParse } from './dxf'
import { parseDrawing, type DrawingRequest } from './drawingParse'
import { workerClient } from './workerClient'

const run = workerClient<DrawingRequest, DrawParse>({
  create: () => new Worker(new URL('./drawingWorker.ts', import.meta.url), { type: 'module', name: 'vykresy' }),
  // soubor jde do workeru jako odkaz na blob — bajty se čtou až tam, hlavní vlákno je nekopíruje
  onMain: ({ file }) => file.arrayBuffer().then(buf => parseDrawing(file.name, buf)),
  crashMessage: 'Zpracování výkresu spadlo — nejspíš na něj nestačila paměť prohlížeče.',
})

export function parseDrawingFile(file: File): Promise<DrawParse> {
  return run({ file })
}
