/**
 * Pohyb kamery mimo samotné přelety: projekce (perspektiva × pohled shora), kroužení, chvění
 * „z ruky" a plynulé přiblížení kolečkem.
 *
 * Kroužení a chvění jsou součást VZHLEDU POHLEDU (CamLook) — zapíná je přílet na uložený pohled
 * (useCamViews). Tady žije jejich stav a smyčky, které s kamerou hýbou.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { SHAKE_KEY, SHAKE_MAX_DEG, SPIN_KEY, SPIN_DEFAULT_DEG_S, ZOOM_SENS, ZOOM_TAU, ZOOM_MAX } from './config'
import { viewCenterGround } from './sceneUtils'
import { MIN_ABOVE_GROUND_M, crMaxHeight } from './cameraBounds'
import type { CamProj } from './ui'

export type CameraMotion = ReturnType<typeof useCameraMotion>

export function useCameraMotion(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  /** mimo prezentaci se nechvěje ani nekrouží */
  presentOn: boolean
  /** zorný úhel — návrat z ortha ho musí vrátit (Cesium dá natvrdo 60°) */
  fov: number
  applyFovRaw: (deg: number) => void
}) {
  const { viewerRef, presentOn, fov, applyFovRaw } = deps

  // Projekce kamery. Pravdu drží frustum v Cesiu, tohle je jen zrcadlo pro UI — přepínač musí
  // ukazovat, v čem právě jsi, jinak se při rychlém přepínání ztratíš.
  const [camProj, setCamProj] = useState<CamProj>('persp')
  const [orbitOn, setOrbitOn] = useState(true)        // přelet obloukem kolem středu pohledu (výchozí)
  // „Kroužení" — kamera pomalu obíhá kolem místa, na které se pohled dívá. Stejně jako chvění je
  // to součást VZHLEDU POHLEDU (CamLook), ne globální volba, a po startu je vždycky vypnuté.
  // V localStorage zůstává jen naposledy nastavená rychlost jako výchozí hodnota slideru.
  const [spinOn, setSpinOn] = useState(false)
  const [spinSpeed, setSpinSpeed] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(SPIN_KEY) || '{}').speed; return typeof s === 'number' && s !== 0 ? s : SPIN_DEFAULT_DEG_S } catch { return SPIN_DEFAULT_DEG_S }
  })
  const spinRef = useRef({ on: false, speed: 0 })
  // Pivot = bod, kolem kterého se krouží. Vzorkuje se jednou při rozjezdu (null = vzorkuj znovu),
  // ne každý snímek: kroužením se střed obrazu drobně posouvá a dopočítávaný pivot by se rozjel.
  const spinPivotRef = useRef<Cesium.Cartesian3 | null>(null)
  // Do kdy se kroužit NEMÁ (ms, performance.now). Přelet na pohled si kameru řídí sám a kroužení
  // by se s ním pralo — tak počká, až doletí, a teprve pak si vezme nový pivot.
  const spinHoldRef = useRef(0)
  // „Kamera z ruky" — jemné chvění pohledu v prezentaci. Je součástí VZHLEDU POHLEDU (CamLook),
  // ne globální volba: každý uložený pohled si nese vlastní zapnutí i intenzitu, takže se chvění
  // dá dát jen na záběry, kterým sluší. Po startu je proto vždy VYPNUTÉ a čeká, až přiletíš na
  // pohled, který ho má. V localStorage zůstává jen naposledy nastavená intenzita jako výchozí
  // hodnota slideru — zapnutí se neukládá, aby se refreshem nikdy nevrátilo samo.
  const [shakeOn, setShakeOn] = useState(false)
  const [shakeAmt, setShakeAmt] = useState(() => {
    try { const a = JSON.parse(localStorage.getItem(SHAKE_KEY) || '{}').amt; return typeof a === 'number' ? a : 0.35 } catch { return 0.35 }
  })
  // čte ho renderovací smyčka každý snímek → ref, ať se listenery nepřepínají při každém tahu slideru
  const shakeRef = useRef({ on: false, amt: 0.35 })
  const orbitAnimRef = useRef(0)                       // token běžící orbit animace (pro zrušení předchozí)

  // ── kamera: perspektiva ↔ pohled shora (ortho, jako půdorys) ──
  // POZOR: Cesium ve `switchToPerspectiveFrustum` staví nový frustum a natvrdo mu dá 60°.
  // Bez vrácení našeho `fov` by tedy každý návrat z ortha potichu přepsal nastavený zorný úhel.
  function camPerspective() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    v.scene.camera.switchToPerspectiveFrustum()
    applyFovRaw(fov)
    setCamProj('persp')
  }
  function camTopOrtho() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const g = viewCenterGround(v)
    const h = Math.max(150, v.camera.positionCartographic?.height ?? 2000)
    v.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(g.lon, g.lat, h),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 0.5,
      // Až po doletu: kdyby přelet uživatel přerušil, `complete` se nezavolá a přepínač zůstane
      // stát na perspektivě — tedy na tom, co je opravdu vidět.
      complete: () => { if (!v.isDestroyed()) { v.scene.camera.switchToOrthographicFrustum(); setCamProj('ortho') } },
    })
  }

  useEffect(() => {
    shakeRef.current = { on: shakeOn && presentOn, amt: shakeAmt } // mimo prezentaci se nechvěje
    // ukládá se JEN intenzita (výchozí pro slider); zapnutí patří uloženému pohledu, ne prohlížeči
    try { localStorage.setItem(SHAKE_KEY, JSON.stringify({ amt: shakeAmt })) } catch { /* */ }
  }, [shakeOn, shakeAmt, presentOn])

  useEffect(() => {
    const wasOn = spinRef.current.on
    spinRef.current = { on: spinOn && presentOn, speed: spinSpeed }
    if (!wasOn && spinRef.current.on) spinPivotRef.current = null // rozjezd → vezmi si čerstvý střed
    // ukládá se JEN rychlost (výchozí pro slider); zapnutí patří uloženému pohledu, ne prohlížeči
    try { localStorage.setItem(SPIN_KEY, JSON.stringify({ speed: spinSpeed })) } catch { /* */ }
  }, [spinOn, spinSpeed, presentOn])

  /**
   * „Kroužení": kamera pomalu obíhá kolem místa, na které se dívá.
   *
   * Na rozdíl od chvění je to SKUTEČNÝ pohyb kamery, ne optický trik — o to jde, jinak by nevznikla
   * paralaxa a scéna by nepůsobila prostorově. Kamera se proto opravdu přesouvá po kružnici kolem
   * pivotu a orientace se otáčí s ní, takže předmět zůstává pořád uprostřed.
   *
   * Otáčí se přes `lookAtTransform` do ENU rámce pivotu, tam se udělá `rotate` kolem místné svislice
   * a rámec se hned zase pustí (`Matrix4.IDENTITY`). Kamera si přitom nechá výslednou polohu ve
   * světě, ale `camera.transform` zůstane jednotková — na tom stojí zbytek appky (chvění, snímkování
   * i `viewCenterGround` počítají s neposunutým rámcem), takže si ho tu nesmíme nechat nastavený.
   *
   * Běží v `preUpdate`, tedy MIMO okno mezi pre/postRender, kde sedí chvění kamery — jinak by si
   * obojí přepisovalo pozici. Ze stejného důvodu tu sedí i plynulé přiblížení.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const scene = v.scene
    const cam = scene.camera
    const spinFrame = new Cesium.Matrix4() // scratch — 60fps smyčka, ať se nealokuje každý snímek
    let last = performance.now()
    const onPreUpdate = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000) // po přepnutí tabu ať to neskočí naráz
      last = now
      const { on, speed } = spinRef.current
      if (!on || !speed) return
      if (now < spinHoldRef.current) { spinPivotRef.current = null; return } // ještě se letí
      // Snímkování pohledů si kameru drží přes lookAt (nenulový transform) a chce klidné záběry.
      if (!Cesium.Matrix4.equals(cam.transform, Cesium.Matrix4.IDENTITY)) return
      if (!spinPivotRef.current) {
        const g = viewCenterGround(v)
        spinPivotRef.current = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      }
      const frame = Cesium.Transforms.eastNorthUpToFixedFrame(spinPivotRef.current, undefined, spinFrame)
      cam.lookAtTransform(frame)
      cam.rotate(Cesium.Cartesian3.UNIT_Z, -Cesium.Math.toRadians(speed) * dt)
      cam.lookAtTransform(Cesium.Matrix4.IDENTITY)
    }
    scene.preUpdate.addEventListener(onPreUpdate)
    return () => { scene.preUpdate.removeEventListener(onPreUpdate) }
  }, [])

  /**
   * „Kamera z ruky": jemné rozechvění pohledu v prezentaci.
   *
   * Nasazuje se PŘED vykreslením snímku a hned po něm se kamera vrátí přesně tam, kde byla.
   * Skutečný stav kamery tak zůstává čistý — přelety (flyTo i orbit), ovládání myší, ukládání
   * pohledů a `viewCenterGround` pracují s nerozechvěnou kamerou a chvění se nikam nenasčítá.
   * (Kdyby se chvění do kamery zapisovalo natrvalo, po minutě prezentace by ujela jinam.)
   *
   * Otáčí se jen POHLED (yaw/pitch/roll kolem vlastních os kamery), pozicí nehýbeme: je to to,
   * co na „z ruky" čte, kamera se nemůže dostat do terénu a nevzniká gimbal u pohledu shora.
   * Rotace jdou přes `look*`/`twist*`, takže se nepřevádí na heading/pitch/roll a zpět —
   * obnova je pak bitově přesná a nedrift.
   *
   * Šum = součet nesouměřitelných sinusovek (žádná knihovna): pomalé plutí + rychlejší
   * mikrochvění, každá osa s jiným rozfázováním, aby se vzor dlouho neopakoval. Amplituda
   * se škáluje zorným úhlem — u úzkého FOV je stejný úhel na obraze větší, takže by přizoomovaný
   * záběr jinak vibroval mnohem víc.
   *
   * POZOR na okno mezi `onPre` a `onPost`: uvnitř něj je kamera rozechvělá a JEN TAM se smí
   * promítat kotvy do obrazovky. `CalloutLayer` (callouts.tsx) proto počítá pozice popisků
   * v `preRender` — kdyby to dělal v `postRender`, dostal by už narovnanou kameru a popisky by
   * po scéně klouzaly o celou výchylku. Nepřehazovat ani jednu z těch registrací.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    // Scénu i obě události si držíme z doby registrace. V odhlašování se na `v.scene` sahat NESMÍ:
    // cleanup běží při zrušení komponenty, tedy až po zničení viewru (hook vieweru se v `MapView`
    // volá dřív, takže jeho cleanup jde první), a getter `Viewer.scene` pak sáhne do už zahozeného
    // widgetu a spadne. `Viewer.isDestroyed()` to nezachytí — v Cesiu vrací vždy false.
    const scene = v.scene
    const cam = scene.camera
    const C3 = Cesium.Cartesian3
    let saved: { pos: Cesium.Cartesian3; dir: Cesium.Cartesian3; up: Cesium.Cartesian3 } | null = null
    const t0 = performance.now()
    const wave = (t: number, parts: [number, number][]) =>
      parts.reduce((s, [hz, amp]) => s + Math.sin(t * hz * Math.PI * 2) * amp, 0)

    const onPre = () => {
      const { on, amt } = shakeRef.current
      if (!on || amt <= 0) return
      // Kdo si kameru drží přes lookAt (nenulový transform — řezový pohled, otáčení kolem bodu),
      // ten ji řídí sám — tam do ní nesaháme.
      if (!Cesium.Matrix4.equals(cam.transform, Cesium.Matrix4.IDENTITY)) return
      const t = (performance.now() - t0) / 1000
      const fov = (cam.frustum as Cesium.PerspectiveFrustum).fov // ortho frustum ho nemá → bez škálování
      const k = Cesium.Math.toRadians(SHAKE_MAX_DEG) * amt * (fov ? fov / Cesium.Math.toRadians(60) : 1)
      saved = {
        pos: C3.clone(cam.positionWC, new C3()),
        dir: C3.clone(cam.directionWC, new C3()),
        up: C3.clone(cam.upWC, new C3()),
      }
      cam.lookRight(wave(t, [[0.077, 0.62], [0.26, 0.26], [0.77, 0.12]]) * k)
      cam.lookUp(wave(t + 3.7, [[0.063, 0.58], [0.29, 0.28], [0.91, 0.14]]) * k)
      cam.twistRight(wave(t + 11.3, [[0.049, 0.50], [0.203, 0.22]]) * k * 0.5) // klopení jen poloviční
    }
    const onPost = () => {
      if (!saved) return
      cam.setView({ destination: saved.pos, orientation: { direction: saved.dir, up: saved.up } })
      saved = null
    }
    // Mapa kreslí jen na vyžádání a chvění se nasazuje až při vykreslení — skutečná kamera se
    // přitom nehne, takže by si Cesium žádný snímek neřeklo a chvění by stálo. Dokud je zapnuté,
    // vyžádá se proto snímek každý tik. `preUpdate` běží v každém tiku, i když se nekreslí.
    const onTick = () => {
      const { on, amt } = shakeRef.current
      if (on && amt > 0) scene.requestRender()
    }
    scene.preUpdate.addEventListener(onTick)
    scene.preRender.addEventListener(onPre)
    scene.postRender.addEventListener(onPost)
    // Odhlášení stačí odebrat posluchače (jen splice v poli, bezpečné i po zničení scény).
    // Kameru tu nesrovnáváme zpátky — cleanup přichází jen se zánikem komponenty, kdy už
    // viewer stejně mizí, a `cam.setView` na zničené scéně by spadl.
    return () => {
      scene.preUpdate.removeEventListener(onTick)
      scene.preRender.removeEventListener(onPre)
      scene.postRender.removeEventListener(onPost)
    }
  }, [])

  /**
   * Plynulé přiblížení kolečkem.
   *
   * Cesium na každý zářez kolečka kameru posune skokem — při rychlejším rolování to nadskakuje.
   * Kolečko si proto bereme sami (WHEEL jsme mu odebrali při inicializaci): každý zářez se
   * přičte do „nedojetého“ zoomu a ten k nule dotáhne kriticky tlumená pružina, takže se pohyb
   * plynule rozjede i doklouže — bez kopnutí na začátku a bez přestřelení na konci.
   *
   * Krok je NÁSOBNÝ vůči výšce nad terénem — u země jemný, z výšky velký. Výška nad elipsoidem
   * by u kopců lhala (terén v Liberci je ~400 m), proto se výška terénu odečítá.
   *
   * Běží v `preUpdate`, tedy mimo okno mezi pre/postRender, kde sedí chvění kamery — jinak by
   * si obojí přepisovalo pozici. Sražení s terénem řeší ovladač až v dalším cyklu, takže si krok
   * omezujeme sami; bez toho kamera na jeden snímek propadne pod zem, než ji vytlačí zpátky.
   */
  const zoomRef = useRef(0) // nedojetý zoom v log jednotkách (+ = přiblížit)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const scene = v.scene, cam = scene.camera, canvas = scene.canvas
    const ssc = scene.screenSpaceCameraController

    const onWheel = (e: WheelEvent) => {
      if (!ssc.enableInputs) return // režimy, které si vstupy berou (posun modelu, malování dlaždic)
      e.preventDefault()
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1) // řádky/stránky → pixely
      zoomRef.current = Cesium.Math.clamp(zoomRef.current - px * ZOOM_SENS, -ZOOM_MAX, ZOOM_MAX)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    let last = performance.now()
    let zoomVel = 0 // rychlost pružiny (log jednotek/s) — musí přežít mezi snímky, jinak nemá setrvačnost
    const onPreUpdate = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000) // po přepnutí tabu ať to neskočí naráz
      last = now
      const rest = zoomRef.current
      if (Math.abs(rest) < 1e-4 && Math.abs(zoomVel) < 1e-4) { zoomRef.current = 0; zoomVel = 0; return }
      // Kriticky tlumená pružina táhne zbytek k nule. Prostý exponenciální doběh by na každý
      // zářez skočil z nuly rovnou na plnou rychlost — a právě to kopnutí je zbytkové cukání.
      // Pružina má rychlost spojitou, takže se pohyb rozjede i doklouže. Kriticky tlumená =
      // nejrychlejší možný náběh BEZ přestřelení, jinak by zoom na konci gumoval.
      // Tvar je semi-implicitní (jmenovatel), aby to bylo stabilní i při vynechaném snímku.
      const w = 2 / ZOOM_TAU
      zoomVel = (zoomVel - dt * w * w * rest) / (1 + 2 * w * dt + w * w * dt * dt)
      let step = -zoomVel * dt
      const cc = cam.positionCartographic
      const h = Math.max(MIN_ABOVE_GROUND_M, cc.height - (scene.globe.getHeight(cc) ?? 0))
      zoomRef.current = rest - step
      if (step > 0) { // přibližování zastav nad zemí
        const maxStep = Math.log(h / Math.max(1.5, ssc.minimumZoomDistance))
        if (step > maxStep) { step = Math.max(0, maxStep); zoomRef.current = 0; zoomVel = 0 } // u země zastav i pružinu
      } else if (step < 0 && cc.height >= crMaxHeight(scene) * 0.995) {
        // oddalování jen do výšky, ze které je vidět celá republika (cameraBounds.ts) — u stropu
        // zastav i pružinu, jinak by se o něj opírala a kamera by se cukala
        step = 0; zoomRef.current = 0; zoomVel = 0
      }
      if (step !== 0) cam.zoomIn(h * (1 - Math.exp(-step))) // step < 0 → negativní posun = oddálení
    }
    scene.preUpdate.addEventListener(onPreUpdate)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      scene.preUpdate.removeEventListener(onPreUpdate)
    }
  }, [])

  /**
   * Rozhlížení na místě: Shift + tažení levým tlačítkem. Vlastní, ne vestavěné v Cesiu — to
   * otáčí kolem os kamery, a tak se při tažení šikmo kamera postupně naklání do strany (změřeno:
   * tři tahy a obzor je o 8° nakřivo). Tady se mění jen azimut a sklon, náklon zůstává nula.
   * Pocit i rychlost jako dřív: obraz jde s myší (tah doprava = pohled doleva, nahoru = dolů),
   * jeden pixel = zorný úhel / šířka obrazovky.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const scene = v.scene, cam = scene.camera, canvas = scene.canvas
    const ssc = scene.screenSpaceCameraController
    ssc.lookEventTypes = undefined
    let look: { id: number; x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.shiftKey || e.pointerType === 'touch' || !ssc.enableInputs) return
      look = { id: e.pointerId, x: e.clientX, y: e.clientY }
    }
    const onMove = (e: PointerEvent) => {
      if (!look || e.pointerId !== look.id) return
      if (!(e.buttons & 1)) { look = null; return } // puštěné mimo okno
      const dx = e.clientX - look.x, dy = e.clientY - look.y
      look.x = e.clientX; look.y = e.clientY
      if (!dx && !dy) return
      const f = cam.frustum
      const k = (f instanceof Cesium.PerspectiveFrustum && f.fov ? f.fov : Math.PI / 3) / Math.max(1, canvas.clientWidth, canvas.clientHeight)
      // pohled shora bez perspektivy má sklon pevně dolů — tam se jen otáčí
      const pitch = f instanceof Cesium.OrthographicFrustum ? cam.pitch
        : Cesium.Math.clamp(cam.pitch + dy * k, Cesium.Math.toRadians(-89.5), Cesium.Math.toRadians(60))
      cam.completeFlight()
      cam.setView({ orientation: { heading: cam.heading - dx * k, pitch, roll: 0 } })
    }
    const onUp = (e: PointerEvent) => { if (look && e.pointerId === look.id) look = null }
    canvas.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  return {
    camPerspective,
    camProj,
    camTopOrtho,
    orbitAnimRef,
    orbitOn,
    setOrbitOn,
    setShakeAmt,
    setShakeOn,
    setSpinOn,
    setSpinSpeed,
    shakeAmt,
    shakeOn,
    shakeRef,
    spinHoldRef,
    spinOn,
    spinPivotRef,
    spinSpeed,
  }
}
