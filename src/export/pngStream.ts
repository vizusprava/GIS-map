/**
 * Zápis PNG po řádcích — obrázek se nikdy neskládá celý v paměti.
 *
 * Na první pohled to u PNG nejde: obrazová data jsou jeden souvislý zlib proud, takže to vypadá,
 * že se musí zkomprimovat najednou. Nemusí — proud se dá krmit po kouscích a výstup rozsekat do
 * několika IDAT bloků, což formát dovoluje. Stejný trik jako u TIFF pruhů, jen s kompresí.
 *
 * Proti nekomprimovanému TIFFu vyjde soubor zhruba na polovinu, bezztrátově a s alfou. Letecký
 * snímek je šum, takže zázraky od PNG čekat nelze — ale polovina je polovina.
 *
 * Řádky jdou bez predikce (filtr 0). Filtry by pár procent ušetřily, jenže přes gigapixely stojí
 * čas a hlavně je to další místo, kde se dá udělat chyba a vyrobit nečitelný soubor.
 */
import { Zlib } from 'three/examples/jsm/libs/fflate.module.js'

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

const CRC_TABLE = /*#__PURE__*/ (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** Blok PNG: délka, typ, data, CRC — všechno big-endian, na rozdíl od TIFFu. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false) // CRC přes typ+data
  return out
}

export type PngStream = {
  /** Pruh řádků VČETNĚ vedoucího filtrovacího bajtu na každém řádku (proto rowStride = W*samples + 1). */
  push: (rows: Uint8Array) => Uint8Array[]
  end: () => Uint8Array[]
}

/**
 * Otevře PNG proud. Vrací bloky k zápisu — volající je pošle do souboru, tenhle modul o cíli nic neví.
 * `samples` je 3 (RGB) nebo 4 (RGBA).
 */
export function openPng(W: number, H: number, samples: number): { head: Uint8Array; stream: PngStream } {
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, W, false)
  dv.setUint32(4, H, false)
  ihdr[8] = 8                       // 8 bitů na kanál
  ihdr[9] = samples === 4 ? 6 : 2   // 6 = RGBA, 2 = RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // deflate, standardní filtry, bez prokládání

  const head = new Uint8Array(SIGNATURE.length + 25)
  head.set(SIGNATURE, 0)
  head.set(chunk('IHDR', ihdr), SIGNATURE.length)

  let out: Uint8Array[] = []
  const z = new Zlib({ level: 6 }, (d: Uint8Array) => { if (d.length) out.push(chunk('IDAT', d)) })
  const take = () => { const o = out; out = []; return o }

  return {
    head,
    stream: {
      push: rows => {
        z.push(rows, false)
        z.flush() // vynutí výstup → v kompresoru se nehromadí a paměť zůstane plochá
        return take()
      },
      end: () => {
        z.push(new Uint8Array(0), true)
        return [...take(), chunk('IEND', new Uint8Array(0))]
      },
    },
  }
}

/**
 * World file — georeference vedle obrázku, stejný formát, jaký appka čte u vlastního ortofota.
 * Šest čísel: velikost pixelu X, dvě rotace (vždy 0), velikost pixelu Y (záporná, sever nahoře),
 * a souřadnice STŘEDU levého horního pixelu.
 */
export function worldFile(res: number, originX: number, originY: number): string {
  return [res, 0, 0, -res, originX + res / 2, originY - res / 2].join('\n') + '\n'
}
