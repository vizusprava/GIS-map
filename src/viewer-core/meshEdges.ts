/**
 * Hrany geometrie pro kreslení pohledu — a hlavně SILUETY.
 *
 * `THREE.EdgesGeometry` umí jen zlomy: hrany, kde se dvě stěny potkají pod větším úhlem než
 * zadaným. To je ale jen část toho, co na výkrese vidíš. Kulatý pilíř, kabel, trubka ani
 * zaoblená římsa ostrou hranu nemají — a přesto mají obrys. Ten obrys je SILUETA a je
 * závislý na směru pohledu: leží tam, kde se plocha odklání od pozorovatele, tedy kde mají
 * sousední stěny opačné znaménko `dot(normála, směr pohledu)`.
 *
 * Proto se tady místo hotových úseček drží ke každé hraně i normály obou sousedních stěn.
 * Sousednost se spočítá jednou (je to to drahé), a pak je výběr hran pro konkrétní pohled
 * jeden test znaménka na hranu.
 *
 * Kreslí se tři druhy hran:
 *   - OKRAJ  — hrana jen s jednou stěnou; otevřené skořepiny (a těch je v exportech spousta)
 *              by se jinak spoléhaly na náhodu úhlu
 *   - ZLOM   — ostrá hrana, nezávislá na pohledu (to, co uměla `EdgesGeometry`)
 *   - SILUETA — závisí na pohledu, dopočítá se při každém překreslení
 */
import * as THREE from 'three'

export interface EdgeSet {
  /** koncové body hran v lokální soustavě geometrie, 6 čísel na hranu */
  pos: Float32Array
  /** normály obou sousedních stěn, 6 čísel na hranu; u okraje jsou obě stejné */
  nrm: Float32Array
  /** 1 = kreslit vždy (okraj nebo zlom), 0 = jen když z tohohle pohledu vyjde silueta */
  always: Uint8Array
  count: number
}

/** cache podle geometrie a úhlu zlomu — sousednost se počítá jednou za model */
const cache = new WeakMap<THREE.BufferGeometry, Map<number, EdgeSet>>()

/**
 * Hrany geometrie se sousedností stěn. Výsledek se drží u geometrie, takže se při
 * překreslování pohledu nepočítá znovu.
 */
export function meshEdges(geo: THREE.BufferGeometry, creaseDeg = 25): EdgeSet {
  let byAngle = cache.get(geo)
  if (!byAngle) { byAngle = new Map(); cache.set(geo, byAngle) }
  const hit = byAngle.get(creaseDeg)
  if (hit) return hit
  const built = buildEdges(geo, creaseDeg)
  byAngle.set(creaseDeg, built)
  return built
}

const EMPTY: EdgeSet = { pos: new Float32Array(0), nrm: new Float32Array(0), always: new Uint8Array(0), count: 0 }

