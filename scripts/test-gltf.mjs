/**
 * Kontrola zjednodušení materiálů glTF (`src/gltfMaterials.ts`).
 *
 * Materiály V-Ray z 3ds Maxu přicházejí v glTF jako kov s černou barvou a hromadou map —
 * v mapě pak byly modely černé. Po zjednodušení musí zůstat jen barevná textura (a průhlednost),
 * geometrie a textury v BIN části bajt po bajtu stejné.
 *
 * Spustit: `npm run test:gltf`
 */
import { simplifyGltfMaterials } from '../src/gltfMaterials.ts'

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

/** GLB z JSONu a binárních dat (JSON doplněný mezerami, BIN nulami — jako exportéry). */
function glb(json, bin) {
  const enc = new TextEncoder().encode(JSON.stringify(json))
  const jl = (enc.length + 3) & ~3, bl = (bin.length + 3) & ~3
  const out = new Uint8Array(12 + 8 + jl + 8 + bl)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true)
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true)
  out.set(enc, 20); out.fill(0x20, 20 + enc.length, 20 + jl)
  dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true)
  out.set(bin, 28 + jl)
  return out.buffer
}
/** JSON a BIN zpátky z GLB */
function read(buf) {
  const dv = new DataView(buf)
  const jl = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)))
  const bl = dv.getUint32(20 + jl, true)
  return { json, bin: new Uint8Array(buf, 28 + jl, bl), length: dv.getUint32(8, true), real: buf.byteLength, jl }
}

const bin = new Uint8Array(1003).map((_, i) => (i * 37) & 255)
const vray = {
  asset: { version: '2.0' },
  extensionsUsed: ['KHR_materials_specular', 'KHR_materials_ior', 'KHR_texture_transform'],
  extensionsRequired: ['KHR_materials_ior'],
  materials: [
    // V-Ray s texturou: kov, černá barva (násobila by texturu), mapy a rozšíření navíc
    {
      name: 'Cihla_VRay',
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [2, 2] } } },
        baseColorFactor: [0, 0, 0, 1], metallicFactor: 1, roughnessFactor: 0, metallicRoughnessTexture: { index: 1 },
      },
      normalTexture: { index: 2 }, occlusionTexture: { index: 3 }, emissiveTexture: { index: 4 }, emissiveFactor: [1, 1, 1],
      extensions: { KHR_materials_specular: { specularFactor: 1 }, KHR_materials_ior: { ior: 1.6 } },
      doubleSided: true,
    },
    // bez textury, čistě černá = exportér materiálu nerozuměl
    { name: 'Neznamy', pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1], metallicFactor: 1 } },
    // bez textury s barvou: barva zůstane
    { name: 'Omitka', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.85, 0.7, 1], metallicFactor: 0.4 } },
    // průhledné sklo: průhlednost zůstane
    { name: 'Sklo', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.3, 0.4, 0.3] }, alphaMode: 'BLEND' },
    // starý specular-glossiness: difuzní textura → barevná
    { name: 'SG', extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseTexture: { index: 5 }, diffuseFactor: [0.5, 0.5, 0.5, 1] } } },
  ],
}
const out = read(simplifyGltfMaterials(glb(vray, bin)))
const [cihla, neznamy, omitka, sklo, sg] = out.json.materials

ok(out.bin.length >= bin.length && bin.every((b, i) => out.bin[i] === b), 'BIN (geometrie, textury) bajt po bajtu stejný')
ok(out.length === out.real && out.jl % 4 === 0, `hlavička GLB sedí (délka ${out.length}, JSON zarovnaný na 4)`)
ok(cihla.pbrMetallicRoughness.baseColorTexture?.index === 0, 'textura barvy zůstala')
ok(cihla.pbrMetallicRoughness.baseColorTexture?.extensions?.KHR_texture_transform?.scale?.[0] === 2, 'posun/měřítko textury (KHR_texture_transform) zůstalo')
ok(JSON.stringify(cihla.pbrMetallicRoughness.baseColorFactor) === '[1,1,1,1]', `barva u textury bílá (nenásobí ji): ${JSON.stringify(cihla.pbrMetallicRoughness.baseColorFactor)}`)
ok(cihla.pbrMetallicRoughness.metallicFactor === 0 && cihla.pbrMetallicRoughness.roughnessFactor === 1, 'matný, ne kov')
ok(!cihla.pbrMetallicRoughness.metallicRoughnessTexture && !cihla.normalTexture && !cihla.occlusionTexture && !cihla.emissiveTexture && !cihla.emissiveFactor, 'mapy navíc pryč')
ok(!cihla.extensions, `rozšíření materiálu pryč: ${JSON.stringify(cihla.extensions)}`)
ok(cihla.doubleSided === true && cihla.name === 'Cihla_VRay', 'oboustrannost a jméno zůstaly')
ok(JSON.stringify(neznamy.pbrMetallicRoughness.baseColorFactor) === '[0.8,0.8,0.8,1]', 'čistě černá bez textury → šedá')
ok(JSON.stringify(omitka.pbrMetallicRoughness.baseColorFactor) === '[0.9,0.85,0.7,1]' && omitka.pbrMetallicRoughness.metallicFactor === 0, 'barva bez textury zůstala, kov pryč')
ok(sklo.alphaMode === 'BLEND' && sklo.pbrMetallicRoughness.baseColorFactor[3] === 0.3, 'průhlednost zůstala')
ok(sg.pbrMetallicRoughness.baseColorTexture?.index === 5 && !sg.extensions, 'specular-glossiness → barevná textura')
ok(JSON.stringify(out.json.extensionsUsed) === '["KHR_texture_transform"]', `seznam rozšíření: ${JSON.stringify(out.json.extensionsUsed)}`)
ok(out.json.extensionsRequired === undefined, 'povinná rozšíření materiálů pryč (Cesium by je odmítlo)')

