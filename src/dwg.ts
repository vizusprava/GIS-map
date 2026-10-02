/**
 * DWG → DXF přes LibreDWG (WASM), pak stejná cesta jako DXF (dxfToPrims).
 *
 * WASM se v prohlížeči načítá automaticky (Vite ho zabalí jako asset). Import je líný (volá se
 * jen z loadDrawing při .dwg), takže dokud uživatel DWG nenahraje, nula dopadu na velikost/výkon.
 *
 * POZOR: LibreDWG a jeho WASM wrapper jsou GPL (copyleft) — pro interní nástroj OK.
 */
import { LibreDwg } from '@mlightcad/libredwg-web'
import { dxfToPrims, type DrawParse } from './dxf'

let libP: ReturnType<typeof LibreDwg.create> | null = null

/**
 * Verze DWG podle hlavičky — prvních šest znaků souboru, např. `AC1032`.
 *
 * Je to jediná věc, kterou o souboru víme dřív, než se ho převodník dotkne. Když spadne,
 * je rozdíl mezi „tohle vůbec není DWG" a „je to DWG 2018, na které LibreDWG nestačí" —
 * a jen podle toho druhého se dá uživateli poradit něco užitečného.
 */
const DWG_VERSIONS: Record<string, string> = {
  AC1012: 'R13', AC1014: 'R14', AC1015: '2000', AC1018: '2004',
  AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018',
}

function dwgVersion(buf: ArrayBuffer): { code: string; label: string | null } {
  const code = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(6, buf.byteLength)))
  return { code, label: DWG_VERSIONS[code] ?? null }
}

export async function dwgToPrims(buf: ArrayBuffer): Promise<DrawParse> {
  const { code, label } = dwgVersion(buf)
  if (!code.startsWith('AC')) throw new Error(`Tohle nevypadá na DWG — hlavička souboru je „${code}".`)
  const what = label ? `DWG ${label}` : `DWG s hlavičkou ${code}`
  const mb = (buf.byteLength / 1048576).toFixed(1)

  if (!libP) libP = LibreDwg.create() // v prohlížeči si WASM najde sám
  let dxf: Uint8Array | string | null
  try {
    const lib = await libP
    dxf = lib.dwg_write_dxf(buf)
  } catch (e) {
    /**
     * Převodník spadl uvnitř WASM (typicky `memory access out of bounds`).
     *
     * Instance je po pádu v nedefinovaném stavu — paměť má rozšlapanou a další volání by
     * skončilo stejně. Kdyby se nechala v `libP`, spadl by i každý DALŠÍ import, včetně
     * souborů, které jsou úplně v pořádku, a vypadalo by to, že se rozbila celá aplikace.
     * Proto se zahodí a příští pokus si vyrobí čistou.
     */
    libP = null
    throw new Error(
      `Převodník DWG na tomhle souboru spadl (${what}, ${mb} MB). `
      + 'LibreDWG čte spolehlivě starší formáty; u novějších verzí a velkých výkresů to vzdá. '
      + 'Ulož výkres z CADu jako DXF a nahraj ten — jde stejnou cestou a nic se tím neztratí.',
      { cause: e },
    )
  }
  if (!dxf) throw new Error(`DWG se nepodařilo převést (${what}) — poškozený soubor nebo nepodporovaná verze. Zkus ho uložit jako DXF.`)
  const text = typeof dxf === 'string' ? dxf : new TextDecoder('utf-8').decode(dxf)
  return dxfToPrims(text)
}
