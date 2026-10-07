/**
 * Zjednodušení materiálů glTF/GLB na „jen barevná textura" — pro modely z 3ds Maxu.
 *
 * Exportér z Maxu překládá materiály V-Ray do glTF po svém a výsledek v Cesiu bývá černý:
 * odrazy V-Ray se zapíšou jako kovový materiál (kov bez mapy prostředí je černý), k textuře
 * se přidá černá základní barva (barva texturu násobí → černá), nebo se přidají rozšíření
 * a mapy, které nedávají smysl. Tady se z každého materiálu nechá jen barevná textura (nebo
 * barva, když textura není) a průhlednost; kovovost, lesk, normálové, okluzní a emisní mapy
 * i rozšíření materiálů se zahodí. Model pak má jednoduchý matný povrch s texturou.
 *
 * Mění se jen JSON hlavička — geometrie i textury v BIN části zůstanou bajt po bajtu, takže
 * je to rychlé i u stomegového modelu. Bez Cesia, three i DOMu (běží ve workeru, testuje se v Node).
 */

type TexInfo = { index: number; texCoord?: number; extensions?: Record<string, unknown> }
type Material = {
  pbrMetallicRoughness?: { baseColorTexture?: TexInfo; baseColorFactor?: number[]; [k: string]: unknown }
  extensions?: Record<string, { diffuseTexture?: TexInfo; diffuseFactor?: number[] } | undefined>
  alphaMode?: string
  alphaCutoff?: number
  doubleSided?: boolean
  name?: string
  [k: string]: unknown
}
type Primitive = { attributes?: Record<string, number>; material?: number; [k: string]: unknown }
type GltfJson = {
  materials?: Material[]
  meshes?: { primitives?: Primitive[] }[]
  extensionsUsed?: string[]
  extensionsRequired?: string[]
  [k: string]: unknown
}

const GLB_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a
/** rozšíření materiálů, která se zahazují (vše KHR_materials_* kromě „bez stínování") */
const isMaterialExt = (e: string) => e.startsWith('KHR_materials_') && e !== 'KHR_materials_unlit'

/** černá (nebo žádná) barva = materiál, kterému exportér nerozuměl */
const isDark = (c?: number[]) => !c || (c[0] < 0.02 && c[1] < 0.02 && c[2] < 0.02)

/** Jeden materiál → jen barevná textura / barva + průhlednost. */
function simplifyMaterial(m: Material): Material {
  const pbr = m.pbrMetallicRoughness ?? {}
  // starší „specular-glossiness" (Cesium ho umí, three už ne): difuzní textura = barevná
  const sg = m.extensions?.KHR_materials_pbrSpecularGlossiness
  const tex = pbr.baseColorTexture ?? sg?.diffuseTexture
  let factor = pbr.baseColorFactor ?? sg?.diffuseFactor
  if (tex) {
    // S texturou platí jen textura: barva by ji násobila (exportér tam rád dá černou).
    // Alfa zůstává — nese průhlednost.
    factor = [1, 1, 1, factor?.[3] ?? 1]
  } else if (factor && isDark(factor)) {
    // čistě černá bez textury = materiál, kterému exportér nerozuměl (V-Ray) → neutrální šedá
    factor = [0.8, 0.8, 0.8, factor[3] ?? 1]
  }
  const out: Material = {
    pbrMetallicRoughness: {
      ...(tex ? { baseColorTexture: tex } : {}),
      ...(factor ? { baseColorFactor: factor } : {}),
      metallicFactor: 0,
      roughnessFactor: 1,
    },
  }
  if (m.name !== undefined) out.name = m.name
  if (m.alphaMode !== undefined) out.alphaMode = m.alphaMode
  if (m.alphaCutoff !== undefined) out.alphaCutoff = m.alphaCutoff
  if (m.doubleSided !== undefined) out.doubleSided = m.doubleSided
  if (m.extensions?.KHR_materials_unlit) out.extensions = { KHR_materials_unlit: {} }
  return out
}

/**
 * Část modelu bez UV souřadnic, jejíž materiál má texturu: Cesium by na ní spadlo při stavbě
 * shaderu („'v_texCoord_0' : undeclared identifier") a zastavilo vykreslování celé mapy.
 * Stává se to po převodu V-Ray → Physical u objektů bez UVW mapování. Taková část dostane
 * kopii materiálu bez textury — jen barvu (původní z materiálu, u černé šedou).
 */
function fixMissingUv(json: GltfJson, origColors: (number[] | undefined)[]) {
  const mats = json.materials!
  const noTex = new Map<number, number>() // materiál → jeho kopie bez textury
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      if (p.material === undefined) continue
      const m = mats[p.material]
      const tex = m?.pbrMetallicRoughness?.baseColorTexture
      if (!tex) continue
      const tt = tex.extensions?.KHR_texture_transform as { texCoord?: number } | undefined
      const uv = tt?.texCoord ?? tex.texCoord ?? 0
      if (p.attributes?.[`TEXCOORD_${uv}`] !== undefined) continue
      let copy = noTex.get(p.material)
      if (copy === undefined) {
        const orig = origColors[p.material]
        const alpha = m.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1
        const rgb = isDark(orig) ? [0.8, 0.8, 0.8] : orig!.slice(0, 3)
        copy = mats.length
        mats.push({
          ...m,
          name: `${m.name ?? 'materiál'} (bez UV)`,
          pbrMetallicRoughness: { baseColorFactor: [...rgb, alpha], metallicFactor: 0, roughnessFactor: 1 },
        })
        noTex.set(p.material, copy)
      }
      p.material = copy
    }
  }
}