// část modelu bez UV s texturovaným materiálem: Cesium by spadlo na shaderu („v_texCoord_0")
const uvJson = {
  asset: { version: '2.0' },
  materials: [{ name: 'Asfalt', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [0.4, 0.4, 0.42, 1] } }],
  meshes: [{ primitives: [
    { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, material: 0 },
    { attributes: { POSITION: 3, NORMAL: 4 }, material: 0 },
    { attributes: { POSITION: 5 }, material: 0 },
  ] }],
}
const uv = read(simplifyGltfMaterials(glb(uvJson, bin))).json
const [pa, pb, pc] = uv.meshes[0].primitives
ok(pa.material === 0 && uv.materials[0].pbrMetallicRoughness.baseColorTexture?.index === 0, 'část s UV má dál texturu')
ok(pb.material === 1 && pc.material === 1 && uv.materials.length === 2, `části bez UV dostaly jednu společnou kopii materiálu (${pb.material}, ${pc.material})`)
ok(!uv.materials[1].pbrMetallicRoughness.baseColorTexture, 'kopie bez textury')
ok(JSON.stringify(uv.materials[1].pbrMetallicRoughness.baseColorFactor) === '[0.4,0.4,0.42,1]', `kopie má původní barvu: ${JSON.stringify(uv.materials[1].pbrMetallicRoughness.baseColorFactor)}`)
ok(uv.materials[1].name === 'Asfalt (bez UV)', 'kopie je poznat podle jména')

// posun textury z Maxu: dlaždicování od levého dolního rohu → glTF od horního (cedule)
const maxJson = (generator, transform) => ({
  asset: generator ? { version: '2.0', generator } : { version: '2.0' },
  materials: [{ name: 'Cedule', pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: transform } } } }],
})
const tt = (generator, transform) => read(simplifyGltfMaterials(glb(maxJson(generator, transform), bin))).json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform
const cedule = tt(undefined, { scale: [0.333, 0.517] })
ok(cedule.offset?.[0] === 0 && Math.abs(cedule.offset[1] - 0.483) < 1e-9, `z Maxu (bez generátoru): posun ${JSON.stringify(cedule.offset)}`)
ok(tt('Autodesk 3ds Max glTF', { scale: [0.5, 0.25] }).offset?.[1] === 0.75, 'z Maxu (generátor Autodesk): posun dopočítaný')
ok(tt('Khronos glTF Blender I/O', { scale: [0.333, 0.517] }).offset === undefined, 'z Blenderu beze změny')
ok(tt('THREE.GLTFExporter r184', { scale: [0.333, 0.517] }).offset === undefined, 'z three.js (po georeferenci) beze změny — nedopočítá se dvakrát')
ok(JSON.stringify(tt(undefined, { scale: [0.5, 0.5], offset: [0.1, 0.2] }).offset) === '[0.1,0.2]', 'zapsaný posun se nemění')

// glTF jako text
const text = new TextEncoder().encode(JSON.stringify(vray)).buffer
const tj = JSON.parse(new TextDecoder().decode(simplifyGltfMaterials(text)))
ok(tj.materials[0].pbrMetallicRoughness.metallicFactor === 0 && !tj.materials[0].normalTexture, 'glTF jako text: zjednodušený taky')

// co není glTF nebo nemá materiály → beze změny (tentýž buffer)
const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer
ok(simplifyGltfMaterials(junk) === junk, 'jiný soubor projde beze změny')
const plain = glb({ asset: { version: '2.0' } }, bin)
ok(simplifyGltfMaterials(plain) === plain, 'GLB bez materiálů beze změny')

console.log(fails ? `\n${fails} kontrol selhalo` : '\nVŠE OK')
process.exit(fails ? 1 : 0)
