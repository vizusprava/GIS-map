/**
 * Minimapa v rohu: pohled shora (ortofoto nebo ZTM ČÚZK) s polohou kamery, směrem pohledu
 * a výškou nad terénem. Hlavně pro šikmé pohledy — z 3D záběru se špatně pozná, odkud se
 * vlastně koukáš, a u uloženého pohledu kamery to člověk chce vědět přesně.
 *
 * Schválně to NENÍ druhé Cesium: další WebGL kontext by na integrované grafice ubral mapě
 * snímky. Je to pár obrázků dlaždic z cache ČÚZK (stejné služby jako podklad, prohlížeč si je
 * drží v cache) a nad nimi SVG. Překresluje se jen při pohybu kamery, nejvýš ~20× za vteřinu.
 *
 * Mapa stojí na kameře a měřítko se řídí JEN výškou kamery nad terénem: naklonění ani otočení
 * ho nemění (dřív se mapa přizpůsobovala tomu, co kamera vidí, a při každém naklonění se
 * přiblížila nebo oddálila). Mění se po půl úrovních a až když se výška změní znatelně.
 * Směr ukazuje kužel široký jako zorný úhel kamery — vždycky stejně dlouhý.
 * Klik do minimapy přesune kameru na to místo — výška nad terénem, natočení i sklon zůstanou;
 * tažení kamerou na místě otočí tam, kam táhneš.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { X } from 'lucide-react'
import { ORTO_MAX_LEVEL, ZTM_MAX_LEVEL, orthoTileUrl, ztmTileUrl } from './imagery'
import { geoidN } from './geoid'
import { faceCamera } from './sceneUtils'

export type MiniBase = 'orto' | 'ztm'

const ON_KEY = 'geo.minimap', BASE_KEY = 'geo.minimapBase'
/** Zapnutí a podklad minimapy jsou předvolba počítače (jako detail ortofota), ne scény. Výchozí: zapnutá. */
export function readMinimap(): { on: boolean; base: MiniBase } {
  try { return { on: localStorage.getItem(ON_KEY) !== '0', base: localStorage.getItem(BASE_KEY) === 'ztm' ? 'ztm' : 'orto' } }
  catch { return { on: true, base: 'orto' } }
}
export function saveMinimap(on: boolean, base: MiniBase): void {
  try { localStorage.setItem(ON_KEY, on ? '1' : '0'); localStorage.setItem(BASE_KEY, base) } catch { /* privátní režim */ }
}

export type MinimapPref = { on: boolean; base: MiniBase; toggle: () => void; setBase: (b: MiniBase) => void }
/** Zapnutí a podklad minimapy s pamětí v prohlížeči (lišta i roh mapy sahají na totéž). */
export function useMinimapPref(): MinimapPref {
  const [mini, setMini] = useState(readMinimap)
  useEffect(() => { saveMinimap(mini.on, mini.base) }, [mini])
  return {
    ...mini,
    toggle: () => setMini(m => ({ ...m, on: !m.on })),
    setBase: base => setMini(m => ({ ...m, base })),
  }
}

// ── Web Mercator v jednotkách světa 0..1 (dlaždice úrovně z mají 256 px, svět 256·2^z) ──
const wx = (lon: number) => (lon + 180) / 360
const wy = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) }
const lonOf = (x: number) => x * 360 - 180
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
const DEG = 180 / Math.PI
/** metry na pixel na rovníku v úrovni 0 (dlaždice 256 px) */
const M_PER_PX0 = 156543.03392

type Pt = [number, number]
/**
 * Kamera pro minimapu: poloha (jednotky světa), azimut, vodorovný zorný úhel, výška nad
 * terénem a nadmořská výška (Bpv: elipsoid minus kvazigeoid, jako všude jinde v appce).
 */
type Snap = { cam: Pt; lat: number; heading: number; hfov: number; agl: number; asl: number }

function snapCamera(v: Cesium.Viewer): Snap {
  const cam = v.camera, canvas = v.scene.canvas
  const carto = cam.positionCartographic
  const g = v.scene.globe?.getHeight(carto)
  const agl = Math.max(0, carto.height - (g !== undefined && Number.isFinite(g) ? g : 0))
  // `fov` platí pro delší stranu obrazovky; na výšku (tablet) se vodorovný úhel dopočítá
  const f = cam.frustum
  let hfov = Math.PI / 3
  if (f instanceof Cesium.PerspectiveFrustum && f.fov) {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
    hfov = aspect >= 1 ? f.fov : 2 * Math.atan(Math.tan(f.fov / 2) * aspect)
  }
  const lat = carto.latitude * DEG, lon = carto.longitude * DEG
  return { cam: [wx(lon), wy(lat)], lat, heading: cam.heading, hfov, agl, asl: carto.height - geoidN(lon, lat) }
}

