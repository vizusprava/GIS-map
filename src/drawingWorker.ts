/**
 * Worker na parsování výkresů. Velký DXF se tokenizuje i několik sekund a DWG navíc prochází
 * WASM převodníkem — na hlavním vlákně by mapa po celou dobu stála (žádné překreslení, žádná
 * odezva myši). Tady běží vedle a mapa jen dostane hotové primitivy.
 */
import { parseDrawing, type DrawingRequest, type DrawingResponse } from './drawingParse'

// Typy jdou přes DOM knihovnu projektu (lib „webworker" se s ní v jednom tsconfigu pere);
// `onmessage` i `postMessage(zpráva)` mají ve workeru stejný tvar.
self.onmessage = async (e: MessageEvent<DrawingRequest>) => {
  const { id, file } = e.data
  let res: DrawingResponse
  try {
    // soubor přijde jako odkaz na blob — bajty se čtou až tady, hlavní vlákno je nekopíruje
    res = { id, ok: true, parse: await parseDrawing(file.name, await file.arrayBuffer()) }
  } catch (err) {
    res = { id, ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(res)
}
