/**
 * Řez 3D modelu rovinou → 2D obrys výkresu.
 *
 * Trojúhelníky se ve světových souřadnicích protnou rovinou, vzniklé úsečky se svaří
 * do polylinií a promítnou do lokálních os roviny (u = vodorovná osa výkresu, v = svislá).
 * Uzavřené obrysy dostanou plochu (s detekcí děr přes paritu vnoření), otevřené jen délku.
 *
 * Modul je čistě geometrický — žádný React, DOM ani úložiště — aby šel testovat i mimo
 * prohlížeč a aby ho šlo použít i pro dávkový export.
 */
import * as THREE from 'three'
import { meshBvh, trianglesNearPlane, planeToLocal } from './triBvh'

export type Pt2 = [number, number]

export interface SectionPoly {
  pts: Pt2[]
  closed: boolean
  /** délka čáry; u uzavřených obrysů obvod */
  length: number
  /** plocha uzavřeného obrysu (vždy kladná); u otevřených 0 */
  area: number
  /** obrys leží uvnitř lichého počtu jiných → je to díra, od plochy se odečítá */
  hole: boolean
  /**
   * Odsazení roviny, ze které obrys pochází (m). 0 = vlastní řez, jinak je to jen kontext
   * z tloušťky řezu — kreslí se slabě a do rozměrů ani plochy se nepočítá.
   */
  depth: number
  /**
   * Obrys přibraný z okolí: rovina tenhle objekt vůbec nepotkala, ale byl blízko, tak se
   * řízl vlastní rovinou skrz svůj střed. Kreslí se plně, protože do výkresu opravdu patří,
   * ale do plochy a délky hlavního řezu se nepočítá — leží jinde než rovina.
   */
  nearby: boolean
  /**
   * Obrys z POHLEDU, ne z řezu: promítnutá hrana modelu z výřezu. Dá se z ní odečíst délka
   * i sklon a jde do DXF, ale do plochy řezu se nepočítá — neleží v rovině.
   *
   */
  projected: boolean
  /**
   * Zakrytá čára pohledu: leží za něčím bližším, takže se kreslí čárkovaně a do samostatné
   * vrstvy — přesně jako v CADu. U řezu ani u okolí nemá smysl, tam je vždycky `false`.
   */
  hidden: boolean
  /**
   * U obrysu pohledu vzdálenost od roviny řezu (m) — jak daleko za ní ta hrana leží.
   * Podle ní se pozná, jestli dvě čáry na témže místě jsou dva různé prvky za sebou.
   * U řezu je vždycky 0.
   */
  viewDepth: number
  /** materiál, ze kterého obrys pochází — podle něj se ve výkrese barví */
  group: string
  /** jméno objektu (meshe) v modelu */
  object: string
  /** rozměry samotného obrysu */
  width: number
  height: number
}

/** Jeden úsek obrysu — délka a sklon od vodorovné roviny. */
export interface SectionSegment {
  a: Pt2
  b: Pt2
  length: number
  /** úhel od vodorovné osy výkresu, −90°..90° */
  angle: number
}

/** Rozseká obrys na rovné úseky a spočítá jejich délku a sklon. */
export function polySegments(p: SectionPoly): SectionSegment[] {
  const out: SectionSegment[] = []
  for (let i = 1; i < p.pts.length; i++) {
    const a = p.pts[i - 1]
    const b = p.pts[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const length = Math.hypot(dx, dy)
    if (length < 1e-9) continue
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI
    if (angle > 90) angle -= 180
    if (angle <= -90) angle += 180
    out.push({ a, b, length, angle })
  }
  return out
}

export interface SectionResult {
  polys: SectionPoly[]
  minU: number
  maxU: number
  minV: number
  maxV: number
  /** rozměry obálky řezu v jednotkách modelu (metry) */
  width: number
  height: number
  /** součet délek všech řezných čar */
  cutLength: number
  /** plocha uzavřených obrysů po odečtení děr */
  area: number
  loops: number
  /** kolik objektů se přibralo z okolí roviny */
  nearbyCount: number
  opens: number
  /**
   * Objekty poblíž roviny, ze kterých ve výkrese nic není — a proč. Bez tohohle se u
   * chybějícího prvku nedá poznat, jestli je moc daleko, nebo ho rovina jen minula.
   * Seřazeno od nejbližšího.
   */
  missed: { object: string; group: string; gap: number; reason: string }[]
  /** počátek roviny — bod, ke kterému jsou 2D souřadnice vztažené */
  origin: THREE.Vector3
  u: THREE.Vector3
  v: THREE.Vector3
  normal: THREE.Vector3
  uLabel: string
  vLabel: string
  meshCount: number
  triCount: number
  /** doba výpočtu v ms — u velkých modelů se hodí vidět */
  ms: number
}

/**
 * Osy výkresu pro danou normálu. Svislá osa `v` míří nahoru (u vodorovného řezu na sever,
 * tj. −Z), vodorovná `u` doplňuje pravotočivou trojici — výkres tedy vidíme z kladné strany
 * normály, stejně jako když se na řez díváme zvenku.
 */
export function planeBasis(normal: THREE.Vector3, upAxis?: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3; n: THREE.Vector3 } {
  const n = normal.clone().normalize()
  // „Nahoru" je v modelu z prohlížeče +Y, ale v mapě je model v lokální ENU soustavě, kde je
  // nahoru +Z. Bez toho by byl svislý řez v mapě položený na bok.
  const up = upAxis ? upAxis.clone().normalize() : new THREE.Vector3(0, 1, 0)
  // Vodorovný řez (půdorys) nemá „nahoru" — svislou osu výkresu udělá sever. Ten se odvodí
  // z osy vzhůru, ať to sedí i v ENU: pro Y-nahoru vyjde −Z, pro Z-nahoru (mapa) +Y.
  const east = Math.abs(up.x) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
  const v = Math.abs(n.dot(up)) > 0.999
    ? new THREE.Vector3().crossVectors(up, east).normalize()
    : up.clone().addScaledVector(n, -n.dot(up)).normalize()    // svislý řez: nahoru = skutečně nahoru
  const u = new THREE.Vector3().crossVectors(v, n).normalize()
  return { u, v, n }
}

/** Popisek osy podle převažujícího světového směru; u šikmých rovin vrátí azimut. */
function axisLabel(w: THREE.Vector3): string {
  const comps: [string, number][] = [['X', w.x], ['Y', w.y], ['Z', w.z]]
  comps.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  const [name, val] = comps[0]
  if (Math.abs(val) > 0.98) return (val > 0 ? '+' : '−') + name
  const az = ((Math.atan2(w.x, -w.z) * 180) / Math.PI + 360) % 360
  return az.toFixed(0) + '°'
}

/** Jméno materiálu meshe; když ho nemá, spadne na jméno objektu. */
export function materialName(mesh: THREE.Mesh): string {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  return (mat?.name ?? '').trim() || objectName(mesh)
}

/** Jméno objektu; prázdné uzly se dohledají u rodiče, ať se nesloučí všechno do „model". */
export function objectName(mesh: THREE.Mesh): string {
  let o: THREE.Object3D | null = mesh
  while (o) {
    const n = (o.name ?? '').trim()
    if (n) return n
    o = o.parent
  }
  return 'model'
}

/** Prochází jen viditelné potomky — skryté objekty do řezu nepatří. */
function walkVisible(obj: THREE.Object3D, fn: (o: THREE.Object3D) => void) {
  if (!obj.visible) return
  fn(obj)
  for (const c of obj.children) walkVisible(c, fn)
}

const _p0 = new THREE.Vector3()
const _p1 = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _hit = new THREE.Vector3()
const _rel = new THREE.Vector3()
const _localPlane = new THREE.Plane()

const _instLocal = new THREE.Matrix4()
const _instWorld = new THREE.Matrix4()

/**
 * Projde všechny „kusy" objektu a ke každému dá jeho světovou matici.
 *
 * U `InstancedMesh` je to každá instance zvlášť — sloupky zábradlí nebo svodidla bývají
 * z exportu právě takhle, jedna geometrie a stovky matic. Kdybychom brali jen
 * `mesh.matrixWorld`, slily by se všechny instance do jedné a řez by je celé minul.
 */
export function forEachInstance(mesh: THREE.Mesh, fn: (matrix: THREE.Matrix4) => void) {
  const inst = mesh as THREE.InstancedMesh
  if (inst.isInstancedMesh) {
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, _instLocal)
      fn(_instWorld.multiplyMatrices(mesh.matrixWorld, _instLocal))
    }
    return
  }
  fn(mesh.matrixWorld)
}

