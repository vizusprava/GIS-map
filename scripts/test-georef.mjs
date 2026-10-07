/**
 * Kontrola usazení modelu podle S-JTSK (`src/model3d.ts` → `georeferenceScene`).
 *
 * Osy a znaménka souřadnic se berou z dat, takže převod může model zrcadlit (v Maxu x = +Y
 * místo obvyklého −Y). Vrcholy pak sednou správně, ale trojúhelníky by se otočily rubem
 * nahoru — Cesium je shora nekreslí. Plocha, která je v Maxu lícem nahoru, musí lícem nahoru
 * zůstat při každé kombinaci znamének; sdílený index dvou částí se smí obrátit jen jednou.
 *
 * Spustit: `npm run test:georef`
 */

// GLTFExporter skládá GLB přes FileReader, který Node nemá
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(r => { this.result = r; this.onload?.({ target: this }); this.onloadend?.({ target: this }) }) }
}
const { prepareModel } = await import('../src/model3d.ts')

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

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
function read(buf) {
  const dv = new DataView(buf)
  const jl = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)))
  return { json, bin: new Uint8Array(buf, 28 + jl, dv.getUint32(20 + jl, true)) }
}
function accessor(json, bin, i) {
  const a = json.accessors[i], v = json.bufferViews[a.bufferView]
  const C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType]
  const from = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0)
  return new C(bin.buffer.slice(from, from + a.count * (a.type === 'VEC3' ? 3 : 1) * C.BYTES_PER_ELEMENT))
}

/**
 * Model s plochou 10×10 m lícem nahoru (glTF +Y) na souřadnicích (x0, z0). Dvě části se
 * stejným indexem a vlastními vrcholy (druhá o 20 m vedle) — jako mesh s víc materiály.
 */
function model(x0, z0) {
  const quad = dx => new Float32Array([x0 + dx, 460, z0, x0 + dx, 460, z0 + 10, x0 + dx + 10, 460, z0, x0 + dx + 10, 460, z0 + 10])
  const idx = new Uint16Array([0, 1, 2, 2, 1, 3])
  const parts = [quad(0), quad(20), idx]
  const bin = new Uint8Array(48 + 48 + 12)
  bin.set(new Uint8Array(parts[0].buffer), 0); bin.set(new Uint8Array(parts[1].buffer), 48); bin.set(new Uint8Array(idx.buffer), 96)
  const box = dx => ({ min: [x0 + dx, 460, z0], max: [x0 + dx + 10, 460, z0 + 10] })
  return glb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Deska' }],
    materials: [{}, {}],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 2, material: 0 }, { attributes: { POSITION: 1 }, indices: 2, material: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', ...box(0) },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', ...box(20) },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 12 }],
    buffers: [{ byteLength: bin.length }],
  }, bin)
}

/**
 * Sedlová střecha (sklon 31°) s vyhlazeným hřebenem jako z Maxu: na hřebeni jsou vrcholy
 * rozdělené (šev UV), ale normála je u obou stran svislá. Přepočet normál by z hřebene
 * udělal ostrou hranu — normály z Maxu se musí zachovat.
 */
function roof(x0, z0) {
  const pos = new Float32Array([
    x0, 460, z0, x0, 460, z0 + 10, x0 + 5, 463, z0, x0 + 5, 463, z0 + 10, // levá strana
    x0 + 5, 463, z0, x0 + 5, 463, z0 + 10, x0 + 10, 460, z0, x0 + 10, 460, z0 + 10, // pravá
  ])
  const l = Math.hypot(3, 5), nrm = new Float32Array([
    -3 / l, 5 / l, 0, -3 / l, 5 / l, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0, 3 / l, 5 / l, 0, 3 / l, 5 / l, 0,
  ])
  const idx = new Uint16Array([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7])
  const bin = new Uint8Array(96 + 96 + 24)
  bin.set(new Uint8Array(pos.buffer), 0); bin.set(new Uint8Array(nrm.buffer), 96); bin.set(new Uint8Array(idx.buffer), 192)
  return glb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Strecha' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [x0, 460, z0], max: [x0 + 10, 463, z0 + 10] },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 12, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }, { buffer: 0, byteOffset: 96, byteLength: 96 }, { buffer: 0, byteOffset: 192, byteLength: 24 }],
    buffers: [{ byteLength: bin.length }],
  }, bin)
}

