/**
 * Minimapa v rohu: pohled shora (ortofoto nebo ZTM ČÚZK) s polohou kamery a výsečí terénu,
 * kterou kamera zrovna vidí. Hlavně pro šikmé pohledy — z 3D záběru se špatně pozná, odkud
 * se vlastně koukáš, a u uloženého pohledu kamery to člověk chce vědět přesně.
 *
 * Schválně to NENÍ druhé Cesium: další WebGL kontext by na integrované grafice ubral mapě
 * snímky. Je to pár obrázků dlaždic z cache ČÚZK (stejné služby jako podklad, prohlížeč si je
 * drží v cache) a nad nimi SVG. Překresluje se jen při pohybu kamery, nejvýš ~20× za vteřinu.
 *
 * Měřítko se řídí samo: vždy se vejde kamera i celá výseč. Vzdálený okraj výseče se u pohledu
 * k obzoru ořízne (viz `reach`), jinak by se minimapa oddálila na celou republiku.
 * Klik do minimapy posune pohled tak, aby se díval na to místo — natočení i sklon zůstanou.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { X } from 'lucide-react'
import { ORTO_MAX_LEVEL, ZTM_MAX_LEVEL, orthoTileUrl, ztmTileUrl } from './imagery'
import { viewCenterGround } from './sceneUtils'

export type MiniBase = 'orto' | 'ztm'

const ON_KEY = 'geo.minimap', BASE_KEY = 'geo.minimapBase'
/** Zapnutí a podklad minimapy jsou předvolba počítače (jako detail ortofota), ne scény. */
export function readMinimap(): { on: boolean; base: MiniBase } {
  try { return { on: localStorage.getItem(ON_KEY) === '1', base: localStorage.getItem(BASE_KEY) === 'ztm' ? 'ztm' : 'orto' } }
  catch { return { on: false, base: 'orto' } }
}
export function saveMinimap(on: boolean, base: MiniBase): void {
  try { localStorage.setItem(ON_KEY, on ? '1' : '0'); localStorage.setItem(BASE_KEY, base) } catch { /* privátní režim */ }
}

// ── Web Mercator v jednotkách světa 0..1 (dlaždice úrovně z mají 256 px, svět 256·2^z) ──
const wx = (lon: number) => (lon + 180) / 360
const wy = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) }
const lonOf = (x: number) => x * 360 - 180
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
const DEG = 180 / Math.PI

type Pt = [number, number]
/** Co kamera vidí, v jednotkách světa: poloha, výseč (4 rohy obrazovky na zemi) a střed záběru. */
type Snap = { cam: Pt; poly: Pt[]; center: Pt; heading: number }
type View = { cx: number; cy: number; z: number }

/**
 * Výseč pohledu: kam na zem padnou paprsky z rohů obrazovky. Zem = elipsoid zvednutý na výšku
 * terénu pod kamerou (z načtených dlaždic) — levné a pro minimapu přesné dost. Paprsek nad
 * obzorem jde po zemi ve svém směru až na `reach`; dál se ořízne i ten, který zem trefí.
 */
function snapCamera(v: Cesium.Viewer): Snap | null {
  const scene = v.scene, cam = v.camera, canvas = scene.canvas
  const W = canvas.clientWidth, H = canvas.clientHeight
  if (!W || !H) return null
  const carto = cam.positionCartographic
  const g = scene.globe?.getHeight(carto)
  const h0 = g !== undefined && Number.isFinite(g) ? g : 0
  // dosah výseče: s výškou kamery roste, ale pohled k obzoru ji nesmí roztáhnout přes kraj
  const reach = Math.min(20_000, Math.max(250, Math.max(1, carto.height - h0) * 12))
  const ground = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, h0)
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(ground)
  const inv = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4())
  const ell = new Cesium.Ellipsoid(6378137 + h0, 6378137 + h0, 6356752.3142451793 + h0)
  const tmp = new Cesium.Cartesian3()
  const world = (e: number, n: number): Pt => {
    const p = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(e, n, 0), tmp)
    const c = Cesium.Cartographic.fromCartesian(p)
    return [wx(c.longitude * DEG), wy(c.latitude * DEG)]
  }
  const onGround = (sx: number, sy: number): Pt | null => {
    const ray = cam.getPickRay(new Cesium.Cartesian2(sx, sy))
    if (!ray) return null
    const t = Cesium.IntersectionTests.rayEllipsoid(ray, ell)
    let e: number, n: number
    if (t && t.start > 0) {
      const l = Cesium.Matrix4.multiplyByPoint(inv, Cesium.Ray.getPoint(ray, t.start, tmp), new Cesium.Cartesian3())
      e = l.x; n = l.y
    } else {
      // nad obzorem (nebo kamera pod zemí): jen směr po zemi
      const d = Cesium.Matrix4.multiplyByPointAsVector(inv, ray.direction, new Cesium.Cartesian3())
      const len = Math.hypot(d.x, d.y)
      if (len < 1e-9) return null
      e = (d.x / len) * reach; n = (d.y / len) * reach
    }
    const r = Math.hypot(e, n)
    if (r > reach) { e *= reach / r; n *= reach / r }
    return world(e, n)
  }
  // pořadí kolem dokola: levý dolní, pravý dolní, pravý horní, levý horní roh obrazovky
  const poly = [onGround(0, H), onGround(W, H), onGround(W, 0), onGround(0, 0)].filter((p): p is Pt => !!p)
  const center = onGround(W / 2, H / 2) ?? world(0, 0)
  return { cam: [wx(carto.longitude * DEG), wy(carto.latitude * DEG)], poly, center, heading: cam.heading }
}