/**
 * Úroveň přiblížení podle výšky: od kamery ke kraji minimapy je vidět ~4× výška nad terénem
 * (aspoň 300 m, nejvýš 30 km). Po půl úrovních a s rezervou — drobná změna výšky (nebo
 * dočtení terénu pod kamerou) mapu nepřeskládá.
 */
function zoomFor(s: Snap, size: number, prev: number | null): number {
  const R = Math.min(30_000, Math.max(300, s.agl * 4))
  const want = Math.min(19, Math.max(7, Math.log2((M_PER_PX0 * Math.cos((s.lat * Math.PI) / 180) * (size / 2)) / R)))
  if (prev !== null && Math.abs(want - prev) < 0.6) return prev
  return Math.round(want * 2) / 2
}

/**
 * Přesune KAMERU na bod (lon, lat) — tečka v minimapě skončí tam, kam se kliklo. Výška nad
 * terénem, natočení i sklon zůstanou. (Dřív se tam posouval bod, na který se kamera dívá: shora
 * to vyšlo nastejno, ale u šikmého pohledu kamera skončila o kus dál, než se kliklo.)
 */
/**
 * Kamera na výšku `agl` metrů nad terénem, svisle na místě — poloha, natočení i sklon zůstanou.
 * Terén pod kamerou z načtených dlaždic (stejně jako údaj v minimapě); rozumný rozsah 2 m až 100 km.
 *
 * Při sestupu se pod kamerou dotáhnou jemnější dlaždice terénu a terén „povyroste" (klidně
 * o desítku metrů) — minimapa by pak místo zadaných 250 m ukázala 239 m. Po doletu se proto výška
 * dorovná a znovu, kdykoliv se dlaždice dotáhnou (nanejvýš 5 s), dokud s kamerou nikdo nehne.
 */
function setCameraHeight(v: Cesium.Viewer, agl: number) {
  const cam = v.camera, c = cam.positionCartographic
  const lon = c.longitude, lat = c.latitude
  const want = Math.min(100_000, Math.max(2, agl))
  const ground = () => {
    const g = v.scene.globe?.getHeight(Cesium.Cartographic.fromRadians(lon, lat))
    return g !== undefined && Number.isFinite(g) ? g : 0
  }
  let placed = ground() + want
  /** dorovná výšku; false = kamerou mezitím pohnul někdo jiný, dál nehlídat */
  const level = () => {
    if (v.isDestroyed()) return false
    const p = cam.positionCartographic
    if (Math.abs(p.longitude - lon) > 1e-9 || Math.abs(p.latitude - lat) > 1e-9 || Math.abs(p.height - placed) > 0.5) return false
    const target = ground() + want
    if (Math.abs(target - placed) > 0.2) {
      placed = target
      cam.setView({ destination: Cesium.Cartesian3.fromRadians(lon, lat, target), orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll } })
      v.scene.requestRender()
    }
    return true
  }
  cam.flyTo({
    destination: Cesium.Cartesian3.fromRadians(lon, lat, placed),
    orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
    duration: 0.6,
    complete: () => {
      if (!level()) return
      const globe = v.scene.globe
      if (!globe) return
      const off = globe.tileLoadProgressEvent.addEventListener((queued: number) => { if (queued === 0 && !level()) stop() })
      const t = setTimeout(() => stop(), 5000)
      const stop = () => { off(); clearTimeout(t) }
    },
  })
}

function moveCameraTo(v: Cesium.Viewer, lon: number, lat: number) {
  const cam = v.camera, globe = v.scene.globe
  const here = cam.positionCartographic
  const g0 = globe?.getHeight(here)
  const ground0 = g0 !== undefined && Number.isFinite(g0) ? g0 : 0
  // terén v cíli nemusí být načtený (daleký skok) — pak se počítá s terénem pod kamerou
  const g1 = globe?.getHeight(Cesium.Cartographic.fromDegrees(lon, lat))
  const ground1 = g1 !== undefined && Number.isFinite(g1) ? g1 : ground0
  cam.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, ground1 + (here.height - ground0)),
    orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
    duration: 0.8,
  })
}