/**
 * Posun textury z Maxu: dlaždicování (Tiling) se v Maxu měří od LEVÉHO DOLNÍHO rohu textury,
 * v glTF od levého horního. Real-Time Exporter zapíše do KHR_texture_transform jen `scale`
 * a svislý posun nedopočítá — textura pak v appce sjede svisle a „přetočí se dokola"
 * (cedule: horní řádek dole). Správný posun je `1 − scale_v` (ověřeno na cedulích
 * z I_20_CB_Okruzni_ulice_MASTER.glb: s ním 15 z 15 ploch přesně v textuře, bez něj 0).
 *
 * Jen u souborů z Maxu (exportér nevyplňuje `asset.generator`, nebo se jmenuje po Maxu/Autodesku)
 * a jen tam, kde posun ani otočení zapsané nejsou — správně zapsané soubory z jiných programů
 * (Blender, three.js…) zůstanou, jak jsou.
 */
function fixMaxTextureOrigin(json: GltfJson) {
  const gen = (json.asset as { generator?: string } | undefined)?.generator
  if (gen && !/3ds ?max|autodesk/i.test(gen)) return
  for (const m of json.materials ?? []) {
    const infos = [m.pbrMetallicRoughness?.baseColorTexture, m.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture]
    for (const tex of infos) {
      const tt = tex?.extensions?.KHR_texture_transform as { scale?: number[]; offset?: number[]; rotation?: number } | undefined
      if (!tt?.scale || tt.offset || tt.rotation) continue
      tt.offset = [0, 1 - tt.scale[1]]
    }
  }
}

/** Upraví JSON glTF na místě; vrátí, jestli se něco změnilo. */
function simplifyJson(json: GltfJson): boolean {
  if (!json.materials?.length) return false
  fixMaxTextureOrigin(json)
  // původní barvy (před vybělením u textur) — pro části bez UV, které texturu mít nemůžou
  const origColors = json.materials.map(m =>
    m.pbrMetallicRoughness?.baseColorFactor ?? m.extensions?.KHR_materials_pbrSpecularGlossiness?.diffuseFactor)
  json.materials = json.materials.map(simplifyMaterial)
  fixMissingUv(json, origColors)
  // zahozená rozšíření pryč i ze seznamů — „povinné" neznámé rozšíření by Cesium odmítlo
  const stillUnlit = json.materials.some(m => m.extensions?.KHR_materials_unlit)
  const keep = (e: string) => !isMaterialExt(e) && (e !== 'KHR_materials_unlit' || stillUnlit)
  if (json.extensionsUsed) json.extensionsUsed = json.extensionsUsed.filter(keep)
  if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter(keep)
  if (json.extensionsUsed && !json.extensionsUsed.length) delete json.extensionsUsed
  if (json.extensionsRequired && !json.extensionsRequired.length) delete json.extensionsRequired
  return true
}

/**
 * GLB nebo glTF (JSON) → totéž se zjednodušenými materiály. Co není glTF, nebo nemá materiály,
 * vrátí beze změny (stejný buffer).
 */
export function simplifyGltfMaterials(buf: ArrayBuffer): ArrayBuffer {
  const dv = new DataView(buf)
  if (dv.byteLength >= 20 && dv.getUint32(0, true) === GLB_MAGIC) {
    const jsonLen = dv.getUint32(12, true)
    if (dv.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLen > dv.byteLength) return buf
    let json: GltfJson
    try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))) } catch { return buf }
    if (!simplifyJson(json)) return buf
    // nový JSON (doplněný mezerami na násobek 4) + zbytek souboru (BIN a případné další chunky) beze změny
    const enc = new TextEncoder().encode(JSON.stringify(json))
    const padded = (enc.length + 3) & ~3
    const restStart = 20 + jsonLen
    const rest = new Uint8Array(buf, restStart, dv.byteLength - restStart)
    const out = new Uint8Array(12 + 8 + padded + rest.length)
    const odv = new DataView(out.buffer)
    odv.setUint32(0, GLB_MAGIC, true)
    odv.setUint32(4, dv.getUint32(4, true), true)
    odv.setUint32(8, out.length, true)
    odv.setUint32(12, padded, true)
    odv.setUint32(16, CHUNK_JSON, true)
    out.set(enc, 20)
    out.fill(0x20, 20 + enc.length, 20 + padded)
    out.set(rest, 20 + padded)
    return out.buffer
  }
  // glTF jako JSON text (obvykle s daty vloženými v data: URI)
  const head = new Uint8Array(buf, 0, Math.min(64, buf.byteLength))
  const first = head.find(b => b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09 && b !== 0xef && b !== 0xbb && b !== 0xbf)
  if (first !== 0x7b /* { */) return buf
  let json: GltfJson
  try { json = JSON.parse(new TextDecoder().decode(buf)) } catch { return buf }
  if (!simplifyJson(json)) return buf
  return new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer
}