/** Měřítko a střed tak, aby se vešla kamera i výseč (s okrajem `pad` px). */
function fitView(s: Snap, size: number, prev: View | null): View {
  const pts = [s.cam, s.center, ...s.poly]
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const pad = 22
  const span = Math.max(x1 - x0, y1 - y0, 1e-9)
  const fit = Math.min(18.5, Math.max(7, Math.log2((size - 2 * pad) / (256 * span))))
  // Měřítko se mění po půl úrovních a jen když je potřeba: při otáčení kamery na místě by
  // jinak minimapa neustále pulzovala.
  let z = prev?.z ?? Math.floor(fit * 2) / 2
  if (z > fit || fit - z > 0.75) z = Math.floor(fit * 2) / 2
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, z }
}

/** Posune kameru tak, aby se dívala na bod (lon, lat) — stejná výška nad zemí, natočení i sklon. */
function lookAt(v: Cesium.Viewer, lon: number, lat: number) {
  const cam = v.camera
  const c0 = viewCenterGround(v)
  const from = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(c0.lon, c0.lat, c0.height))
  // kamera vůči bodu, na který se teď dívá, v jeho místním rámci…
  const off = Cesium.Matrix4.multiplyByPoint(Cesium.Matrix4.inverseTransformation(from, new Cesium.Matrix4()), cam.positionWC, new Cesium.Cartesian3())
  const h = v.scene.globe?.getHeight(Cesium.Cartographic.fromDegrees(lon, lat))
  // …a totéž kolem nového bodu
  const to = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, h ?? c0.height))
  cam.flyTo({
    destination: Cesium.Matrix4.multiplyByPoint(to, off, new Cesium.Cartesian3()),
    orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
    duration: 0.8,
  })
}

