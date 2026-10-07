/**
 * Import 3D modelů: změření, syrové textury z GLB a georeferencování modelu z 3ds Maxu.
 *
 * three je tu JEN na čtení geometrie (nejnižší bod, vrcholy pro půdorys) — vykreslování si
 * Cesium dělá samo ze stejného souboru.
 *
 * Modul je záměrně bez Cesia: příprava modelu (`prepareModel`) běží ve workeru (modelWorker.ts),
 * protože u modelu s miliony vrcholů trvá i desítky vteřin a mapa by po celou dobu stála.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { wgsOf } from './tiles'
import { geoidN } from './geoid'
import { FOOT_MAX_TRIS_UNION, MASK_NAME_RE, FootprintGrid, concaveFootprint, simplifyRingCapped, unionOutlines } from './rings'
import { simplifyGltfMaterials } from './gltfMaterials'
import type { Anchor } from './types'

// three loader jen pro změření modelu (nejnižší bod) — Cesium si model vykresluje sám
let gltfLoader: GLTFLoader | null = null
export function getGltfLoader(): GLTFLoader {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader()
    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')
    gltfLoader.setDRACOLoader(draco)
    gltfLoader.setMeshoptDecoder(MeshoptDecoder)
  }
  return gltfLoader
}

// ── Textury z GLB (Google 3D dlaždice) ─────────────────────────────────────────────
// Obrázek bereme jako SYROVÉ bajty z BIN chunku, ne přes canvas — žádné překódování,
// takže JPEG z Googlu doputuje do zipu v původní kvalitě a bez čekání na ImageBitmap.

export type GltfJson = {
  images?: { bufferView?: number; mimeType?: string }[]
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[]
  bufferViews?: { byteOffset?: number; byteLength: number }[]
}
export type GltfParser = { json: GltfJson; associations?: Map<object, { textures?: number }> }

/** BIN chunk z GLB. null = není to binární glTF nebo BIN chybí. */
export function glbBin(buf: ArrayBuffer): Uint8Array | null {
  const dv = new DataView(buf)
  if (dv.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) return null // 'glTF'
  let off = 12
  while (off + 8 <= dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true)
    if (type === 0x004e4942) return new Uint8Array(buf, off + 8, Math.min(len, dv.byteLength - off - 8)) // 'BIN\0'
    off += 8 + len
  }
  return null
}

/** Kopie bajtů obrázku z GLB (slice, ne view — jinak by nám v paměti visely celé dlaždice). */
export function gltfImage(json: GltfJson, bin: Uint8Array | null, imgIdx: number): { bytes: Uint8Array; ext: string } | null {
  const img = json.images?.[imgIdx]
  if (!img || img.bufferView === undefined || !bin) return null
  const bv = json.bufferViews?.[img.bufferView]
  if (!bv) return null
  const mime = img.mimeType || ''
  if (mime.includes('ktx') || mime.includes('basis')) return null // MTL ani Max komprimované textury nepřečtou
  const start = bv.byteOffset || 0
  return { bytes: bin.slice(start, start + bv.byteLength), ext: mime.includes('png') ? 'png' : 'jpg' }
}

/** Index obrázku pro texturu materiálu — přes associations z GLTFLoaderu, jinak jediný obrázek v GLB. */
export function textureImageIndex(parser: GltfParser | undefined, json: GltfJson, tex: THREE.Texture | null): number | null {
  const ti = tex ? parser?.associations?.get(tex)?.textures : undefined
  if (ti !== undefined) {
    const td = json.textures?.[ti]
    const src = td?.source ?? (td?.extensions ? Object.values(td.extensions).find(e => e?.source !== undefined)?.source : undefined)
    if (src !== undefined) return src
  }
  return json.images?.length === 1 ? 0 : null
}


// ── WGS84 bez Cesia (stejné vzorce jako Cartesian3.fromDegrees a Transforms.eastNorthUpToFixedFrame) ──

type V3 = [number, number, number]
const RX2 = 6378137.0 ** 2, RZ2 = 6356752.3142451793 ** 2
const RAD = Math.PI / 180