const fmtHeight = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} km`)

export function MiniMap({ viewer, base, onBase, onClose, size }: {
  viewer: Cesium.Viewer | null
  base: MiniBase
  onBase: (b: MiniBase) => void
  onClose: () => void
  size: number
}) {
  const [frame, setFrame] = useState<{ snap: Snap; z: number } | null>(null)
  /** rozepsaná nová výška kamery nad terénem (null = nepíše se) */
  const [editH, setEditH] = useState<string | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size
  // jiná velikost (úzké okno) → přepočítat měřítko nad posledním záběrem
  useEffect(() => { setFrame(f => (f ? { snap: f.snap, z: zoomFor(f.snap, size, null) } : f)) }, [size])

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
      setFrame(f => ({ snap: s, z: zoomFor(s, sizeRef.current, f?.z ?? null) }))
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
    // Výška nad terénem se bere z načtených dlaždic terénu. Když se dotáhnou až po posledním
    // pohybu kamery (typicky po otevření scény), přepočítat i bez pohybu — jinak by minimapa
    // dál ukazovala výšku nad elipsoidem jako „nad terénem".
    const offTiles = v.scene.globe?.tileLoadProgressEvent.addEventListener((queued: number) => {
      if (queued === 0 && !timer) timer = setTimeout(run, 100)
    })
    v.scene.requestRender()
    return () => {
      clearTimeout(timer)
      offTiles?.()
      if (!v.isDestroyed()) v.scene.postRender.removeEventListener(onRender)
    }
  }, [viewer])

  const snap = frame?.snap ?? null
  const z = frame?.z ?? null
  const half = size / 2

  // dlaždice: úroveň podle měřítka a hustoty pixelů displeje, aby byly ostré a ne zbytečně hustě
  const tiles: { key: string; src: string; left: number; top: number; px: number }[] = []
  if (snap && z !== null) {
    const [cx, cy] = snap.cam
    const maxL = base === 'orto' ? ORTO_MAX_LEVEL : ZTM_MAX_LEVEL
    const L = Math.min(maxL, Math.max(6, Math.ceil(z + Math.log2(window.devicePixelRatio || 1) - 0.3)))
    const world = 256 * 2 ** z                       // šířka světa v px minimapy
    const px = 256 * 2 ** (z - L)                   // dlaždice úrovně L v px minimapy
    const n = 2 ** L
    const ix0 = Math.floor((cx - half / world) * n), ix1 = Math.floor((cx + half / world) * n)
    const iy0 = Math.floor((cy - half / world) * n), iy1 = Math.floor((cy + half / world) * n)
    for (let iy = Math.max(0, iy0); iy <= Math.min(n - 1, iy1); iy++) {
      for (let ix = Math.max(0, ix0); ix <= Math.min(n - 1, ix1); ix++) {
        tiles.push({
          key: `${L}/${ix}/${iy}`, src: base === 'orto' ? orthoTileUrl(L, ix, iy) : ztmTileUrl(L, ix, iy),
          left: half + (ix / n - cx) * world, top: half + (iy / n - cy) * world, px,
        })
      }
    }
  }

  // kužel pohledu: od kamery (střed minimapy) ve směru azimutu, široký jako zorný úhel
  const coneLen = size * 0.36
  const cone: Pt[] = []
  if (snap) {
    const a0 = snap.heading - snap.hfov / 2
    for (let i = 0; i <= 12; i++) {
      const a = a0 + (snap.hfov * i) / 12
      cone.push([half + Math.sin(a) * coneLen, half - Math.cos(a) * coneLen])
    }
  }

  /**
   * Klik = přesun kamery na to místo, tažení = otočení na místě: kamera se živě dívá tam, kam
   * táhneš (od středu minimapy, kde kamera stojí). Rozliší je pohyb o pár pixelů.
   */
  const drag = useRef<{ id: number; x: number; y: number; turning: boolean } | null>(null)
  const at = (e: React.PointerEvent<HTMLDivElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* bez zachycení jen bez tahu mimo minimapu */ }
    const [x, y] = at(e)
    drag.current = { id: e.pointerId, x, y, turning: false }
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current, v = viewer
    if (!d || d.id !== e.pointerId || !v || v.isDestroyed()) return
    const [x, y] = at(e)
    if (!d.turning && Math.hypot(x - d.x, y - d.y) < 5) return
    d.turning = true
    const dx = x - half, dy = y - half
    if (Math.hypot(dx, dy) < 6) return // přímo na kameře směr nemá smysl
    faceCamera(v, Math.atan2(dx, -dy))
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current, v = viewer
    drag.current = null
    if (!d || d.id !== e.pointerId || d.turning || !v || v.isDestroyed() || !snap || z === null) return
    const world = 256 * 2 ** z
    moveCameraTo(v, lonOf(snap.cam[0] + (d.x - half) / world), latOf(snap.cam[1] + (d.y - half) / world))
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
      data-zoom={z ?? ''}
      className="pointer-events-auto relative overflow-hidden rounded-xl border border-gray-700 bg-gray-800 shadow-2xl"
      style={{ width: size, height: size }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null }}
        title="Minimapa — klik přesune kameru na to místo, tažení ji na místě otočí"
        className="absolute inset-0 cursor-crosshair touch-none"
      >
        {tiles.map(t => (
          <img
            key={t.key} src={t.src} alt="" draggable={false} decoding="async"
            className="pointer-events-none absolute max-w-none select-none"
            style={{ left: t.left, top: t.top, width: t.px + 0.5, height: t.px + 0.5 }}
          />
        ))}
        {snap && (
          <svg width={size} height={size} className="pointer-events-none absolute inset-0">
            <defs>
              <radialGradient id="minimap-cone" gradientUnits="userSpaceOnUse" cx={half} cy={half} r={coneLen}>
                <stop offset="0" stopColor="#38bdf8" stopOpacity={0.55} />
                <stop offset="1" stopColor="#38bdf8" stopOpacity={0.08} />
              </radialGradient>
            </defs>
            <polygon
              data-minimap-view
              points={[[half, half] as Pt, ...cone].map(p => p.join(',')).join(' ')}
              fill="url(#minimap-cone)" stroke="#38bdf8" strokeOpacity={0.8} strokeWidth={1.2} strokeLinejoin="round"
            />
            {/* kamera: tečka a šipka ve směru pohledu (azimut od severu po směru hodin) */}
            {/* zaokrouhleno: azimut skoro 0 by se jinak vypsal jako „6.3e-15" */}
            <g data-minimap-cam transform={`translate(${half} ${half}) rotate(${(snap.heading * DEG).toFixed(2)})`}>
              <path d="M0 -11 L5 -3 L-5 -3 Z" fill="#f59e0b" stroke="#111827" strokeWidth={1} />
              <circle r={5} fill="#f59e0b" stroke="#111827" strokeWidth={1.5} />
            </g>
          </svg>
        )}
      </div>
      {/* ovládání: podklad vlevo nahoře, zavření vpravo nahoře, výška a zdroj dole */}
      <div className="absolute left-1.5 top-1.5 flex overflow-hidden rounded-md border border-gray-700 bg-gray-900/90 text-[10px] font-medium">
        {btn('orto', 'Orto')}{btn('ztm', 'Topo')}
      </div>
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        title="Zavřít minimapu (N)"
        className="absolute right-1.5 top-1.5 rounded-md border border-gray-700 bg-gray-900/90 p-0.5 text-gray-400 hover:text-gray-100 pointer-coarse:p-1.5"
      ><X size={12} /></button>
      {/* výška kamery: nad terénem (to, co člověk vnímá) a nadmořská; na malé minimapě jen ta první */}
      {/* Výška kamery: nad terénem (to, co člověk vnímá) a nadmořská; na malé minimapě jen ta
          první. Klik otevře políčko na novou výšku nad terénem. */}
      {snap && editH === null && (
        <button
          data-minimap-height
          onClick={e => { e.stopPropagation(); setEditH(String(Math.round(snap.agl))) }}
          title={`Kamera ${fmtHeight(snap.agl)} nad terénem, ${Math.round(snap.asl).toLocaleString('cs-CZ')} m n. m. (Bpv) — klikni a zadej novou výšku`}
          className="absolute bottom-1.5 left-1.5 rounded-md bg-gray-900/85 px-1.5 py-0.5 text-left leading-tight hover:bg-gray-800 pointer-coarse:py-1.5"
        >
          <div className="text-[10px] font-medium text-gray-100">↑ {fmtHeight(snap.agl)}{size >= 160 ? ' nad terénem' : ''}</div>
          {size >= 160 && <div className="text-[9px] text-gray-400">{Math.round(snap.asl).toLocaleString('cs-CZ')} m n. m.</div>}
        </button>
      )}
      {editH !== null && (
        <form
          data-minimap-height-edit
          onSubmit={e => {
            e.preventDefault()
            const m = Number(editH.replace(',', '.'))
            const v = viewer
            if (v && !v.isDestroyed() && Number.isFinite(m)) setCameraHeight(v, m)
            setEditH(null)
          }}
          className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md border border-gray-600 bg-gray-900/95 px-1.5 py-1 text-[10px] text-gray-300"
        >
          ↑
          <input
            autoFocus inputMode="decimal" value={editH}
            onChange={e => setEditH(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEditH(null) } }}
            onBlur={() => setEditH(null)}
            onFocus={e => e.target.select()}
            aria-label="Výška kamery nad terénem v metrech"
            className="w-14 rounded bg-gray-800 px-1 py-0.5 text-[11px] text-gray-100 outline-none focus:ring-1 focus:ring-emerald-500/70"
          />
          m nad terénem
        </form>
      )}
      <div className="pointer-events-none absolute bottom-0.5 right-1.5 text-[9px] text-white/70 [text-shadow:0_0_2px_#000]">© ČÚZK</div>
    </div>
  )
}