export function MiniMap({ viewer, base, onBase, onClose, size }: {
  viewer: Cesium.Viewer | null
  base: MiniBase
  onBase: (b: MiniBase) => void
  onClose: () => void
  size: number
}) {
  const [frame, setFrame] = useState<{ snap: Snap; view: View } | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size
  // jiná velikost (úzké okno) → jen přepočítat měřítko nad posledním záběrem
  useEffect(() => { setFrame(f => (f ? { snap: f.snap, view: fitView(f.snap, size, null) } : f)) }, [size])

  // Přepočet jen při pohybu kamery (mapa se kreslí na vyžádání, takže postRender = něco se hnulo)
  // a nejvýš jednou za 50 ms.
  useEffect(() => {
    const v = viewer
    if (!v || v.isDestroyed()) return
    let last = 0, timer: ReturnType<typeof setTimeout> | undefined
    const pos = new Cesium.Cartesian3(), dir = new Cesium.Cartesian3()
    let w = 0, h = 0, first = true
    const run = () => {
      timer = undefined
      if (v.isDestroyed()) return
      last = performance.now()
      const s = snapCamera(v)
      setFrame(f => (s ? { snap: s, view: fitView(s, sizeRef.current, f?.view ?? null) } : f))
    }
    const onRender = () => {
      if (v.isDestroyed()) return
      const c = v.camera, cv = v.scene.canvas
      const moved = first || !Cesium.Cartesian3.equalsEpsilon(c.positionWC, pos, 0, 0.05)
        || !Cesium.Cartesian3.equalsEpsilon(c.directionWC, dir, 1e-6) || cv.clientWidth !== w || cv.clientHeight !== h
      if (!moved || timer) return
      first = false
      Cesium.Cartesian3.clone(c.positionWC, pos); Cesium.Cartesian3.clone(c.directionWC, dir)
      w = cv.clientWidth; h = cv.clientHeight
      timer = setTimeout(run, Math.max(0, 50 - (performance.now() - last)))
    }
    v.scene.postRender.addEventListener(onRender)
    v.scene.requestRender()
    return () => {
      clearTimeout(timer)
      if (!v.isDestroyed()) v.scene.postRender.removeEventListener(onRender)
    }
  }, [viewer])

  const snap = frame?.snap ?? null
  const view = frame?.view ?? null

  // dlaždice: úroveň podle měřítka a hustoty pixelů displeje, aby byly ostré a ne zbytečně hustě
  const tiles: { key: string; src: string; left: number; top: number; px: number }[] = []
  let toScreen = (_p: Pt): Pt => [0, 0]
  if (view) {
    const maxL = base === 'orto' ? ORTO_MAX_LEVEL : ZTM_MAX_LEVEL
    const L = Math.min(maxL, Math.max(6, Math.ceil(view.z + Math.log2(window.devicePixelRatio || 1) - 0.3)))
    const world = 256 * 2 ** view.z                   // šířka světa v px minimapy
    const px = 256 * 2 ** (view.z - L)               // dlaždice úrovně L v px minimapy
    const n = 2 ** L
    toScreen = ([x, y]) => [size / 2 + (x - view.cx) * world, size / 2 + (y - view.cy) * world]
    const ix0 = Math.floor((view.cx - size / 2 / world) * n), ix1 = Math.floor((view.cx + size / 2 / world) * n)
    const iy0 = Math.floor((view.cy - size / 2 / world) * n), iy1 = Math.floor((view.cy + size / 2 / world) * n)
    for (let iy = Math.max(0, iy0); iy <= Math.min(n - 1, iy1); iy++) {
      for (let ix = Math.max(0, ix0); ix <= Math.min(n - 1, ix1); ix++) {
        const [left, top] = toScreen([ix / n, iy / n])
        tiles.push({ key: `${L}/${ix}/${iy}`, src: base === 'orto' ? orthoTileUrl(L, ix, iy) : ztmTileUrl(L, ix, iy), left, top, px })
      }
    }
  }

  const camPx = snap ? toScreen(snap.cam) : null
  const centerPx = snap ? toScreen(snap.center) : null
  const polyPx = snap?.poly.map(toScreen) ?? []

  function onClick(e: React.MouseEvent<HTMLDivElement>) {
    const v = viewer
    if (!v || v.isDestroyed() || !view) return
    const r = e.currentTarget.getBoundingClientRect()
    const world = 256 * 2 ** view.z
    const x = view.cx + (e.clientX - r.left - size / 2) / world
    const y = view.cy + (e.clientY - r.top - size / 2) / world
    lookAt(v, lonOf(x), latOf(y))
  }

  const btn = (b: MiniBase, label: string) => (
    <button
      onClick={e => { e.stopPropagation(); onBase(b) }}
      className={`px-1.5 py-0.5 pointer-coarse:px-2.5 pointer-coarse:py-1.5 ${base === b ? 'bg-emerald-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
    >{label}</button>
  )

  return (
    <div
      data-minimap={base}
      className="pointer-events-auto relative overflow-hidden rounded-xl border border-gray-700 bg-gray-800 shadow-2xl"
      style={{ width: size, height: size }}
    >
      <div
        onClick={onClick}
        title="Minimapa — klikni a pohled se posune na to místo"
        className="absolute inset-0 cursor-crosshair"
      >
        {tiles.map(t => (
          <img
            key={t.key} src={t.src} alt="" draggable={false} decoding="async"
            className="pointer-events-none absolute max-w-none select-none"
            style={{ left: t.left, top: t.top, width: t.px + 0.5, height: t.px + 0.5 }}
          />
        ))}
        <svg width={size} height={size} className="pointer-events-none absolute inset-0">
          {polyPx.length >= 3 && (
            <polygon
              data-minimap-view
              points={polyPx.map(p => p.join(',')).join(' ')}
              fill="rgba(56,189,248,0.22)" stroke="#38bdf8" strokeWidth={1.5} strokeLinejoin="round"
            />
          )}
          {camPx && centerPx && (
            <line x1={camPx[0]} y1={camPx[1]} x2={centerPx[0]} y2={centerPx[1]} stroke="#e0f2fe" strokeWidth={1.2} strokeDasharray="3 3" />
          )}
          {centerPx && <circle cx={centerPx[0]} cy={centerPx[1]} r={2.5} fill="#e0f2fe" />}
          {camPx && snap && (
            // kamera: tečka a šipka ve směru pohledu (heading měřený od severu po směru hodin)
            <g data-minimap-cam transform={`translate(${camPx[0]} ${camPx[1]}) rotate(${snap.heading * DEG})`}>
              <path d="M0 -11 L5 -3 L-5 -3 Z" fill="#f59e0b" stroke="#111827" strokeWidth={1} />
              <circle r={5} fill="#f59e0b" stroke="#111827" strokeWidth={1.5} />
            </g>
          )}
        </svg>
      </div>
      {/* ovládání: podklad vlevo nahoře, zavření vpravo nahoře */}
      <div className="absolute left-1.5 top-1.5 flex overflow-hidden rounded-md border border-gray-700 bg-gray-900/90 text-[10px] font-medium">
        {btn('orto', 'Orto')}{btn('ztm', 'Topo')}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        title="Zavřít minimapu (N)"
        className="absolute right-1.5 top-1.5 rounded-md border border-gray-700 bg-gray-900/90 p-0.5 text-gray-400 hover:text-gray-100 pointer-coarse:p-1.5"
      ><X size={12} /></button>
      <div className="pointer-events-none absolute bottom-0.5 right-1.5 text-[9px] text-white/70 [text-shadow:0_0_2px_#000]">© ČÚZK</div>
    </div>
  )
}
