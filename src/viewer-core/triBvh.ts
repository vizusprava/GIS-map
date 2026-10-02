/**
 * Prostorový rejstřík trojúhelníků pro rychlý řez rovinou.
 *
 * Předvýběr podle obalu objektu ušetří většinu času u modelu složeného ze stovek kusů, ale
 * uvnitř jednoho velkého meshe (mostovka, terén, jeden slepený export) nepomůže vůbec —
 * tam se pořád testuje trojúhelník po trojúhelníku. Tenhle strom obalů to zkrátí na ty, které
 * rovina opravdu potkává: obvykle jednotky procent.
 *
 * Je to prostý BVH: uzly se dělí půlením podle nejdelší osy, listy mají pár trojúhelníků.
 * Test roviny proti obalu je jednořádkový — vzdálenost středu proti průmětu poloviny obalu
 * do normály — takže se celé větve zahazují bez sahání na geometrii.
 *
 * Vlastní, ne knihovna: potřebujeme jediný dotaz (rovina) a chceme to umět otestovat
 * v Node bez WebGL i bez další závislosti.
 */
import * as THREE from 'three'

export interface Bvh {
  /** pořadí trojúhelníků přeskládané tak, aby list ukazoval na souvislý úsek */
  tri: Uint32Array
  /** obal uzlu: 6 čísel (min xyz, max xyz) */
  box: Float32Array
  /** začátek úseku v `tri` (jen u listů) */
  start: Uint32Array
  /** počet trojúhelníků v listu; 0 = vnitřní uzel */
  count: Uint32Array
  /** potomci vnitřního uzlu */
  left: Uint32Array
  right: Uint32Array
  nodes: number
  triCount: number
}

/** nad tímhle počtem trojúhelníků se strom vyplatí; pod tím je režie větší než úspora */
export const BVH_MIN_TRIS = 2000
const LEAF = 8

const cache = new WeakMap<THREE.BufferGeometry, Bvh | null>()

/**
 * Strom obalů nad geometrií. Drží se u ní, takže se staví jednou za model.
 * Vrací `null`, když je geometrie tak malá, že se to nevyplatí.
 */
export function meshBvh(geo: THREE.BufferGeometry): Bvh | null {
  const had = cache.get(geo)
  if (had !== undefined) return had
  const built = buildBvh(geo)
  cache.set(geo, built)
  return built
}