/**
 * Protne jednu geometrii rovinou a nasype 2D úsečky (u0,v0,u1,v1) do `out`.
 * Vrací počet zpracovaných trojúhelníků.
 */
function sliceMesh(
  mesh: THREE.Mesh,
  mat: THREE.Matrix4,
  plane: THREE.Plane,
  eps: number,
  origin: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  out: number[],
): number {
  const geo = mesh.geometry as THREE.BufferGeometry | undefined
  const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!geo || !pos) return 0

  const idx = geo.getIndex()
  const count = idx ? idx.count : pos.count
  const P = [_p0, _p1, _p2]
  const d = [0, 0, 0]
  const xs: number[] = []
  let tris = 0

  const project = (p: THREE.Vector3) => {
    _rel.copy(p).sub(origin)
    xs.push(_rel.dot(u), _rel.dot(v))
  }

  /**
   * U velké geometrie se nejdřív zeptáme stromu obalů, kterých trojúhelníků se rovina vůbec
   * může týkat. U mostovky nebo terénu to je pár promile z celku; u drobných dílů se strom
   * nestaví a jede se postaru přes všechny.
   */
  const bvh = meshBvh(geo)
  const triangle = (t: number) => {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k
      P[k].fromBufferAttribute(pos, vi).applyMatrix4(mat)
      const dist = plane.distanceToPoint(P[k])
      d[k] = Math.abs(dist) < eps ? 0 : dist
    }
    tris++

    // celý trojúhelník na jedné straně → rovinu nepotkává
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) return
    // koplanární stěna by dala plochu, ne čáru — obrys stejně vznikne z okolních trojúhelníků
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return

    xs.length = 0
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3
      if (d[k] === 0) project(P[k])
      else if ((d[k] > 0 && d[k2] < 0) || (d[k] < 0 && d[k2] > 0)) {
        _hit.copy(P[k]).lerp(P[k2], d[k] / (d[k] - d[k2]))
        project(_hit)
      }
    }
    if (xs.length < 4) return

    // z víc než dvou průsečíků (vrchol na rovině + hrana) vezmeme dva různé
    const au = xs[0]
    const av = xs[1]
    let bu = NaN
    let bv = NaN
    for (let k = 2; k + 1 < xs.length; k += 2) {
      if (Math.hypot(xs[k] - au, xs[k + 1] - av) > eps) { bu = xs[k]; bv = xs[k + 1]; break }
    }
    if (Number.isNaN(bu)) return
    out.push(au, av, bu, bv)
  }

  if (bvh) {
    // strom je v lokální soustavě, tak se do ní převede i rovina
    trianglesNearPlane(bvh, planeToLocal(plane, mat, _localPlane), eps, triangle)
  } else {
    for (let t = 0; t * 3 + 2 < count; t++) triangle(t)
  }
  return tris
}

/** Svaření bodů na mřížce s ohledem na sousední buňky — hraniční případy nerozhodí řetězení. */
class PointWeld {
  private map = new Map<string, number[]>()
  readonly pts: Pt2[] = []
  private eps: number

  constructor(eps: number) { this.eps = eps }

  add(x: number, y: number): number {
    const cx = Math.round(x / this.eps)
    const cy = Math.round(y / this.eps)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.map.get((cx + dx) + ',' + (cy + dy))
        if (!bucket) continue
        for (const i of bucket) {
          const p = this.pts[i]
          if (Math.hypot(p[0] - x, p[1] - y) <= this.eps) return i
        }
      }
    }
    const id = this.pts.length
    this.pts.push([x, y])
    const key = cx + ',' + cy
    const bucket = this.map.get(key)
    if (bucket) bucket.push(id)
    else this.map.set(key, [id])
    return id
  }
}