/** Kolik trojúhelníků v GLB míří lícem nahoru (glTF +Y) a kolik normál vrcholů míří nahoru. */
function facesUp(buf) {
  const { json, bin } = read(buf)
  let tris = 0, up = 0, normals = 0, normalsUp = 0
  for (const mesh of json.meshes) for (const p of mesh.primitives) {
    const P = accessor(json, bin, p.attributes.POSITION)
    const I = p.indices !== undefined ? accessor(json, bin, p.indices) : P.map((_, i) => i).filter(i => i < P.length / 3)
    for (let t = 0; t + 2 < I.length; t += 3) {
      const v = k => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]
      const [a, b, c] = [v(0), v(1), v(2)]
      const e1 = b.map((q, k) => q - a[k]), e2 = c.map((q, k) => q - a[k])
      tris++
      if (e1[2] * e2[0] - e1[0] * e2[2] > 0) up++
    }
    if (p.attributes.NORMAL !== undefined) {
      const N = accessor(json, bin, p.attributes.NORMAL)
      for (let i = 1; i < N.length; i += 3) { normals++; if (N[i] > 0.9) normalsUp++ }
    }
  }
  return { tris, up, normals, normalsUp }
}

// v Maxu: (x, y) = (−Y, −X) je obvyklé (otočení), (+Y, −X) a (−Y, +X) zrcadlí, (+Y, +X) zase otočení
const cases = [
  ['Max (−Y, −X) — obvyklé', -768000, 1033000],
  ['Max (+Y, −X) — zrcadlí', 768000, 1033000],
  ['Max (+Y, +X) — otočené o 180°', 768000, -1033000],
  ['Max (−Y, +X) — zrcadlí', -768000, -1033000],
]
for (const [what, x, z] of cases) {
  const r = await prepareModel('deska.glb', model(x, z), { georef: true, measure: true })
  ok(!!r.geo, `${what}: usazeno podle S-JTSK`)
  const f = facesUp(r.glb)
  ok(f.tris === 4 && f.up === 4, `${what}: líc nahoru ${f.up}/${f.tris} trojúhelníků (sdílený index obrácený jednou)`)
  ok(f.normals > 0 && f.normalsUp === f.normals, `${what}: normály nahoru ${f.normalsUp}/${f.normals}`)

  const roofGlb = (await prepareModel('strecha.glb', roof(x, z), { georef: true, measure: true })).glb
  const rf = read(roofGlb)
  const p = rf.json.meshes[0].primitives[0], N = accessor(rf.json, rf.bin, p.attributes.NORMAL)
  const ny = i => N[i * 3 + 1]
  const ridge = [2, 3, 4, 5].map(ny), eaves = [0, 1, 6, 7].map(ny)
  ok(ridge.every(v => v > 0.999) && eaves.every(v => Math.abs(v - 5 / Math.hypot(3, 5)) < 0.01),
    `${what}: vyhlazení z Maxu zachované — hřeben ${ridge.map(v => v.toFixed(3)).join(' ')}, okap ${eaves.map(v => v.toFixed(3)).join(' ')}`)
  const ff = facesUp(roofGlb)
  // normály míří na stranu líce (ne dovnitř) — i u zrcadleného převodu
  const P = accessor(rf.json, rf.bin, p.attributes.POSITION), I = accessor(rf.json, rf.bin, p.indices)
  let agree = 0
  for (let t = 0; t < I.length; t += 3) {
    const v = k => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]
    const [a, b, c] = [v(0), v(1), v(2)], e1 = b.map((q, k) => q - a[k]), e2 = c.map((q, k) => q - a[k])
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], fl = Math.hypot(...fn)
    if ([0, 1, 2].every(k => (fn[0] * N[I[t + k] * 3] + fn[1] * N[I[t + k] * 3 + 1] + fn[2] * N[I[t + k] * 3 + 2]) / fl > 0.8)) agree++
  }
  ok(ff.up === ff.tris && agree === I.length / 3, `${what}: střecha lícem ven ${ff.up}/${ff.tris}, normály na straně líce ${agree}/${I.length / 3}`)
}

console.log(fails ? `\n${fails} kontrol selhalo` : '\nvše v pořádku')
process.exit(fails ? 1 : 0)