function buildEdges(geo: THREE.BufferGeometry, creaseDeg: number): EdgeSet {
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!posAttr || posAttr.count < 3) return EMPTY
  const index = geo.getIndex()
  const triCount = (index ? index.count : posAttr.count) / 3
  if (triCount < 1) return EMPTY

  /**
   * Svaření vrcholů. Exporty (a hlavně glTF) mají vrcholy rozkopírované kvůli normálám
   * a UV, takže bez svaření by KAŽDÁ hrana vyšla jako okraj a sousednost by nevznikla.
   */
  if (!geo.boundingBox) geo.computeBoundingBox()
  const size = geo.boundingBox ? geo.boundingBox.getSize(new THREE.Vector3()).length() : 1
  const eps = Math.max((size || 1) * 1e-6, 1e-7)
  const weld = new Map<string, number>()
  const wx: number[] = []
  const wy: number[] = []
  const wz: number[] = []
  const idOf = (vi: number): number => {
    const x = posAttr.getX(vi)
    const y = posAttr.getY(vi)
    const z = posAttr.getZ(vi)
    const key = Math.round(x / eps) + ',' + Math.round(y / eps) + ',' + Math.round(z / eps)
    const had = weld.get(key)
    if (had !== undefined) return had
    const id = wx.length
    wx.push(x); wy.push(y); wz.push(z)
    weld.set(key, id)
    return id
  }

  // hrana → pořadové číslo; klíč je dvojice svařených vrcholů složená do jednoho čísla
  const edgeOf = new Map<number, number>()
  const ea: number[] = []
  const eb: number[] = []
  const n1x: number[] = [], n1y: number[] = [], n1z: number[] = []
  const n2x: number[] = [], n2y: number[] = [], n2z: number[] = []
  const twoFaces: boolean[] = []

  const A = new THREE.Vector3()
  const B = new THREE.Vector3()
  const C = new THREE.Vector3()
  const AB = new THREE.Vector3()
  const AC = new THREE.Vector3()
  const N = new THREE.Vector3()

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
    const a = idOf(i0)
    const b = idOf(i1)
    const c = idOf(i2)
    if (a === b || b === c || a === c) continue                 // zdegenerovaný trojúhelník

    A.set(wx[a], wy[a], wz[a])
    B.set(wx[b], wy[b], wz[b])
    C.set(wx[c], wy[c], wz[c])
    AB.subVectors(B, A)
    AC.subVectors(C, A)
    N.crossVectors(AB, AC)
    if (N.lengthSq() < 1e-24) continue
    N.normalize()

    const pairs: [number, number][] = [[a, b], [b, c], [c, a]]
    for (const [p, q] of pairs) {
      const lo = p < q ? p : q
      const hi = p < q ? q : p
      const key = lo * 67108864 + hi                            // 2^26 vrcholů bohatě stačí
      let e = edgeOf.get(key)
      if (e === undefined) {
        e = ea.length
        edgeOf.set(key, e)
        ea.push(lo); eb.push(hi)
        n1x.push(N.x); n1y.push(N.y); n1z.push(N.z)
        n2x.push(N.x); n2y.push(N.y); n2z.push(N.z)
        twoFaces.push(false)
      } else if (!twoFaces[e]) {
        n2x[e] = N.x; n2y[e] = N.y; n2z[e] = N.z
        twoFaces[e] = true
      }
      // hrana u víc než dvou stěn (nečistá geometrie): bereme první dvě, na obrys to stačí
    }
  }

  const count = ea.length
  const pos = new Float32Array(count * 6)
  const nrm = new Float32Array(count * 6)
  const always = new Uint8Array(count)
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180)
  for (let e = 0; e < count; e++) {
    const o = e * 6
    const a = ea[e], b = eb[e]
    pos[o] = wx[a]; pos[o + 1] = wy[a]; pos[o + 2] = wz[a]
    pos[o + 3] = wx[b]; pos[o + 4] = wy[b]; pos[o + 5] = wz[b]
    nrm[o] = n1x[e]; nrm[o + 1] = n1y[e]; nrm[o + 2] = n1z[e]
    nrm[o + 3] = n2x[e]; nrm[o + 4] = n2y[e]; nrm[o + 5] = n2z[e]
    const dot = n1x[e] * n2x[e] + n1y[e] * n2y[e] + n1z[e] * n2z[e]
    always[e] = !twoFaces[e] || dot < cosCrease ? 1 : 0
  }
  return { pos, nrm, always, count }
}

/** nejmenší zlom mezi stěnami, aby hrana mohla být siluetou (stupně) */
export const MIN_CURVE_DEG = 3