function buildBvh(geo: THREE.BufferGeometry): Bvh | null {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!pos) return null
  const idx = geo.getIndex()
  const triCount = Math.floor((idx ? idx.count : pos.count) / 3)
  if (triCount < BVH_MIN_TRIS) return null

  // obal a těžiště každého trojúhelníku spočítáme jednou; dělení pak sahá jen na ně
  const tb = new Float32Array(triCount * 6)
  const cxs = new Float32Array(triCount)
  const cys = new Float32Array(triCount)
  const czs = new Float32Array(triCount)
  for (let t = 0; t < triCount; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k
      const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi)
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
      if (z < z0) z0 = z; if (z > z1) z1 = z
    }
    const o = t * 6
    tb[o] = x0; tb[o + 1] = y0; tb[o + 2] = z0
    tb[o + 3] = x1; tb[o + 4] = y1; tb[o + 5] = z1
    cxs[t] = (x0 + x1) / 2
    cys[t] = (y0 + y1) / 2
    czs[t] = (z0 + z1) / 2
  }

  const tri = new Uint32Array(triCount)
  for (let t = 0; t < triCount; t++) tri[t] = t

  const maxNodes = Math.max(1, 2 * Math.ceil(triCount / LEAF) + 1) * 2
  const box = new Float32Array(maxNodes * 6)
  const start = new Uint32Array(maxNodes)
  const count = new Uint32Array(maxNodes)
  const left = new Uint32Array(maxNodes)
  const right = new Uint32Array(maxNodes)
  let nodes = 0

  const bounds = (lo: number, hi: number, into: number) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
    for (let i = lo; i < hi; i++) {
      const o = tri[i] * 6
      if (tb[o] < x0) x0 = tb[o]; if (tb[o + 3] > x1) x1 = tb[o + 3]
      if (tb[o + 1] < y0) y0 = tb[o + 1]; if (tb[o + 4] > y1) y1 = tb[o + 4]
      if (tb[o + 2] < z0) z0 = tb[o + 2]; if (tb[o + 5] > z1) z1 = tb[o + 5]
    }
    const b = into * 6
    box[b] = x0; box[b + 1] = y0; box[b + 2] = z0
    box[b + 3] = x1; box[b + 4] = y1; box[b + 5] = z1
  }

  /**
   * Přesune medián podle osy na pozici `k` a rozdělí kolem něj — quickselect.
   *
   * Úplné setřídění úseku by dalo totéž, ale stálo by O(n log n) na každém uzlu; tady stačí
   * vědět, co patří nalevo a co napravo. U dvousettisícové mostovky je to rozdíl mezi
   * „stavba stromu trvá půl vteřiny" a „nevšimneš si jí".
   */
  const select = (lo: number, hi: number, k: number, axis: Float32Array) => {
    let a = lo
    let b = hi - 1
    while (a < b) {
      const pivot = axis[tri[(a + b) >> 1]]
      let i = a
      let j = b
      while (i <= j) {
        while (axis[tri[i]] < pivot) i++
        while (axis[tri[j]] > pivot) j--
        if (i <= j) {
          const t = tri[i]; tri[i] = tri[j]; tri[j] = t
          i++; j--
        }
      }
      if (k <= j) b = j
      else if (k >= i) a = i
      else break
    }
  }

  /** rozdělí úsek `[lo, hi)` a vrátí číslo uzlu */
  const build = (lo: number, hi: number): number => {
    const self = nodes++
    bounds(lo, hi, self)
    const n = hi - lo
    if (n <= LEAF) {
      start[self] = lo
      count[self] = n
      return self
    }
    const b = self * 6
    const sx = box[b + 3] - box[b]
    const sy = box[b + 4] - box[b + 1]
    const sz = box[b + 5] - box[b + 2]
    const axis = sx >= sy && sx >= sz ? cxs : sy >= sz ? cys : czs
    // půlení podle mediánu: strom vyjde vyvážený i u nerovnoměrné geometrie
    const mid = lo + (n >> 1)
    select(lo, hi, mid, axis)
    count[self] = 0
    left[self] = build(lo, mid)
    right[self] = build(mid, hi)
    return self
  }
  build(0, triCount)

  return { tri, box, start, count, left, right, nodes, triCount }
}

/**
 * Zavolá `cb` pro každý trojúhelník, jehož obal rovina protíná (s tolerancí `eps`).
 * Rovina musí být v LOKÁLNÍ soustavě geometrie — převede ji `planeToLocal`.
 */
export function trianglesNearPlane(bvh: Bvh, plane: THREE.Plane, eps: number, cb: (tri: number) => void): void {
  const { box, count, left, right, start, tri } = bvh
  const nx = plane.normal.x, ny = plane.normal.y, nz = plane.normal.z
  const d = plane.constant
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz)

  const stack: number[] = [0]
  while (stack.length) {
    const node = stack.pop() as number
    const b = node * 6
    const cx = (box[b] + box[b + 3]) / 2
    const cy = (box[b + 1] + box[b + 4]) / 2
    const cz = (box[b + 2] + box[b + 5]) / 2
    const hx = (box[b + 3] - box[b]) / 2
    const hy = (box[b + 4] - box[b + 1]) / 2
    const hz = (box[b + 5] - box[b + 2]) / 2
    // obal protíná rovinu, když je jeho střed blíž než průmět jeho poloviny do normály
    if (Math.abs(nx * cx + ny * cy + nz * cz + d) > ax * hx + ay * hy + az * hz + eps) continue
    if (count[node] > 0) {
      const s = start[node]
      for (let i = 0; i < count[node]; i++) cb(tri[s + i])
    } else {
      stack.push(left[node], right[node])
    }
  }
}

/** Rovina přepočtená do lokální soustavy objektu — strom je stavěný v ní. */
export function planeToLocal(plane: THREE.Plane, matrixWorld: THREE.Matrix4, out = new THREE.Plane()): THREE.Plane {
  return out.copy(plane).applyMatrix4(_inv.copy(matrixWorld).invert())
}
const _inv = new THREE.Matrix4()