/** Úsečky → polylinie. Nejdřív otevřené konce (uzly stupně 1), pak zbylé smyčky. */
function chainSegments(segs: number[], weldEps: number, srcOf?: number[]): { pts: Pt2[]; src: number }[] {
  const weld = new PointWeld(weldEps)
  const edges: [number, number][] = []
  const edgeSrc: number[] = []
  const seen = new Set<string>()

  for (let i = 0; i + 3 < segs.length; i += 4) {
    const a = weld.add(segs[i], segs[i + 1])
    const b = weld.add(segs[i + 2], segs[i + 3])
    if (a === b) continue
    const key = a < b ? a + '_' + b : b + '_' + a
    if (seen.has(key)) continue      // sdílenou hranu nahlásí oba sousední trojúhelníky
    seen.add(key)
    edges.push([a, b])
    edgeSrc.push(srcOf ? srcOf[i / 4] ?? -1 : -1)
  }

  const adj: [number, number][][] = weld.pts.map(() => [])   // [index hrany, druhý uzel]
  edges.forEach(([a, b], ei) => { adj[a].push([ei, b]); adj[b].push([ei, a]) })

  const used = new Set<number>()
  const chains: { path: number[]; src: number }[] = []

  const walk = (start: number) => {
    const path = [start]
    // Obrys může přejít z jednoho objektu na sousední; přiřadíme ho tomu, ze kterého
    // pochází většina hran — jinak by barva polylinie závisela na tom, kde řetězení začalo.
    const tally = new Map<number, number>()
    let cur = start
    let prev = -1
    for (;;) {
      const cands = adj[cur].filter(([ei]) => !used.has(ei))
      if (!cands.length) break
      /**
       * V uzlu, kde se sbíhá víc čar, se pokračuje CO NEJROVNĚJI.
       *
       * Dřív se brala první volná hrana, tedy náhodná — a obrys pak v místě, kde se potkávají
       * dva prvky, uhnul do toho druhého a vrátil se. Ve výkrese z toho byly nesmyslné
       * cikcaky přes nesouvisející kusy modelu.
       */
      let next = cands[0]
      if (cands.length > 1 && prev >= 0) {
        const px = weld.pts[cur][0] - weld.pts[prev][0]
        const py = weld.pts[cur][1] - weld.pts[prev][1]
        const pl = Math.hypot(px, py) || 1
        let bestDot = -Infinity
        for (const c of cands) {
          const qx = weld.pts[c[1]][0] - weld.pts[cur][0]
          const qy = weld.pts[c[1]][1] - weld.pts[cur][1]
          const dot = (px * qx + py * qy) / (pl * (Math.hypot(qx, qy) || 1))
          if (dot > bestDot) { bestDot = dot; next = c }
        }
      }
      used.add(next[0])
      const s = edgeSrc[next[0]]
      tally.set(s, (tally.get(s) ?? 0) + 1)
      prev = cur
      cur = next[1]
      path.push(cur)
      if (cur === start) break
    }
    if (path.length < 2) return
    let src = -1
    let best = 0
    for (const [s, n] of tally) if (n > best) { best = n; src = s }
    chains.push({ path, src })
  }

  for (let i = 0; i < adj.length; i++) if (adj[i].length === 1) walk(i)
  for (let i = 0; i < adj.length; i++) if (adj[i].some(([ei]) => !used.has(ei))) walk(i)

  return chains.map(c => ({ pts: c.path.map(i => weld.pts[i]), src: c.src }))
}

/** Vzdálenost bodu `b` od přímky `a`–`c`. */
function perpDist(a: Pt2, b: Pt2, c: Pt2): number {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const acx = c[0] - a[0]
  const acy = c[1] - a[1]
  const len = Math.hypot(acx, acy)
  return len < 1e-12 ? Math.hypot(abx, aby) : Math.abs(abx * acy - aby * acx) / len
}

/** Vyhodí body ležící (v rámci tolerance) na spojnici sousedů — kratší DXF i svižnější SVG. */
function simplify(pts: Pt2[], tol: number): Pt2[] {
  if (pts.length < 3) return pts
  const out: Pt2[] = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    if (perpDist(out[out.length - 1], pts[i], pts[i + 1]) > tol) out.push(pts[i])
  }
  out.push(pts[pts.length - 1])
  return out
}

/**
 * Zjednodušení uzavřeného obrysu. Řetězení začíná na náhodném vrcholu, takže ve švu často
 * zůstane zbytečný bod uprostřed hrany — `simplify` ho neuvidí, krajní body vždy nechává.
 */
function simplifyClosed(pts: Pt2[], tol: number): Pt2[] {
  let out = simplify(pts, tol)
  // Šev může vyjít na začátek i na konec — `simplify` krajní body nikdy nezahazuje.
  while (out.length > 3 && perpDist(out[out.length - 1], out[0], out[1]) <= tol) out = out.slice(1)
  while (out.length > 3 && perpDist(out[out.length - 2], out[out.length - 1], out[0]) <= tol) out = out.slice(0, -1)
  return out
}

function polyLength(pts: Pt2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return l
}

function shoelace(pts: Pt2[]): number {
  let s = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  }
  return s / 2
}

function pointInPoly(p: Pt2, pts: Pt2[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0]
    const yi = pts[i][1]
    const xj = pts[j][0]
    const yj = pts[j][1]
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export interface SliceOptions {
  /** tolerance zjednodušení obrysu; výchozí = úhlopříčka modelu × 1e-5 */
  simplifyTol?: number
  /** objekty, které se do řezu nepočítají (např. pomocné bubliny) */
  skip?: (o: THREE.Object3D) => boolean
  /** osa „vzhůru" pro orientaci výkresu; výchozí +Y (soustava prohlížeče), v mapě +Z */
  up?: THREE.Vector3
  /** čím obrys obarvit — výchozí je jméno materiálu, jinak jméno objektu */
  groupBy?: (mesh: THREE.Mesh) => string
  /**
   * Přibrat objekty, které rovina minula, ale leží v zadaném pásmu před ní nebo za ní
   * (sloupky zábradlí, svodidla mezi řezy). Každý takový objekt se řízne vlastní rovinou,
   * takže ve výkrese je celý průřez, ne odřený kraj.
   *
   * `radius` = souměrně ±r kolem roviny. `from`/`to` = znaménkový rozsah podél normály,
   * kterým se dá popsat pás mezi DVĚMA řezy (od 0 po vzdálenost toho druhého).
   */
  nearby?: { radius?: number; from?: number; to?: number }
  /**
   * Rozsah řezu — okno kolem `center` (ve světových souřadnicích), za které se obrys ořízne.
   * Bez něj jde řez skrz celý model. `halfU` je poloviční délka podél výkresu, `halfV` výšky.
   */
  clip?: { center: THREE.Vector3; halfU?: number; halfV?: number }
}

/** Parametr `t` na úsečce a→b, kde protne úsečku c→d; null = neprotínají se. */
function segCross(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number | null {
  const rx = b[0] - a[0], ry = b[1] - a[1]
  const sx = d[0] - c[0], sy = d[1] - c[1]
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-12) return null                 // rovnoběžné
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null
}

/** Leží bod uvnitř materiálu? Sudo-liché pravidlo přes uzavřené obrysy neořezaného řezu. */
function insideMaterial(p: Pt2, rings: Pt2[][]): boolean {
  let n = 0
  for (const r of rings) if (pointInPoly(p, r)) n++
  return n % 2 === 1
}

/**
 * Hrany okna rozsahu tam, kde skrz ně jde materiál.
 *
 * Bez toho by omezený řez uvnitř tělesa nedal vůbec nic (obrys tudy nevede), zatímco v mapě
 * je na stejném místě vidět říznutá plocha. Hrana se rozseká průsečíky s obrysem a nechají
 * se jen ty části, které leží v materiálu.
 */
function windowBorder(minX: number, maxX: number, minY: number, maxY: number, segs: number[], rings: Pt2[][]): number[] {
  if (!rings.length) return []                           // otevřená plocha (terén) nemá „uvnitř"
  const out: number[] = []
  const corners: Pt2[] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    const ts = [0, 1]
    for (let k = 0; k + 3 < segs.length; k += 4) {
      const t = segCross(a, b, [segs[k], segs[k + 1]], [segs[k + 2], segs[k + 3]])
      if (t !== null) ts.push(t)
    }
    ts.sort((x, y) => x - y)
    const at = (t: number): Pt2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] - ts[k - 1] < 1e-9) continue
      if (!insideMaterial(at((ts[k - 1] + ts[k]) / 2), rings)) continue
      const p0 = at(ts[k - 1])
      const p1 = at(ts[k])
      out.push(p0[0], p0[1], p1[0], p1[1])
    }
  }
  return out
}

