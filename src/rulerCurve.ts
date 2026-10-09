/**
 * Zaoblené měření: hladkým bodem (dvojklik na bod) čára neprojíždí rohem, ale obloukem.
 *
 * Každý úsek mezi dvěma body je kubická Bézierova křivka. V hladkém bodě leží její řídicí body
 * na tečně, která míří od předchozího bodu k následujícímu (jako Catmull-Rom), u rohového bodu
 * s ním splývají. Úsek mezi dvěma rohy tak zůstane přímý — a s ním i jeho délka. Délka řídicí
 * „páky" je třetina úseku, takže oblouk drží tvar i u nestejně dlouhých úseků.
 *
 * Krajní bod otevřené čáry nemá dva sousedy, hladký příznak na něm nic nedělá — ožije, až za
 * něj přibude další bod nebo se čára uzavře.
 *
 * Křivka se počítá v prostoru (ECEF), stejně jako přímé úseky: měření je 3D a oblouk plynule
 * přechází i ve výšce.
 */
import * as Cesium from 'cesium'

/** úseček na jeden zaoblený úsek — víc už není poznat v kresbě ani v délce (chyba pod 0,1 ‰) */
const STEPS = 32

const C3 = Cesium.Cartesian3

/** Jednotková tečna v hladkém bodě (od předchozího k následujícímu), u rohu null. */
function tangent(c: readonly Cesium.Cartesian3[], i: number, smooth: ReadonlySet<number>, loop: boolean): Cesium.Cartesian3 | null {
  const n = c.length
  if (!smooth.has(i) || n < 3) return null
  const prev = i > 0 ? c[i - 1] : loop ? c[n - 1] : null
  const next = i < n - 1 ? c[i + 1] : loop ? c[0] : null
  if (!prev || !next) return null
  const d = C3.subtract(next, prev, new C3())
  const m = C3.magnitude(d)
  return m > 1e-9 ? C3.divideByScalar(d, m, d) : null
}

/**
 * Body jednotlivých úseků (každý i s oběma krajními body). Přímý úsek je jen `[a, b]`.
 * Otevřená čára má úseků o jeden méně než bodů, uzavřená (`loop`) stejně — poslední vede
 * zpátky do prvního bodu.
 */
export function curveSegments(c: readonly Cesium.Cartesian3[], smooth: ReadonlySet<number>, loop: boolean): Cesium.Cartesian3[][] {
  const n = c.length
  const count = loop ? n : n - 1
  const dir = c.map((_, i) => tangent(c, i, smooth, loop))
  const out: Cesium.Cartesian3[][] = []
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n
    const a = c[i], b = c[j], da = dir[i], db = dir[j]
    if (!da && !db) { out.push([a, b]); continue }
    const lever = C3.distance(a, b) / 3
    const p1 = da ? C3.add(a, C3.multiplyByScalar(da, lever, new C3()), new C3()) : a
    const p2 = db ? C3.subtract(b, C3.multiplyByScalar(db, lever, new C3()), new C3()) : b
    const seg = [a]
    for (let k = 1; k < STEPS; k++) {
      const t = k / STEPS, u = 1 - t
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t
      seg.push(new C3(
        w0 * a.x + w1 * p1.x + w2 * p2.x + w3 * b.x,
        w0 * a.y + w1 * p1.y + w2 * p2.y + w3 * b.y,
        w0 * a.z + w1 * p1.z + w2 * p2.z + w3 * b.z,
      ))
    }
    seg.push(b)
    out.push(seg)
  }
  return out
}

/** délka úseku po křivce (m) */
export function segLength(seg: readonly Cesium.Cartesian3[]): number {
  let len = 0
  for (let k = 1; k < seg.length; k++) len += C3.distance(seg[k - 1], seg[k])
  return len
}

/** bod v polovině délky úseku — na oblouku kóta sedí na křivce, ne na tětivě */
export function segMid(seg: readonly Cesium.Cartesian3[]): Cesium.Cartesian3 {
  if (seg.length === 2) return C3.midpoint(seg[0], seg[1], new C3())
  const half = segLength(seg) / 2
  let acc = 0
  for (let k = 1; k < seg.length; k++) {
    const d = C3.distance(seg[k - 1], seg[k])
    if (acc + d >= half && d > 0) return C3.lerp(seg[k - 1], seg[k], (half - acc) / d, new C3())
    acc += d
  }
  return C3.clone(seg[seg.length - 1])
}

/** Úseky slepené do jedné čáry (společné body jen jednou). Uzavřená končí zase v prvním bodě. */
export function curvePath(segs: readonly Cesium.Cartesian3[][]): Cesium.Cartesian3[] {
  const out: Cesium.Cartesian3[] = []
  segs.forEach((s, i) => { for (let k = i ? 1 : 0; k < s.length; k++) out.push(s[k]) })
  return out
}