/** zeměpisné souřadnice + výška nad elipsoidem → ECEF */
function ecefOf(lon: number, lat: number, h: number): V3 {
  const lo = lon * RAD, la = lat * RAD, cl = Math.cos(la)
  let nx = cl * Math.cos(lo), ny = cl * Math.sin(lo), nz = Math.sin(la)
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl
  const kx = RX2 * nx, ky = RX2 * ny, kz = RZ2 * nz
  const g = Math.sqrt(nx * kx + ny * ky + nz * kz)
  return [kx / g + nx * h, ky / g + ny * h, kz / g + nz * h]
}

/** lokální rámec východ–sever–nahoru v bodě `o` (ECEF), jako eastNorthUpToFixedFrame mimo póly */
function enuFrame(o: V3) {
  const ux0 = o[0] / RX2, uy0 = o[1] / RX2, uz0 = o[2] / RZ2
  const ul = Math.hypot(ux0, uy0, uz0)
  const up: V3 = [ux0 / ul, uy0 / ul, uz0 / ul]
  const el = Math.hypot(o[0], o[1])
  const east: V3 = [-o[1] / el, o[0] / el, 0]
  const north: V3 = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]]
  return { o, east, north, up }
}

// ── příprava modelu pro Cesium ──────────────────────────────────────────────────────

/** Co z přípravy modelu dostane mapa (stejné z workeru i ze záložního běhu na hlavním vlákně). */
export type PreparedModel = {
  /** GLB pro Cesium (zjednodušené materiály, převedený OBJ, georeferencovaný model); null = vykreslit původní soubor */
  glb: ArrayBuffer | null
  /** nejnižší bod modelu (gltf Y-up = cesium Z-up); null = nezměřeno */
  bottomZ: number | null
  /** model usazený podle S-JTSK z geometrie: kotva a obrys(y) půdorysu ve světě (ECEF) */
  geo: { anchor: Anchor; footprint: V3[][] | null } | null
}

const parseGltf = (buf: ArrayBuffer) => new Promise<THREE.Object3D>((res, rej) => {
  getGltfLoader().parse(buf, '', g => res((g as unknown as { scene: THREE.Object3D }).scene), rej)
})
const exportGlb = (obj: THREE.Object3D) =>
  new Promise<ArrayBuffer>((res, rej) => new GLTFExporter().parse(obj, r => res(r as ArrayBuffer), rej, { binary: true }))
const bottomOf = (obj: THREE.Object3D) => {
  const box = new THREE.Box3().setFromObject(obj)
  return Number.isFinite(box.min.y) ? box.min.y : null
}

/** Co s modelem udělat: zkusit georeferenci z S-JTSK, změřit nejnižší bod (obojí potřebuje three). */
export type PrepareOpts = { georef: boolean; measure: boolean; strict?: boolean }

/**
 * Model ze souboru → to, co se předá Cesiu. Soubor se parsuje JEDNOU (dřív zvlášť kvůli
 * georeferenci a zvlášť kvůli nejnižšímu bodu), a jen když je to potřeba.
 *
 * Vždycky se zjednoduší materiály na „jen barevná textura" (gltfMaterials.ts) — materiály
 * V-Ray z Maxu by jinak byly černé. Uložený soubor scény zůstává původní, tohle je jen kopie
 * pro zobrazení.
 * - OBJ se převede na GLB (otočení os jako náš export) a změří.
 * - GLB/glTF s `georef` zkusí rozpoznat reálné S-JTSK souřadnice v geometrii a zapéct je;
 *   s `measure` se změří; bez obojího (náš export s kotvou v názvu) se nic neparsuje.
 * Soubor, který three nepřečte, vrátí jen zjednodušené materiály — o chybě pak rozhodne Cesium.
 * Se `strict` (ve workeru) je to chyba: klient to pak zkusí ještě na hlavním vlákně, kde three umí víc.
 */