/**
 * Je hrana z tohohle směru silueta? Sousední stěny musí ležet každá na jiné straně —
 * jedna k pozorovateli, druhá od něj.
 *
 * Nestačí ale samotné znaménko. Plochá, hustě trojúhelníkovaná plocha viděná skoro zboku
 * (mostovka v podélném pohledu je přesně ten případ) má normály téměř kolmé na pohled, takže
 * skalární součin je kolem nuly a jeho znaménko se mezi sousedními trojúhelníky převrací
 * náhodně — a „siluetou" se prohlásí skoro každá vnitřní hrana. Výkres z toho byl drátěný
 * chuchvalec. Proto musí být mezi stěnami i skutečný zlom: rovina siluetu uvnitř sebe nemá,
 * ta leží na jejím okraji, a ten se kreslí tak jako tak.
 *
 * `dir` je směr pohledu v LOKÁLNÍ soustavě geometrie; převede ho `viewDirLocal`.
 */
export function isSilhouette(
  set: EdgeSet,
  e: number,
  dx: number,
  dy: number,
  dz: number,
  minCurveDeg = MIN_CURVE_DEG,
): boolean {
  const o = e * 6
  const n1x = set.nrm[o], n1y = set.nrm[o + 1], n1z = set.nrm[o + 2]
  const n2x = set.nrm[o + 3], n2y = set.nrm[o + 4], n2z = set.nrm[o + 5]
  if (n1x * n2x + n1y * n2y + n1z * n2z > Math.cos((minCurveDeg * Math.PI) / 180)) return false
  const d1 = n1x * dx + n1y * dy + n1z * dz
  const d2 = n2x * dx + n2y * dy + n2z * dz
  return d1 > 0 !== d2 > 0
}

/**
 * Směr pohledu přepočtený do lokální soustavy objektu.
 *
 * Normály se do světa přenášejí normálovou maticí (transponovaná inverzní), takže
 * `dot(normálováMatice · N, d)` je totéž co `dot(N, inverzeM3 · d)`. Stačí tedy jednou za
 * objekt otočit směr pohledu — a pak už se počítají jen skalární součiny v lokálu.
 * Na znaménko nezáleží na délce, takže se nic nenormalizuje.
 */
export function viewDirLocal(matrixWorld: THREE.Matrix4, dirWorld: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const m3 = new THREE.Matrix3().setFromMatrix4(matrixWorld).invert()
  return out.copy(dirWorld).applyMatrix3(m3)
}

export interface MergeOptions {
  /** jak daleko od sebe smí být dvě čáry, aby se braly jako jedna (jednotky výkresu) */
  tol: number
  /**
   * Dovolený rozdíl hloubky. Přední a zadní madlo zábradlí se promítnou na TÚŽ čáru, ale
   * leží každé jinde — slít je nesmíme, jinak by se pak špatně určilo zakrytí.
   */
  depthTol: number
  /** dovolená odchylka směru ve stupních; jde o duplicity, tak stačí velmi těsná */
  angleTol?: number
}

/**
 * Sloučí promítnuté hrany ležící na téže přímce.
 *
 * Instancované zábradlí promítne táž hrana sloupku do skoro totožné čáry třeba stokrát.
 * Ve výkrese pak leží stovky čar přes sebe: čára vypadá tlustší, než má, DXF je zbytečně
 * velké a CAD s ním bojuje. Tady se čáry roztřídí podle nosné přímky, na ní se posbírají
 * intervaly a překryvy i navazující kousky se slijí do jedné dlouhé čáry.
 *
 * Vstup i výstup mají krok 6: u0, v0, hloubka0, u1, v1, hloubka1.
 */