/** Liang–Barsky: ořízne úsečku na obdélník. Vrací null, když je celá venku. */
function clipSegment(
  x0: number, y0: number, x1: number, y1: number,
  minX: number, maxX: number, minY: number, maxY: number,
): [number, number, number, number] | null {
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [[-dx, x0 - minX], [dx, maxX - x0], [-dy, y0 - minY], [dy, maxY - y0]]
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue }   // rovnoběžná s hranou a venku
    const r = q / p
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r }
    else { if (r < t0) return null; if (r < t1) t1 = r }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy]
}

/**
 * Hlavní vstup: kořen modelu + rovina ve světových souřadnicích → 2D obrys s rozměry.
 * Skryté objekty se přeskakují, takže řez odpovídá tomu, co je právě vidět.
 */
export function sliceObject(root: THREE.Object3D, plane: THREE.Plane, opts: SliceOptions = {}): SectionResult {
  const t0 = performance.now()
  const { u, v, n } = planeBasis(plane.normal, opts.up)

  const box = new THREE.Box3().setFromObject(root)
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
  const diag = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() || 1
  const origin = plane.projectPoint(center, new THREE.Vector3())

  const eps = Math.max(diag * 1e-7, 1e-9)
  const weldEps = Math.max(diag * 1e-6, 1e-7)
  /**
   * Zjednodušení nesmí být hrubší, než na jaké rozlišení vůbec rozeznáváme body.
   *
   * Dřív se počítalo z úhlopříčky modelu (× 1e-5), takže na 200 m dlouhém mostě vycházelo
   * na 2 mm — a tím se rozsypal každý tenkostěnný profil: svodidlo, zábradlí, plechy. Bod
   * na rohu 3mm plechu se od spojnice sousedů liší právě o tu tloušťku, takže ho zjednodušení
   * zahodilo a z profilu zbyl klikyhák. Rovné plochy se přitom vyčistí i s touhle tolerancí,
   * protože jejich body jsou kolineární až na přesnost float32.
   */
  const simplifyTol = opts.simplifyTol ?? weldEps

  const segs: number[] = []
  /** ke každé úsečce index do `sources` — díky tomu ví hotový obrys, odkud pochází */
  const srcOf: number[] = []
  const sources: { group: string; object: string }[] = []
  let meshCount = 0
  let triCount = 0

  /** objekty přibrané z okolí — vlastní rovina skrz střed, chainují se zvlášť */
  const near: { group: string; object: string; segs: number[]; d: number }[] = []
  const nearBox = new THREE.Box3()
  const nearCenter = new THREE.Vector3()
  const nearSize = new THREE.Vector3()
  const nearPlane = new THREE.Plane()
  const nearCut = new THREE.Vector3()

  // pásmo pro přibírání objektů, znaménkově podél normály roviny
  const nb = opts.nearby
  const nFrom = nb ? (nb.from ?? -(nb.radius ?? 0)) : 0
  const nTo = nb ? (nb.to ?? (nb.radius ?? 0)) : 0
  const nbOn = nTo > nFrom

  /**
   * Evidence objektů, ze kterých ve výkrese nic není. Zajímají jen ty v rozumném dosahu —
   * u modelu o stovkách metrů by jinak seznam zaplavilo všechno ostatní.
   */
  const missedMap = new Map<string, { object: string; group: string; gap: number; reason: string }>()
  const missedReach = Math.max((nTo - nFrom) * 2, 10)
  const noteMissed = (object: string, group: string, gap: number, reason: string) => {
    if (gap > missedReach || missedMap.size > 500) return
    const prev = missedMap.get(object)
    if (prev && prev.gap <= gap) return
    missedMap.set(object, { object, group, gap, reason })
  }

  root.updateWorldMatrix(true, true)
  walkVisible(root, o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    if (opts.skip?.(o)) return
    const geo = mesh.geometry as THREE.BufferGeometry | undefined
    if (!geo) return
    if (!geo.boundingBox) geo.computeBoundingBox()
    const bb = geo.boundingBox
    if (!bb) return
    meshCount++
    const group = (opts.groupBy ?? materialName)(mesh)
    const object = objectName(mesh)

    forEachInstance(mesh, matrix => {
      nearBox.copy(bb).applyMatrix4(matrix)
      nearBox.getCenter(nearCenter)
      nearBox.getSize(nearSize).multiplyScalar(0.5)
      const d = plane.distanceToPoint(nearCenter)
      /**
       * Rozhoduje MEZERA k nejbližšímu místu objektu, ne vzdálenost jeho středu.
       *
       * Dlouhé svodidlo nebo římsa mají střed klidně desítky metrů daleko, i když k rovině
       * sahají na půl metru — podle středu by tedy vypadly, ačkoliv do řezu evidentně patří.
       */
      const halfAlongN = Math.abs(plane.normal.x) * nearSize.x
        + Math.abs(plane.normal.y) * nearSize.y
        + Math.abs(plane.normal.z) * nearSize.z
      const gap = Math.abs(d) - halfAlongN

      // Obal rovinu protíná → normální řez. Když ne, ani nesaháme na trojúhelníky:
      // u modelu o stovkách objektů je tenhle předvýběr většina ušetřeného času.
      if (gap <= eps) {
        const before = segs.length
        triCount += sliceMesh(mesh, matrix, plane, eps, origin, u, v, segs)
        if (segs.length > before) {
          const si = sources.length
          sources.push({ group, object })
          for (let i = before; i + 3 < segs.length; i += 4) srcOf[i / 4] = si
          return
        }
      }

      /**
       * Rovina objekt minula. Leží-li v pásmu, řízneme ho vlastní rovinou — jinak by
       * z výkresu vypadl sloupek zábradlí jen proto, že řez padl zrovna mezi dva.
       * Rovina se vede místem objektu, které do pásma spadá, ne slepě jeho středem.
       */
      const lo = d - halfAlongN
      const hi = d + halfAlongN
      if (nbOn && lo <= nTo && hi >= nFrom) {
        const dCut = Math.min(Math.max(d, Math.max(nFrom, lo)), Math.min(nTo, hi))
        nearCut.copy(plane.normal).multiplyScalar(dCut - d).add(nearCenter)
        nearPlane.setFromNormalAndCoplanarPoint(plane.normal, nearCut)
        const bucket: number[] = []
        sliceMesh(mesh, matrix, nearPlane, eps, origin, u, v, bucket)
        if (bucket.length) { near.push({ group, object, segs: bucket, d: dCut }); return }
        noteMissed(object, group, gap, 'rovina protne obal, ale ne geometrii')
        return
      }
      if (gap <= eps) { noteMissed(object, group, gap, 'rovina protne obal, ale ne geometrii'); return }
      // hlásí se vzdálenost k ROVINĚ, ne k okraji pásma — s ní se dá rovnou porovnat
      // nastavené okolí a vidět, o kolik ho zvednout
      noteMissed(object, group, gap, !nbOn
        ? 'mimo rovinu, okolí je vypnuté'
        : Math.abs(nFrom + nTo) < 1e-9
          ? 'dál než okolí ' + nTo.toFixed(1) + ' m'
          : 'mimo pás ' + nFrom.toFixed(1) + '…' + nTo.toFixed(1) + ' m')
    })
  })

  // Neořezaný obrys je potřeba vždycky — i když se rozsah omezuje, protože podle jeho
  // uzavřených smyček se pozná, kudy vede materiál.
  const rawAll = chainSegments(segs, weldEps, srcOf)

  let raw = rawAll
  /** okno rozsahu v souřadnicích výkresu; platí i pro objekty přibrané z okolí */
  let win: { minU: number; maxU: number; minV: number; maxV: number } | null = null
  if (opts.clip) {
    const rel = opts.clip.center.clone().sub(origin)
    const cu = rel.dot(u)
    const cv = rel.dot(v)
    // neomezený směr nahradíme rozsahem modelu, ať je okno konečné a hrany se daly spočítat
    let bu0 = Infinity, bu1 = -Infinity, bv0 = Infinity, bv1 = -Infinity
    for (const c of rawAll) for (const p of c.pts) {
      if (p[0] < bu0) bu0 = p[0]; if (p[0] > bu1) bu1 = p[0]
      if (p[1] < bv0) bv0 = p[1]; if (p[1] > bv1) bv1 = p[1]
    }
    const pad = Math.max(diag * 1e-3, 1e-6)
    const hu = opts.clip.halfU
    const hv = opts.clip.halfV
    const minU2 = hu === undefined ? bu0 - pad : cu - hu
    const maxU2 = hu === undefined ? bu1 + pad : cu + hu
    const minV2 = hv === undefined ? bv0 - pad : cv - hv
    const maxV2 = hv === undefined ? bv1 + pad : cv + hv
    win = { minU: minU2, maxU: maxU2, minV: minV2, maxV: maxV2 }

    const cut: number[] = []
    const cutSrc: number[] = []
    for (let i = 0; i + 3 < segs.length; i += 4) {
      const s = clipSegment(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], minU2, maxU2, minV2, maxV2)
      if (!s) continue
      cutSrc[cut.length / 4] = srcOf[i / 4]
      cut.push(s[0], s[1], s[2], s[3])
    }
    const rings = rawAll.filter(c => c.pts.length > 3
      && Math.hypot(c.pts[0][0] - c.pts[c.pts.length - 1][0], c.pts[0][1] - c.pts[c.pts.length - 1][1]) <= weldEps)
      .map(c => c.pts)
    const border = windowBorder(minU2, maxU2, minV2, maxV2, segs, rings)
    if (border.length) {
      const bi = sources.length
      sources.push({ group: 'ohraničení řezu', object: 'ohraničení řezu' })
      for (let i = 0; i + 3 < border.length; i += 4) {
        cutSrc[cut.length / 4] = bi
        cut.push(border[i], border[i + 1], border[i + 2], border[i + 3])
      }
    }
    raw = chainSegments(cut, weldEps, cutSrc)
  }

  const makePoly = (pts: Pt2[], group: string, object: string, nearby: boolean, depth: number): SectionPoly => {
    const last = pts[pts.length - 1]
    const closed = pts.length > 3 && Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) <= weldEps
    const body = closed ? pts.slice(0, -1) : pts
    const simple = closed ? simplifyClosed(body, simplifyTol) : simplify(body, simplifyTol)
    const ring = closed ? [...simple, simple[0]] : simple
    let pu0 = Infinity, pu1 = -Infinity, pv0 = Infinity, pv1 = -Infinity
    for (const p of ring) {
      if (p[0] < pu0) pu0 = p[0]; if (p[0] > pu1) pu1 = p[0]
      if (p[1] < pv0) pv0 = p[1]; if (p[1] > pv1) pv1 = p[1]
    }
    return {
      pts: ring,
      closed,
      length: polyLength(ring),
      area: closed ? Math.abs(shoelace(simple)) : 0,
      hole: false,
      depth,
      nearby,
      projected: false,
      hidden: false,
      viewDepth: 0,
      group,
      object,
      width: pu1 - pu0,
      height: pv1 - pv0,
    }
  }

  const polys: SectionPoly[] = raw
    .map(({ pts, src }) => makePoly(pts, sources[src]?.group ?? 'model', sources[src]?.object ?? 'model', false, 0))
    .filter(p => p.pts.length > 1)

  // objekty z okolí — každý se řetězí sám za sebe, leží na vlastní rovině
  let nearbyCount = 0
  for (const b of near) {
    let s = b.segs
    if (win) {
      const cut: number[] = []
      for (let i = 0; i + 3 < s.length; i += 4) {
        const c = clipSegment(s[i], s[i + 1], s[i + 2], s[i + 3], win.minU, win.maxU, win.minV, win.maxV)
        if (c) cut.push(c[0], c[1], c[2], c[3])
      }
      s = cut
    }
    if (!s.length) continue
    let added = 0
    for (const c of chainSegments(s, weldEps)) {
      const p = makePoly(c.pts, b.group, b.object, true, b.d)
      if (p.pts.length > 1) { polys.push(p); added++ }
    }
    if (added) nearbyCount++
  }

  // díra = obrys uvnitř lichého počtu jiných obrysů (even-odd). Objekty z okolí se do toho
  // nepletou — leží na jiné rovině, takže „uvnitř" u nich neznamená dutinu.
  const rings = polys.filter(p => p.closed && !p.nearby)
  for (const p of rings) {
    let depth = 0
    for (const q of rings) {
      if (q === p) continue
      if (pointInPoly(p.pts[0], q.pts)) depth++
    }
    p.hole = depth % 2 === 1
  }

  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  let cutLength = 0
  let area = 0
  for (const p of polys) {
    // obálka výkresu roste přes všechno vykreslené, čísla řezu jen z vlastní roviny
    if (!p.nearby) {
      cutLength += p.length
      if (p.closed) area += p.hole ? -p.area : p.area
    }
    for (const pt of p.pts) {
      if (pt[0] < minU) minU = pt[0]
      if (pt[0] > maxU) maxU = pt[0]
      if (pt[1] < minV) minV = pt[1]
      if (pt[1] > maxV) maxV = pt[1]
    }
  }
  if (!polys.length) { minU = 0; maxU = 0; minV = 0; maxV = 0 }

  // objekt, ze kterého ve výkrese něco je, se mezi chybějící nehlásí — u instancí se
  // část kusů řízne a část ne, a to není důvod hlásit celý objekt jako chybějící
  const drawnObjects = new Set(polys.map(p => p.object))

  return {
    polys,
    minU, maxU, minV, maxV,
    width: maxU - minU,
    height: maxV - minV,
    cutLength,
    area: Math.max(0, area),
    loops: polys.filter(p => p.closed && !p.nearby).length,
    opens: polys.filter(p => !p.closed && !p.nearby).length,
    nearbyCount,
    missed: [...missedMap.values()].filter(m => !drawnObjects.has(m.object)).sort((a, b) => a.gap - b.gap).slice(0, 40),
    origin, u, v, normal: n,
    uLabel: axisLabel(u),
    vLabel: axisLabel(v),
    meshCount,
    triCount,
    ms: performance.now() - t0,
  }
}