export async function prepareModel(name: string, buf: ArrayBuffer, opts: PrepareOpts): Promise<PreparedModel> {
  if (/\.obj$/i.test(name)) {
    const group = new OBJLoader().parse(new TextDecoder().decode(buf))
    group.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.geometry) { m.geometry.rotateX(-Math.PI / 2); m.geometry.rotateY(-Math.PI / 2) }
    })
    const bottomZ = bottomOf(group)
    return { glb: simplifyGltfMaterials(await exportGlb(group)), bottomZ, geo: null }
  }
  const simple = simplifyGltfMaterials(buf)
  if (!opts.georef && !opts.measure) return { glb: simple, bottomZ: null, geo: null }
  let scene: THREE.Object3D
  try { scene = await parseGltf(simple) } catch (e) {
    if (opts.strict) throw e
    return { glb: simple, bottomZ: null, geo: null }
  }
  scene.updateMatrixWorld(true)
  // změřit předem: nepovedená georeference mohla scénu napůl přepsat
  const bottomZ = bottomOf(scene)
  if (opts.georef) {
    try {
      const g = await georeferenceScene(scene)
      if (g) return g
    } catch (e) { console.error('Georeference selhala:', e) }
  }
  return { glb: simple, bottomZ, geo: null }
}

/**
 * Model z 3ds Max s reálnými S-JTSK (EPSG:5514) souřadnicemi v geometrii → přemapuje každý vrchol
 * proj4 (S-JTSK→WGS84) + výška Bpv→elipsoid a zapeče do lokálního ENU rámce (E,U,-N) kolem těžiště,
 * stejnou konvencí jako náš export. Vrací glb + geo-kotvu. null = nevypadá jako S-JTSK (necháme ruční).
 * Osy/znaménko se detekují z dat: výška = osa s nejmenší velikostí, horizontály dle velikosti (v ČR |Y|>|X|),
 * proj4 chce záporné hodnoty.
 */