export function mergeSegments(segs: ArrayLike<number>, opts: MergeOptions): number[] {
  const tol = opts.tol
  const depthTol = opts.depthTol
  const angRad = ((opts.angleTol ?? 0.05) * Math.PI) / 180

  type Line = { d: number; cos: number; sin: number; nx: number; ny: number; runs: number[][] }
  /**
   * Na jeden klíč může padnout víc různých přímek, takže se v koši drží SEZNAM.
   * Kdyby se ukládala jen jedna, druhá by tu první přepsala i s nasbíranými úseky —
   * a ty čáry by z výkresu beze stopy zmizely.
   */
  const buckets = new Map<string, Line[]>()
  const key = (ab: number, db: number) => ab + ':' + db

  for (let i = 0; i + 5 < segs.length; i += 6) {
    let u0 = segs[i], v0 = segs[i + 1], n0 = segs[i + 2]
    let u1 = segs[i + 3], v1 = segs[i + 4], n1 = segs[i + 5]
    const dx = u1 - u0
    const dy = v1 - v0
    if (Math.hypot(dx, dy) < 1e-9) continue

    // směr se srovná do půlkruhu, ať se čára a táž čára pozpátku potkají v jednom koši
    let a = Math.atan2(dy, dx)
    if (a < 0) a += Math.PI
    if (a >= Math.PI) a -= Math.PI
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const nx = -sin
    const ny = cos
    const d = nx * u0 + ny * v0

    const ab = Math.round(a / angRad)
    const db = Math.round(d / tol)
    /**
     * Rozhoduje KOLMÁ VZDÁLENOST OBOU KONCŮ od kandidátovy přímky, ne odsazení v počátku.
     *
     * Dvě čáry s téměř stejným sklonem (podélný nosník a mostovka se liší o setiny stupně)
     * se u počátku potkají, ale o sto metrů dál jsou od sebe centimetry. Dřív stačilo, že
     * si odpovídají v počátku — čára se pak promítla na cizí přímku a ve výkrese skončila
     * jinde, než ve skutečnosti je. Takhle je zaručeno, že se posun nikde nepřekročí `tol`.
     */
    let line: Line | undefined
    for (let da = -1; da <= 1 && !line; da++) {
      for (let dd = -1; dd <= 1 && !line; dd++) {
        for (const cand of buckets.get(key(ab + da, db + dd)) ?? []) {
          const e0 = Math.abs(cand.nx * u0 + cand.ny * v0 - cand.d)
          if (e0 > tol) continue
          const e1 = Math.abs(cand.nx * u1 + cand.ny * v1 - cand.d)
          if (e1 > tol) continue
          line = cand
          break
        }
      }
    }
    if (!line) {
      line = { d, cos, sin, nx, ny, runs: [] }
      const k = key(ab, db)
      const list = buckets.get(k)
      if (list) list.push(line); else buckets.set(k, [line])
    }

    let t0 = u0 * line.cos + v0 * line.sin
    let t1 = u1 * line.cos + v1 * line.sin
    if (t0 > t1) {
      ;[t0, t1] = [t1, t0]
      ;[n0, n1] = [n1, n0]
      ;[u0, u1] = [u1, u0]
      ;[v0, v1] = [v1, v0]
    }
    line.runs.push([t0, t1, n0, n1])
  }

  const out: number[] = []
  for (const list of buckets.values()) {
    for (const line of list) {
      line.runs.sort((p, q) => p[0] - q[0])
      let cur: number[] | null = null
      const flush = () => {
        if (!cur) return
        const bx = line.nx * line.d
        const by = line.ny * line.d
        out.push(
          bx + line.cos * cur[0], by + line.sin * cur[0], cur[2],
          bx + line.cos * cur[1], by + line.sin * cur[1], cur[3],
        )
        cur = null
      }
      for (const r of line.runs) {
        if (!cur) { cur = r.slice(); continue }
        // navazuje nebo se překrývá? a je to opravdu tentýž prvek, ne něco za ním?
        const span = cur[1] - cur[0]
        const at = span > 1e-9 ? cur[2] + ((cur[3] - cur[2]) * (r[0] - cur[0])) / span : cur[2]
        if (r[0] <= cur[1] + tol && Math.abs(at - r[2]) <= depthTol) {
          if (r[1] > cur[1]) { cur[1] = r[1]; cur[3] = r[3] }
          continue
        }
        flush()
        cur = r.slice()
      }
      flush()
    }
  }
  return out
}