/**
 * Řez s tloušťkou — „hustý" řez, který ukáže i to, co leží kousek vedle roviny.
 *
 * Tenká rovina projde přesně jedním místem, takže zábradlí nebo sloupek pár centimetrů
 * stranou z výkresu úplně vypadne. Tohle proto proloží pásem několik rovnoběžných řezů:
 * prostřední je vlastní řez (plná čára, počítají se z něj rozměry i plocha), ostatní jdou
 * do výkresu jako slabý kontext.
 *
 * Plocha, délka čar ani počty obrysů se z kontextu NEPOČÍTAJÍ — jinak by přestaly odpovídat
 * tomu, kudy se doopravdy řízlo. Obálka výkresu (a tedy celkové kóty) se ale roztáhne přes
 * všechno vykreslené, ať kóta bracketuje to, co je vidět.
 */
export function sliceSlab(
  root: THREE.Object3D,
  /** souměrná tloušťka kolem roviny, nebo znaménkový rozsah `{from, to}` pro jednostranný výřez */
  thickness: number | { from: number; to: number },
  plane: THREE.Plane,
  opts: SliceOptions & { samples?: number } = {},
): SectionResult {
  const from = typeof thickness === 'number' ? -thickness / 2 : Math.min(thickness.from, thickness.to)
  const to = typeof thickness === 'number' ? thickness / 2 : Math.max(thickness.from, thickness.to)
  const span = to - from

  /**
   * Prokládání samo nestačí: příčník tlustý 20 cm padne mezi vzorky vzdálené 28 cm a ve
   * výkrese by chyběl. Rozsah výřezu se proto rovnou použije i jako pásmo pro přibírání
   * celých objektů — teprve obojí dohromady dá úplný pohled do výřezu.
   */
  const mainOpts: SliceOptions = span > 0 && !opts.nearby ? { ...opts, nearby: { from, to } } : opts
  const main = sliceObject(root, plane, mainOpts)
  if (!(span > 0)) return main

  // krok ~25 cm, strop na 15 rovin — víc už jen zahušťuje čáry, ne informaci
  const n = Math.max(3, Math.min(15, Math.round(span / 0.25)))
  const t0 = performance.now()
  // objekty z okolí řeší hlavní rovina; na posunutých by se jen zduplikovaly
  const slabOpts: SliceOptions = { ...opts, nearby: undefined }

  const polys = [...main.polys]
  let minU = main.minU, maxU = main.maxU, minV = main.minV, maxV = main.maxV
  const offPlane = new THREE.Plane()

  for (let i = 0; i < n; i++) {
    const d = from + (span * i) / (n - 1)
    if (Math.abs(d) < 1e-9) continue                        // prostřední rovina už je hotová
    offPlane.copy(plane)
    offPlane.constant -= d                                   // posun po normále
    const s = sliceObject(root, offPlane, slabOpts)
    for (const p of s.polys) {
      polys.push({ ...p, depth: d })
      for (const pt of p.pts) {
        if (pt[0] < minU) minU = pt[0]
        if (pt[0] > maxU) maxU = pt[0]
        if (pt[1] < minV) minV = pt[1]
        if (pt[1] > maxV) maxV = pt[1]
      }
    }
  }

  return {
    ...main,
    polys,
    minU, maxU, minV, maxV,
    width: maxU - minU,
    height: maxV - minV,
    ms: main.ms + (performance.now() - t0),
  }
}