async function georeferenceScene(scene: THREE.Object3D): Promise<PreparedModel | null> {
  const box = new THREE.Box3().setFromObject(scene)
  if (box.isEmpty()) return null
  const c = box.getCenter(new THREE.Vector3())
  const comp = (v: THREE.Vector3, a: 'x' | 'y' | 'z') => (a === 'x' ? v.x : a === 'y' ? v.y : v.z)
  // velké souřadnice (statisíce metrů) ⇒ S-JTSK; jinak běžný model
  if (Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)) < 100000) return null

  const axes: Array<{ k: 'x' | 'y' | 'z'; val: number }> = [
    { k: 'x' as const, val: c.x }, { k: 'y' as const, val: c.y }, { k: 'z' as const, val: c.z },
  ].sort((a, b) => Math.abs(a.val) - Math.abs(b.val))
  const upAxis = axes[0].k                        // nejmenší velikost = výška
  const xAxis = axes[1].k, yAxis = axes[2].k       // menší horizontální = S-JTSK X, větší = Y
  const fx = axes[1].val > 0 ? -1 : 1              // proj4 EPSG:5514 chce záporné
  const fy = axes[2].val > 0 ? -1 : 1
  const toSjtsk = (v: THREE.Vector3): [number, number, number] => [fx * comp(v, xAxis), fy * comp(v, yAxis), comp(v, upAxis)]

  const [aLon, aLat] = wgsOf(fx * comp(c, xAxis), fy * comp(c, yAxis))
  // Bpv → elipsoid jednou hodnotou pro celý model (v kotvě): přes pár set metrů se kvazigeoid
  // mění o milimetry a model tak zůstane tuhý
  const geoid = geoidN(aLon, aLat)
  const anchor: Anchor = { lon: aLon, lat: aLat, h: comp(c, upAxis) + geoid }
  const { o: O, east: E, north: N, up: U } = enuFrame(ecefOf(anchor.lon, anchor.lat, anchor.h))
  const vw = new THREE.Vector3()
  let minU = Infinity
  // Obrys celého modelu: body jdou rovnou do mřížky obrysu. Dřív se sbíralo pole všech
  // vrcholů — u modelu s miliony vrcholů stovky MB jen na tohle.
  const grid = new FootprintGrid()
  const maskTris = new Map<string, [number, number][][]>() // ENU trojúhelníky maskovacích objektů (podle názvu)

  const meshes: THREE.Mesh[] = []
  scene.traverse(obj => { const m = obj as THREE.Mesh; if (m.isMesh && m.geometry) meshes.push(m) })
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry
    const pos = g.attributes.position as THREE.BufferAttribute
    const wm = m.matrixWorld
    const isMask = MASK_NAME_RE.test(m.name)
    const meshEN: [number, number][] = isMask ? new Array(pos.count) : [] // ENU vrcholy jen u masky (pro trojúhelníky)
    for (let i = 0; i < pos.count; i++) {
      vw.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(wm) // do světových souřadnic (respektuj hierarchii)
      const [sx, sy, up] = toSjtsk(vw)
      const [lon, lat] = wgsOf(sx, sy)
      const p = ecefOf(lon, lat, up + geoid)
      const dx = p[0] - O[0], dy = p[1] - O[1], dz = p[2] - O[2]
      // (east, north, up) v ENU kolem kotvy
      const oe = E[0] * dx + E[1] * dy + E[2] * dz
      const on = N[0] * dx + N[1] * dy + N[2] * dz
      const ou = U[0] * dx + U[1] * dy + U[2] * dz
      pos.setXYZ(i, oe, ou, -on)                // gltf (E, U, -N) — stejné jako buildExportScene
      if (ou < minU) minU = ou
      grid.add(oe, on)
      if (isMask) meshEN[i] = [oe, on]
    }
    if (isMask) {
      let tris = maskTris.get(m.name); if (!tris) { tris = []; maskTris.set(m.name, tris) }
      const idx = g.index
      if (idx) { for (let t = 0; t + 2 < idx.count; t += 3) tris.push([meshEN[idx.getX(t)], meshEN[idx.getX(t + 1)], meshEN[idx.getX(t + 2)]]) }
      else { for (let t = 0; t + 2 < meshEN.length; t += 3) tris.push([meshEN[t], meshEN[t + 1], meshEN[t + 2]]) }
    }
    pos.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
  }
  // world transformy jsou zapečené do vrcholů → vynuluj všechny node transformy
  scene.traverse(obj => { obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1); obj.updateMatrix() })
  scene.updateMatrixWorld(true)

  // export z three umí materiály zase přikrášlit (barva, kovovost) — srovnat znovu
  const glb = simplifyGltfMaterials(await exportGlb(scene))

  // obrys(y) půdorysu → svět přes kotvu (přesné, nezávislé na Cesium korekci os).
  // Maskovací objekty: přesný obrys geometrie (union trojúhelníků) → vhloubení zůstanou nevyříznutá.
  // Bez masek: konkávní obal celého modelu.
  const enToWorld = (e: number, n: number): V3 => [O[0] + E[0] * e + N[0] * n, O[1] + E[1] * e + N[1] * n, O[2] + E[2] * e + N[2] * n]
  const footprint: V3[][] = []
  if (maskTris.size) {
    for (const [name, tris] of maskTris) {
      let rings: [number, number][][]
      if (tris.length > FOOT_MAX_TRIS_UNION) { const cf = concaveFootprint(tris.flat()); rings = cf ? [cf] : []; console.warn(`Maska „${name}": ${tris.length} trojúhelníků je moc na přesný obrys → použit konkávní obal`) }
      else rings = unionOutlines(tris)
      for (const r of rings) { const simp = simplifyRingCapped(r); if (simp) footprint.push(simp.map(([e, n]) => enToWorld(e, n))) }
    }
  } else {
    const ring = concaveFootprint(grid.points())
    if (ring) footprint.push(ring.map(([e, n]) => enToWorld(e, n)))
  }
  return {
    glb,
    bottomZ: Number.isFinite(minU) ? minU : 0,
    geo: { anchor, footprint: footprint.length ? footprint : null },
  }
}
