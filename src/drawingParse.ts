/**
 * Soubor výkresu (DXF/DWG) → primitivy. Jedna cesta pro worker i pro záložní běh na hlavním
 * vlákně (viz drawingClient.ts), takže obě dají přesně totéž.
 *
 * Bez Cesia a DOMu — běží ve workeru.
 */
import { decodeDxf, dxfToPrims, type DrawParse } from './dxf'

export const isDwg = (name: string) => name.toLowerCase().endsWith('.dwg')

/** DWG jde přes WASM převodník, který se natáhne až teď (10 MB, kvůli DXF se nestahuje). */
export async function parseDrawing(name: string, buf: ArrayBuffer): Promise<DrawParse> {
  if (isDwg(name)) {
    const { dwgToPrims } = await import('./dwg')
    return dwgToPrims(buf)
  }
  return dxfToPrims(decodeDxf(buf))
}

export type DrawingRequest = { id: number; file: File }
export type DrawingResponse =
  | { id: number; ok: true; parse: DrawParse }
  | { id: number; ok: false; message: string }