/**
 * Z 2D úseček (u0,v0,u1,v1) udělá obrysy — použité na promítnuté hrany pohledu.
 *
 * Kolineární navazující úsečky se spojí do jedné polylinie, takže dlouhá hrana nosníku vyjde
 * jako JEDNA čára s jednou délkou a jedním sklonem, ne jako pilník kousků po trojúhelnících.
 */
export function polysFromSegments(
  segs: number[],
  opts: {
    scale?: number
    group?: string
    object?: string
    simplifyTol?: number
    hidden?: boolean
    /**
     * Zahodit obrysy menší než tohle (obálka).
     *
     * Posuzuje se až HOTOVÝ OBRYS, ne jednotlivé úsečky. Krátká úsečka totiž sama o sobě
     * nic neznamená: buď je to smetí z tesselace a zůstane osamocená, nebo je to hrana
     * lampy a naváže se na metrovou. Filtrovat po úsečkách utrhalo drobným prvkům půlku
     * hran a zbyly z nich cáry.
     */
    minSize?: number
    /** vzdálenost každé úsečky od roviny řezu (m), jedno číslo na úsečku */
    depths?: number[]
  } = {},
): SectionPoly[] {
  const diag = opts.scale && opts.scale > 0 ? opts.scale : 100
  const weldEps = Math.max(diag * 1e-6, 1e-7)
  const tol = opts.simplifyTol ?? weldEps
  const group = opts.group ?? 'pohled'
  const object = opts.object ?? 'pohled'
  const hidden = !!opts.hidden
  const minSize = opts.minSize ?? 0
  const depths = opts.depths

  const out: SectionPoly[] = []
  // `srcOf` nese pořadí úsečky, takže hotový obrys ví, ze které hloubky převážně pochází
  const srcOf = depths ? depths.map((_, i) => i) : undefined
  for (const { pts, src } of chainSegments(segs, weldEps, srcOf)) {
    const viewDepth = depths && src >= 0 ? depths[src] ?? 0 : 0
    const last = pts[pts.length - 1]
    const closed = pts.length > 3 && Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) <= weldEps
    const body = closed ? pts.slice(0, -1) : pts
    const simple = closed ? simplifyClosed(body, tol) : simplify(body, tol)
    const ring = closed ? [...simple, simple[0]] : simple
    if (ring.length < 2) continue
    let pu0 = Infinity, pu1 = -Infinity, pv0 = Infinity, pv1 = -Infinity
    for (const p of ring) {
      if (p[0] < pu0) pu0 = p[0]; if (p[0] > pu1) pu1 = p[0]
      if (p[1] < pv0) pv0 = p[1]; if (p[1] > pv1) pv1 = p[1]
    }
    if (minSize > 0 && Math.max(pu1 - pu0, pv1 - pv0) < minSize) continue
    out.push({
      pts: ring,
      closed,
      length: polyLength(ring),
      area: 0,                       // pohled leží mimo rovinu, plocha by nedávala smysl
      hole: false,
      depth: 0,
      nearby: false,
      projected: true,
      hidden,
      viewDepth,
      group,
      object,
      width: pu1 - pu0,
      height: pv1 - pv0,
    })
  }
  return out
}

