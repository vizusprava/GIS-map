/**
 * Worker na parsování výkresů. Velký DXF se tokenizuje i několik sekund a DWG navíc prochází
 * WASM převodníkem — na hlavním vlákně by mapa po celou dobu stála (žádné překreslení, žádná
 * odezva myši). Tady běží vedle a mapa jen dostane hotové primitivy.
 */
import { parseDrawing, type DrawingRequest } from './drawingParse'
import { serveWorker } from './workerClient'

serveWorker<DrawingRequest, Awaited<ReturnType<typeof parseDrawing>>>(
  async ({ file }) => parseDrawing(file.name, await file.arrayBuffer()),
)