/** 2D bod výkresu zpět do světových souřadnic modelu. */
export function toWorld(r: SectionResult, p: Pt2): THREE.Vector3 {
  return r.origin.clone().addScaledVector(r.u, p[0]).addScaledVector(r.v, p[1])
}

/**
 * Hladina v DXF podle materiálu. Diakritika a mezery se převedou — CADy si na jména hladin
 * potrpí a rozbité jméno se špatně hledá.
 */
function dxfLayer(p: SectionPoly): string {
  const base = p.group
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .toUpperCase()
  if (!base) return p.closed ? 'RIZ' : 'RIZ_OTEVRENE'
  return 'RIZ_' + base
}

/** hladina obrysu podle jeho druhu */
function layerOf(p: SectionPoly): string {
  if (p.projected) return p.hidden ? 'RIZ_POHLED_SKRYTY' : 'RIZ_POHLED'
  if (p.nearby) return dxfLayer(p) + '_OKOLI'
  if (p.depth !== 0) return 'RIZ_KONTEXT'
  return dxfLayer(p)
}

/** barva hladiny podle indexu AutoCADu; materiály se probarvují, ostatní mají pevnou */
function layerColor(name: string, materialIndex: number): number {
  if (name === 'RIZ_POHLED') return 7
  if (name === 'RIZ_POHLED_SKRYTY') return 8
  if (name === 'RIZ_KONTEXT') return 8
  if (name === 'RIZ_SRAFY') return 9
  if (name === 'RIZ_KOTY') return 2
  if (name === 'RIZ_VYSKY') return 2
  if (name.endsWith('_OKOLI')) return 3
  return [1, 5, 4, 6, 30, 140, 210, 40][materialIndex % 8]
}

function layerLinetype(name: string): string {
  if (name === 'RIZ_POHLED_SKRYTY') return 'HIDDEN'
  if (name === 'RIZ_KONTEXT') return 'DASHED'
  return 'CONTINUOUS'
}

/**
 * Šrafy jako čáry, řádkovou metodou.
 *
 * Nativní entita `HATCH` existuje až od DXF R13 a tahá s sebou celou hlavu handlů a sekci
 * OBJECTS; R12 je proti tomu čitelný a otevře ho úplně všechno. Čáry se ořežou přímo do
 * obrysu pravidlem sudá/lichá, takže díry vyjdou samy — a kdo chce v CADu nativní šrafu,
 * hladinu `RIZ_SRAFY` prostě smaže a zašrafuje si po svém.
 */
function hatchLines(rings: SectionPoly[], angleDeg: number, spacing: number): number[] {
  const a = (angleDeg * Math.PI) / 180
  const cos = Math.cos(-a)
  const sin = Math.sin(-a)
  // do soustavy natočené o −úhel, kde jsou šrafy vodorovné
  const rot = (p: Pt2): Pt2 => [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos]
  const back = (x: number, y: number): Pt2 => [x * cos + y * sin, -x * sin + y * cos]

  const segs: [Pt2, Pt2][] = []
  let y0 = Infinity
  let y1 = -Infinity
  for (const p of rings) {
    const r = p.pts.map(rot)
    for (let i = 1; i < r.length; i++) {
      segs.push([r[i - 1], r[i]])
      if (r[i][1] < y0) y0 = r[i][1]
      if (r[i][1] > y1) y1 = r[i][1]
    }
  }
  if (!segs.length || !Number.isFinite(y0)) return []

  const out: number[] = []
  const xs: number[] = []
  const first = Math.ceil(y0 / spacing) * spacing
  for (let y = first; y <= y1; y += spacing) {
    xs.length = 0
    for (const [p, q] of segs) {
      const ay = p[1]
      const by = q[1]
      // půlotevřený interval, ať se vrchol na řádce nezapočítá dvakrát
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        xs.push(p[0] + ((q[0] - p[0]) * (y - ay)) / (by - ay))
      }
    }
    if (xs.length < 2) continue
    xs.sort((m, n) => m - n)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] < spacing * 0.15) continue      // moc úzký proužek nemá smysl
      const s = back(xs[i], y)
      const e = back(xs[i + 1], y)
      out.push(s[0], s[1], e[0], e[1])
    }
  }
  return out
}

export interface DxfOptions {
  /** vygenerovat šrafy řezných ploch jako čáry na hladině RIZ_SRAFY */
  hatch?: boolean
  /** kóty úseků jako text a čáry na hladině RIZ_KOTY (nejsou to asociativní kóty) */
  dims?: boolean
  /** výškové body odečtené ve výkrese, na hladinu RIZ_VYSKY */
  levels?: { p: Pt2; z: number }[]
}

/**
 * Výkres do DXF R12 (jednotky = metry, počátek = bod roviny řezu).
 *
 * Kromě obrysů nese i tabulku hladin: každá má barvu a typ čáry, takže zakrytý pohled je
 * čárkovaný a kontext z tloušťky taky — v CADu se to nemusí nastavovat ručně. Řezné plochy
 * můžou dostat šrafy a úseky kóty; obojí je na vlastní hladině, tedy na jedno kliknutí pryč.
 *
 * Schválně R12: je to nejlépe čitelný formát a projde úplně vším. Cenou je, že se nepoužívají
 * nativní entity `HATCH` a `DIMENSION` (obojí až od R13) — šrafy jsou čáry a kóty text s čarami.
 */
export function buildSectionDxf(r: SectionResult, opts: DxfOptions = {}): string {
  const polys = r.polys ?? []
  const L: (string | number)[] = []
  const g = (code: number, val: string | number) => { L.push(code, val) }

  // ── co se bude kreslit ──────────────────────────────────────────────────────
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (const p of polys) for (const pt of p.pts) {
    if (pt[0] < minU) minU = pt[0]; if (pt[0] > maxU) maxU = pt[0]
    if (pt[1] < minV) minV = pt[1]; if (pt[1] > maxV) maxV = pt[1]
  }
  const span = Number.isFinite(minU) ? Math.max(maxU - minU, maxV - minV, 0.1) : 1
  const spacing = Math.min(0.5, Math.max(0.02, span / 120))
  const textH = Math.min(0.5, Math.max(0.02, span / 120))

  // šrafy po skupinách, ať mají různé materiály různý sklon
  const hatch: { layer: string; segs: number[] }[] = []
  if (opts.hatch) {
    const byGroup = new Map<string, SectionPoly[]>()
    for (const p of polys) {
      if (!p.closed || p.projected || p.nearby || p.depth !== 0) continue
      const list = byGroup.get(p.group)
      if (list) list.push(p); else byGroup.set(p.group, [p])
    }
    let i = 0
    for (const [, rings] of byGroup) {
      const segs = hatchLines(rings, i % 2 ? -45 : 45, spacing * (1 + (i % 3) * 0.5))
      if (segs.length) hatch.push({ layer: 'RIZ_SRAFY', segs })
      i++
    }
  }

  // ── tabulka hladin ──────────────────────────────────────────────────────────
  const layers: string[] = []
  const addLayer = (n: string) => { if (!layers.includes(n)) layers.push(n) }
  for (const p of polys) addLayer(layerOf(p))
  if (hatch.length) addLayer('RIZ_SRAFY')
  if (opts.dims) addLayer('RIZ_KOTY')
  if (opts.levels?.length) addLayer('RIZ_VYSKY')
  if (!layers.length) addLayer('RIZ')

  const materials = layers.filter(n => n.startsWith('RIZ_') && !n.endsWith('_OKOLI')
    && !['RIZ_POHLED', 'RIZ_POHLED_SKRYTY', 'RIZ_KONTEXT', 'RIZ_SRAFY', 'RIZ_KOTY', 'RIZ_VYSKY'].includes(n))

  g(0, 'SECTION'); g(2, 'HEADER')
  g(9, '$ACADVER'); g(1, 'AC1009')
  g(0, 'ENDSEC')

  g(0, 'SECTION'); g(2, 'TABLES')
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 3)
  const ltype = (name: string, descr: string, total: number, dashes: number[]) => {
    g(0, 'LTYPE'); g(2, name); g(70, 0); g(3, descr); g(72, 65); g(73, dashes.length); g(40, total)
    for (const d of dashes) g(49, d)
  }
  ltype('CONTINUOUS', 'Solid line', 0, [])
  ltype('HIDDEN', '__ __ __ __', 0.15, [0.1, -0.05])
  ltype('DASHED', '__ __ __', 0.3, [0.2, -0.1])
  g(0, 'ENDTAB')

  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length)
  for (const name of layers) {
    g(0, 'LAYER'); g(2, name); g(70, 0)
    g(62, layerColor(name, materials.indexOf(name)))
    g(6, layerLinetype(name))
  }
  g(0, 'ENDTAB')
  g(0, 'ENDSEC')

  // ── kresba ──────────────────────────────────────────────────────────────────
  g(0, 'SECTION'); g(2, 'ENTITIES')

  for (const h of hatch) {
    for (let i = 0; i + 3 < h.segs.length; i += 4) {
      g(0, 'LINE'); g(8, h.layer)
      g(10, h.segs[i].toFixed(4)); g(20, h.segs[i + 1].toFixed(4)); g(30, '0.0')
      g(11, h.segs[i + 2].toFixed(4)); g(21, h.segs[i + 3].toFixed(4)); g(31, '0.0')
    }
  }

  for (const p of polys) {
    const layer = layerOf(p)
    const pts = p.closed ? p.pts.slice(0, -1) : p.pts
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(70, p.closed ? 1 : 0)
    for (const pt of pts) {
      g(0, 'VERTEX'); g(8, layer)
      g(10, pt[0].toFixed(4)); g(20, pt[1].toFixed(4)); g(30, '0.0')
    }
    g(0, 'SEQEND')
  }

  if (opts.dims) {
    let n = 0
    for (const p of polys) {
      if (p.hidden || (p.depth !== 0 && !p.nearby && !p.projected)) continue
      for (const s of polySegments(p)) {
        if (n >= 300) break
        if (s.length < textH * 8) continue                   // kratší úsek popisek neunese
        n++
        const mx = (s.a[0] + s.b[0]) / 2
        const my = (s.a[1] + s.b[1]) / 2
        g(0, 'TEXT'); g(8, 'RIZ_KOTY')
        g(10, mx.toFixed(4)); g(20, (my + textH * 0.4).toFixed(4)); g(30, '0.0')
        g(40, textH.toFixed(4))
        g(1, fmtLen(s.length) + ' / ' + s.angle.toFixed(1) + '°')
        g(50, s.angle.toFixed(2))
        g(72, 1); g(11, mx.toFixed(4)); g(21, (my + textH * 0.4).toFixed(4)); g(31, '0.0')
      }
    }
  }

  for (const lv of opts.levels ?? []) {
    const [x, y] = lv.p
    const h = textH * 1.6
    // trojúhelníček špičkou do bodu, nad ním výška
    const tri: [number, number][] = [[x, y], [x - h * 0.45, y + h], [x + h * 0.45, y + h], [x, y]]
    for (let i = 1; i < tri.length; i++) {
      g(0, 'LINE'); g(8, 'RIZ_VYSKY')
      g(10, tri[i - 1][0].toFixed(4)); g(20, tri[i - 1][1].toFixed(4)); g(30, '0.0')
      g(11, tri[i][0].toFixed(4)); g(21, tri[i][1].toFixed(4)); g(31, '0.0')
    }
    g(0, 'TEXT'); g(8, 'RIZ_VYSKY')
    g(10, x.toFixed(4)); g(20, (y + h * 1.3).toFixed(4)); g(30, '0.0')
    g(40, textH.toFixed(4))
    g(1, lv.z.toFixed(3))
    g(72, 1); g(11, x.toFixed(4)); g(21, (y + h * 1.3).toFixed(4)); g(31, '0.0')
  }

  g(0, 'ENDSEC'); g(0, 'EOF')
  return L.join('\n')
}

/**
 * Výsledek jen z vybraných obrysů — s dopočítanými rozměry, plochou i délkou čar.
 *
 * Když se ve výkrese vypne vrstva, nesmí se to projevit jen na obrazovce: papír se centruje
 * na obálku a razítko nese plochu a délku řezných čar. Kdyby se předával původní výsledek,
 * export by popisoval něco jiného, než je vidět.
 */
export function filterResult(r: SectionResult, keep: (p: SectionPoly) => boolean): SectionResult {
  const polys = r.polys.filter(keep)
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  let area = 0
  let cutLength = 0
  let loops = 0
  let opens = 0
  for (const p of polys) {
    for (const pt of p.pts) {
      if (pt[0] < minU) minU = pt[0]; if (pt[0] > maxU) maxU = pt[0]
      if (pt[1] < minV) minV = pt[1]; if (pt[1] > maxV) maxV = pt[1]
    }
    if (p.projected || p.depth !== 0) continue
    cutLength += p.length
    if (p.closed) { loops++; area += p.hole ? -p.area : p.area } else opens++
  }
  if (!polys.length) { minU = 0; maxU = 0; minV = 0; maxV = 0 }
  return {
    ...r,
    polys,
    minU, maxU, minV, maxV,
    width: maxU - minU,
    height: maxV - minV,
    area: Math.max(0, area),
    cutLength,
    loops,
    opens,
    nearbyCount: polys.filter(p => p.nearby).length,
  }
}

/** Metry na čitelný popisek — pod metr v centimetrech, jinak metry na milimetr. */
export function fmtLen(m: number): string {
  if (!Number.isFinite(m)) return '—'
  return Math.abs(m) < 1 ? (m * 100).toFixed(1) + ' cm' : m.toFixed(3) + ' m'
}
