/**
 * Uložené pohledy kamery — scénář prezentace: ukládání, přelety (napřímo i obloukem), přechod
 * vzhledu kamery během přeletu a hlídání, jestli aktivní pohled ještě sedí na to, co je vidět.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ask } from './dialog'
import * as Cesium from 'cesium'
import { VIEW_THUMB_W, VIEW_THUMB_H, VIEW_THUMB_Q, VIEW_DIRTY_M, VIEW_DIRTY_DEG } from './config'
import { viewCenterGround } from './sceneUtils'
import { renderNow } from './snapshot'
import type { CamLook, CamView } from './types'
import type { ScenePersist } from './lib/scenePersist'
import type { LookTool } from './useLookTool'
import type { CameraMotion } from './useCameraMotion'

export type CamViewsTool = ReturnType<typeof useCamViews>

/**
 * Shodují se dva vzhledy pohledu?
 *
 * Nejde porovnat přes JSON: pohledy uložené dřív nemají klíče `shake*`/`spin*` vůbec, a chybějící
 * hodnota přitom znamená totéž co vypnuto. Doprovodné hodnoty (intenzita, rychlost) se porovnávají
 * jen když je efekt zapnutý — jinak by „upraveno" naskočilo po pohnutí sliderem, který stejně nic
 * nedělá, protože je vypínač zhasnutý.
 */
function sameLook(a: CamLook, b: CamLook): boolean {
  if (a.fov !== b.fov) return false
  if (a.dofOn !== b.dofOn) return false
  if (a.dofOn && (a.dofMode !== b.dofMode || a.dofBlur !== b.dofBlur)) return false
  if (a.dofOn && a.dofMode === 'dist' && a.dofFocal !== b.dofFocal) return false
  if (a.dofOn && a.dofMode === 'circle' && (a.dofRadius !== b.dofRadius || a.dofFeather !== b.dofFeather)) return false
  if (!!a.shakeOn !== !!b.shakeOn) return false
  if (a.shakeOn && a.shakeAmt !== b.shakeAmt) return false
  if (!!a.spinOn !== !!b.spinOn) return false
  if (a.spinOn && a.spinSpeed !== b.spinSpeed) return false
  return true
}

export function useCamViews(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  viewerReady: boolean
  sceneRef: React.RefObject<ScenePersist>
  look: LookTool
  motion: CameraMotion
  presentOn: boolean
  /** co bylo v prezentaci zapnuté, než se vypnula (přílet na pohled to aktualizuje) */
  presentSnapRef: React.RefObject<{ dofOn: boolean } | null>
  /** kolik popisků na pohledu visí (do otázky při mazání) */
  viewRefs: (id: string) => { callouts: number }
  /** pohled je pryč — popisky na něm přestanou viset */
  onViewDeleted: (id: string) => void
}) {
  const { viewerRef, viewerReady, sceneRef, presentOn, presentSnapRef, viewRefs, onViewDeleted } = deps
  const {
    applyDofRaw, applyFovRaw, dofBlur, dofFeather, dofFocal, dofMode, dofOn, dofRadius, fov,
    lookAnimRef, setDofBlur, setDofFeather, setDofFocal, setDofMode, setDofOn, setDofRadius, setFov,
  } = deps.look
  const {
    orbitAnimRef, orbitOn, setShakeAmt, setShakeOn, setSpinOn, setSpinSpeed, shakeAmt, shakeOn, shakeRef,
    spinHoldRef, spinOn, spinPivotRef, spinSpeed,
  } = deps.motion
  const scene = sceneRef.current // jen počáteční hodnoty stavu

  // kamera: uložené pohledy + DOF/FOV
  const [camViews, setCamViews] = useState<CamView[]>(() =>
    // Pohledy uložené dřív nemají id — doplň ho při načtení, ať se na ně popisky můžou odkazovat.
    (scene.initial.camViews ?? []).map((cv, i) => cv.id ? cv : { ...cv, id: `v${i}_${Date.now()}` }),
  )
  const [activeViewId, setActiveViewId] = useState<string | null>(null)   // pohled, ve kterém právě jsme
  // pohled, jehož název se právě přepisuje (nový nebo duplikovaný se otevře rovnou).
  // Pozor na `renamingId` níž — to je přejmenování OBJEKTU scény, jiná věc.
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null)

  // ── uložené pohledy kamery (přežijí refresh) ──
  function persistCamViews(vs: CamView[]) { setCamViews(vs); sceneRef.current.patchState({ camViews: vs }) }
  const currentLook = (): CamLook => ({ fov, dofOn, dofMode, dofFocal, dofBlur, dofRadius, dofFeather, shakeOn, shakeAmt, spinOn, spinSpeed })
  /**
   * Přejede vzhled na cílový během přeletu — stejně dlouho a stejnou easeInOut jako pohyb kamery,
   * takže obojí dosedne naráz.
   *
   * Nespojité věci se interpolovat nedají, každá se řeší jinak:
   *  - `dofMode` (kruh × vzdálenost) se rozhodne hned na začátku — mezi poloměrem kruhu a ohniskovou
   *    vzdáleností není co prolínat. Animují se pak už jen parametry cílového režimu.
   *  - `dofOn` se nepřepíná skokem: rozostření zůstane celou dobu zapnuté a přejíždí se jeho SÍLA
   *    z/na nulu, takže zapnutí i vypnutí vyblednou místo cvaknutí (stepSize 0 = žádné rozmazání).
   *  - `spinOn`/`spinSpeed` (kroužení) se do přeletu vůbec nemíchají: kameru po tu dobu řídí let,
   *    tak se zapnou až po doletu (drží je `spinHoldRef`) a vezmou si čerstvý střed pohledu.
   *  - `shakeOn`/`shakeAmt` jedou přes intenzitu jako rozostření (viz níž) — chvění patří k pohledu,
   *    takže se mezi záběry musí umět jak nasadit, tak utichnout.
   *
   * Stav Reactu se přepisuje AŽ na konci — nastavovat ho každý snímek by 3 s překreslovalo celou
   * komponentu. Slidery se proto rozhýbou až po doletu.
   */
  function animateCamLook(target: CamLook, dur = 3000) {
    // Při vypnuté prezentaci se efekty nezapínají — přílet na pohled by je jinak vrátil zpátky
    // a vypínač by nic neznamenal. Cílové hodnoty se ale schovají, takže zapnutí prezentace
    // navazuje na pohled, na kterém zrovna stojíš.
    let to = target
    if (!presentOn) {
      presentSnapRef.current = { dofOn: target.dofOn }
      to = { ...target, dofOn: false }
    }
    const from = currentLook()
    const token = ++lookAnimRef.current
    const mode = to.dofMode
    const anyDof = from.dofOn || to.dofOn
    const blurFrom = from.dofOn ? from.dofBlur : 0
    const blurTo = to.dofOn ? to.dofBlur : 0
    // Chvění se taky nepřepíná skokem: jede se přes jeho INTENZITU z/na nulu (stejný trik jako
    // u rozostření), takže se kamera rozechvěje i uklidní plynule místo cvaknutí. Chybějící
    // hodnoty (starší pohledy) znamenají vypnuto → přílet na takový pohled chvění zase utiší.
    const shakeFrom = from.shakeOn ? (from.shakeAmt ?? 0) : 0
    const shakeTo = to.shakeOn ? (to.shakeAmt ?? 0) : 0
    const anyShake = shakeFrom > 0 || shakeTo > 0
    const t0 = performance.now()
    const step = () => {
      const v = viewerRef.current
      if (!v || v.isDestroyed() || lookAnimRef.current !== token) return
      let t = (performance.now() - t0) / dur; if (t > 1) t = 1
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2   // stejná easeInOut jako orbit
      const mix = (a: number, b: number) => a + (b - a) * e
      applyFovRaw(mix(from.fov, to.fov))
      applyDofRaw({
        on: anyDof, mode,
        focal: mix(from.dofFocal, to.dofFocal), blur: mix(blurFrom, blurTo),
        radius: mix(from.dofRadius, to.dofRadius), feather: mix(from.dofFeather, to.dofFeather),
      })
      if (anyShake) shakeRef.current = { on: presentOn, amt: mix(shakeFrom, shakeTo) }
      if (t < 1) { requestAnimationFrame(step); return }
      // dosedni přesně na cíl a srovnej s ním stav ovládání
      setFov(to.fov)
      setDofOn(to.dofOn); setDofMode(to.dofMode); setDofFocal(to.dofFocal); setDofBlur(to.dofBlur)
      setDofRadius(to.dofRadius); setDofFeather(to.dofFeather)
      applyDofRaw({ on: to.dofOn, mode: to.dofMode, focal: to.dofFocal, blur: to.dofBlur, radius: to.dofRadius, feather: to.dofFeather })
      // amt si při vypnutém chvění nechá poslední hodnotu, ať slider nespadne na nulu
      setShakeOn(to.shakeOn ?? false); setShakeAmt(to.shakeAmt ?? shakeAmt)
      // Kroužení se nerozjíždí postupně jako chvění — nemá cenu ho míchat do přeletu, kde kameru
      // řídí let. Zapne se až po doletu (drží ho `spinHoldRef`) a vezme si čerstvý střed pohledu.
      setSpinOn(to.spinOn ?? false); setSpinSpeed(to.spinSpeed ?? spinSpeed)
    }
    requestAnimationFrame(step)
  }
  /**
   * Náhled pohledu — malý JPEG rovnou do stavu scény (proč ne do Storage viz `CamView.thumb`).
   * 160×90 stačí na to, aby se v seznamu poznal záběr, a vyjde na ~2 kB.
   */
  function captureViewThumb(v: Cesium.Viewer): string | undefined {
    try {
      renderNow(v) // obraz je v bufferu jen do konce tohohle kroku — kreslí se proto těsně před čtením
      const src = v.scene.canvas
      const c = document.createElement('canvas')
      c.width = VIEW_THUMB_W; c.height = VIEW_THUMB_H
      const ctx = c.getContext('2d')
      if (!ctx) return undefined
      // „cover": poměr stran zůstane, přebytek se ořízne — jinak by byl náhled roztažený
      const sr = src.width / src.height, dr = VIEW_THUMB_W / VIEW_THUMB_H
      const sw = sr > dr ? src.height * dr : src.width
      const sh = sr > dr ? src.height : src.width / dr
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, VIEW_THUMB_W, VIEW_THUMB_H)
      return c.toDataURL('image/jpeg', VIEW_THUMB_Q)
    } catch { return undefined } // náhled je bonus; kvůli němu ukládání pohledu spadnout nesmí
  }

  /** Aktuální kamera + vzhled + náhled jako tělo pohledu (společné pro uložení i přepsání). */
  function currentViewBody(v: Cesium.Viewer) {
    const c = v.camera, pos = c.positionWC
    return { dest: [pos.x, pos.y, pos.z] as [number, number, number], h: c.heading, p: c.pitch, r: c.roll, look: currentLook(), thumb: captureViewThumb(v) }
  }

  // Ukládá se HNED, bez předchozího psaní názvu. Dřív se muselo nejdřív vyplnit pole a teprve
  // pak kliknout — jenže záběr máš právě teď, kdežto pojmenovat ho jde i za pět minut. Nový
  // pohled proto dostane pracovní název a rovnou se otevře k přejmenování.
  function saveCamView() {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const id = `v${Date.now()}`
    persistCamViews([...camViews, { id, name: `Pohled ${camViews.length + 1}`, ...currentViewBody(v) }])
    setActiveViewId(id)
    setRenamingViewId(id)
  }
  /** přepíše kameru i vzhled uloženého pohledu aktuálním stavem (pohled zůstane na svém místě v seznamu) */
  function updateCamView(i: number) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    persistCamViews(camViews.map((cv, j) => j === i ? { ...cv, ...currentViewBody(v) } : cv))
  }
  function renameCamView(id: string, name: string) {
    const n = name.trim()
    if (n) persistCamViews(camViews.map(cv => cv.id === id ? { ...cv, name: n } : cv))
    setRenamingViewId(null)
  }
  /** Kopie i s náhledem — základ pro variantu záběru, kterou pak jen doladíš a přepíšeš. */
  function duplicateCamView(i: number) {
    const src = camViews[i]; if (!src) return
    const id = `v${Date.now()}`
    const copy = { ...src, id, name: `${src.name} (kopie)` }
    persistCamViews([...camViews.slice(0, i + 1), copy, ...camViews.slice(i + 1)])
    setRenamingViewId(id)
  }
  /** Přesun v seznamu — pohledy jsou scénář prezentace, takže na pořadí záleží. */
  function moveCamView(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= camViews.length || to >= camViews.length) return
    const next = [...camViews]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    persistCamViews(next)
  }
  /**
   * Sedí aktivní pohled na to, co je právě vidět?
   *
   * Tohle je jádro toho, co dřív chybělo: slidery zorného úhlu, rozostření, chvění a kroužení
   * JSOU vzhledem pohledu (jdou do `CamLook`), jenže když se s nimi hnulo, nic o tom neřeklo —
   * uložený pohled se tiše rozešel se skutečností a bylo na uživateli si vzpomenout na přepsání.
   *
   * Kamera se mění mimo React, takže se to přepočítá po dojetí pohybu (`moveEnd`); vzhled je
   * ve stavu, ten si React ohlídá sám.
   */
  const [camTick, setCamTick] = useState(0)
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const bump = () => setCamTick(t => t + 1)
    v.camera.moveEnd.addEventListener(bump)
    return () => { if (!v.isDestroyed()) v.camera.moveEnd.removeEventListener(bump) }
  }, [viewerReady])

  const activeDirty = useMemo(() => {
    void camTick // závislost schválně: kamera se hýbe mimo React a přepočet visí na moveEnd
    const v = viewerRef.current
    const cv = camViews.find(x => x.id === activeViewId)
    if (!v || v.isDestroyed() || !cv) return false
    const c = v.camera
    const moved = Cesium.Cartesian3.distance(c.positionWC, new Cesium.Cartesian3(cv.dest[0], cv.dest[1], cv.dest[2])) > VIEW_DIRTY_M
    // rozdíl úhlů přes hranici 0/360 musí vyjít malý, ne skoro celá otáčka
    const turned = (a: number, b: number) => {
      let d = Cesium.Math.toDegrees(a - b) % 360
      if (d > 180) d -= 360
      if (d < -180) d += 360
      return Math.abs(d) > VIEW_DIRTY_DEG
    }
    const rotated = turned(c.heading, cv.h) || turned(c.pitch, cv.p) || turned(c.roll, cv.r)
    // Starší pohledy `look` nemají — z jejich chybějícího vzhledu se „upraveno" dělat nesmí,
    // jinak by u nich svítilo pořád a nešlo by to nijak umlčet.
    const lookOff = !!cv.look && !sameLook(cv.look, currentLook())
    return moved || rotated || lookOff
  }, [camTick, camViews, activeViewId, fov, dofOn, dofMode, dofFocal, dofBlur, dofRadius, dofFeather, shakeOn, shakeAmt, spinOn, spinSpeed])

  /** Další/předchozí pohled — pro procházení scénáře při prezentaci (tlačítka i šipky). */
  function stepCamView(dir: 1 | -1) {
    if (!camViews.length) return
    const cur = camViews.findIndex(cv => cv.id === activeViewId)
    // bez aktivního pohledu začni od kraje podle směru, jinak cyklicky dokola
    const next = cur < 0 ? (dir === 1 ? 0 : camViews.length - 1) : (cur + dir + camViews.length) % camViews.length
    gotoCamView(camViews[next])
  }

  // Šipkami se dá projít scénář bez klikání do seznamu. Posluchač se registruje jednou a sahá
  // na aktuální `stepCamView` přes ref — jinak by se musel přepisovat při každé změně pohledů.
  const stepRef = useRef(stepCamView)
  useEffect(() => { stepRef.current = stepCamView })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      // v poli se šipkami posouvá kurzor — tam prezentace co dělat nemá
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      stepRef.current(e.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  function gotoCamView(cv: CamView) {
    setActiveViewId(cv.id)               // řídí, které popisky jsou vysunuté
    // Přelet trvá 3 s a kameru si po tu dobu řídí sám — kroužení musí počkat, jinak si přepisují
    // pozici. Pivot se zahodí, ať si po doletu vezme střed NOVÉHO pohledu, ne toho, odkud se letělo.
    spinHoldRef.current = performance.now() + 3200
    spinPivotRef.current = null
    if (cv.look) animateCamLook(cv.look) // starší pohledy `look` nemají → nastavení se nechá být
    if (orbitOn) orbitToCamView(cv); else gotoCamViewDirect(cv)
  }
  function gotoCamViewDirect(cv: CamView) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    orbitAnimRef.current++ // zruš případný běžící orbit
    v.camera.flyTo({ destination: new Cesium.Cartesian3(cv.dest[0], cv.dest[1], cv.dest[2]), orientation: { heading: cv.h, pitch: cv.p, roll: cv.r }, duration: 3 })
  }
  // Přelet OBLOUKEM: kamera obíhá po nejkratším oblouku kolem STŘEDU aktuálního pohledu a přitom se
  // pořád dívá na ten střed → objekt uprostřed zůstane uprostřed. Konec = pozice uloženého pohledu.
  function orbitToCamView(cv: CamView) {
    const v = viewerRef.current; if (!v || v.isDestroyed()) return
    const C3 = Cesium.Cartesian3, M3 = Cesium.Matrix3
    const g = viewCenterGround(v)
    const P = C3.fromDegrees(g.lon, g.lat, g.height)               // pivot = na co koukám
    const startPos = C3.clone(v.camera.positionWC, new C3())
    const endPos = new C3(cv.dest[0], cv.dest[1], cv.dest[2])
    const oS = C3.subtract(startPos, P, new C3()), oE = C3.subtract(endPos, P, new C3())
    const magS = C3.magnitude(oS), magE = C3.magnitude(oE)
    if (magS < 1 || magE < 1) { gotoCamViewDirect(cv); return }     // degenerace → přímý let

    // Kam se ULOŽENÝ pohled dívá (v ECEF). Počítá se stejně, jako to dělá Cesium v Camera.setView3D:
    // heading posunutý o -90°, ze vzniklé rotační matice je směr sloupec 0 — a to celé v ENU rámci
    // cílové pozice. (Přes pickPosition to nešlo: čte depth buffer minulého snímku, tedy staré kamery.)
    const hpr = new Cesium.HeadingPitchRoll(cv.h - Cesium.Math.PI_OVER_TWO, cv.p, cv.r)
    const rotM = M3.fromQuaternion(Cesium.Quaternion.fromHeadingPitchRoll(hpr, new Cesium.Quaternion()), new M3())
    const enuEnd = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(endPos), new M3())
    const endDir = C3.normalize(M3.multiplyByVector(enuEnd, M3.getColumn(rotM, 0, new C3()), new C3()), new C3())

    // Oblouk dává smysl JEN když se oba pohledy dívají zhruba na totéž — obíhá se přece kolem
    // společného předmětu. Když jsem si mezitím odletěl jinam po mapě, pivot s uloženým pohledem
    // nesouvisí a orbit kolem něj by skončil úplně jinde. Změř, jak daleko paprsek uloženého
    // pohledu míjí pivot; když moc, leť napřímo.
    const toP = C3.subtract(P, endPos, new C3())
    const along = C3.dot(toP, endDir)
    const miss = C3.magnitude(C3.subtract(toP, C3.multiplyByScalar(endDir, along, new C3()), new C3()))
    if (along <= 0 || miss > 0.35 * magE) { gotoCamViewDirect(cv); return }

    // orbit ve sférických souřadnicích ENU rámce pivotu: zvlášť AZIMUT (otáčení do strany) a NÁKLON
    // (elevace) + vzdálenost → kamera obíhá kolem BOKU, ne přes vršek (zenit).
    const enuR = Cesium.Matrix4.getMatrix3(Cesium.Transforms.eastNorthUpToFixedFrame(P), new M3())
    const enuRT = M3.transpose(enuR, new M3())
    const toLocal = (o: Cesium.Cartesian3) => M3.multiplyByVector(enuRT, C3.normalize(o, new C3()), new C3()) // ECEF→ENU
    const lS = toLocal(oS), lE = toLocal(oE)
    const azS = Math.atan2(lS.x, lS.y), azE = Math.atan2(lE.x, lE.y)                 // heading od severu
    const elS = Math.asin(Cesium.Math.clamp(lS.z, -1, 1)), elE = Math.asin(Cesium.Math.clamp(lE.z, -1, 1))
    let dAz = azE - azS; while (dAz > Math.PI) dAz -= 2 * Math.PI; while (dAz < -Math.PI) dAz += 2 * Math.PI // nejkratší

    // Orientace se interpoluje v heading/pitch/roll od SOUČASNÉ k uložené, a to stejnou easeInOut
    // jako pozice — tím jde otáčení i posun jedním gestem.
    //
    // Dřív se orientace držela „koukej na pivot" a na uloženou sjížděla až v posledních 45 %. To
    // dělalo trhnutí: pozice se kvůli easeInOut na konci téměř zastaví, takže se kamera dotáčela
    // (klidně o 19°) prakticky na místě. Interpolace headingu navíc změnu azimutu oblouku sama
    // kopíruje, takže když oba pohledy míří na týž předmět, zůstane uprostřed i bez dohánění.
    const hS = v.camera.heading, pS = v.camera.pitch, rS = v.camera.roll
    const shortest = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
    // Heading musí točit na TUTÉŽ stranu, kam obíhá pozice. Dřív se obojí rozhodovalo zvlášť
    // („nejkratší cesta“ pro azimut oblouku a nezávisle na tom pro heading) a u protilehlých
    // pohledů, kde je rozdíl kolem 180°, si to sem tam zvolilo opačná znaménka — kamera pak
    // obíhala doleva a otáčela se doprava, tedy se cestou přestala dívat na předmět a dotočila
    // se až na konci. Základ je proto swing oblouku a k němu jen nejkratší ZBYTEK, aby se
    // pořád dosedlo přesně na uložený heading.
    const dH = dAz + shortest(cv.h - hS - dAz), dP = cv.p - pS, dR = shortest(cv.r - rS)

    const token = ++orbitAnimRef.current
    const dur = 3000, t0 = performance.now(), tmp = new C3()
    const step = () => {
      if (v.isDestroyed() || orbitAnimRef.current !== token) return
      let t = (performance.now() - t0) / dur; if (t > 1) t = 1
      if (t >= 1) {
        // Dosedni PŘESNĚ na uložený pohled, ne na dopočítanou orientaci — jinak kamera skončí na
        // správné pozici, ale natočená na starý pivot, což vypadá, jako by doletěla někam jinam.
        v.camera.setView({ destination: endPos, orientation: { heading: cv.h, pitch: cv.p, roll: cv.r } })
        return
      }
      const te = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2   // easeInOut
      const az = azS + dAz * te, el = elS + (elE - elS) * te, rng = magS + (magE - magS) * te
      const ch = Math.cos(el)
      const arc = M3.multiplyByVector(enuR, new C3(Math.sin(az) * ch, Math.cos(az) * ch, Math.sin(el)), new C3()) // ENU→ECEF
      const pos = C3.add(P, C3.multiplyByScalar(arc, rng, tmp), new C3())
      v.camera.setView({ destination: pos, orientation: { heading: hS + dH * te, pitch: pS + dP * te, roll: rS + dR * te } })
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  // Smazání pohledu s sebou vezme i vazby popisků, které na něm visely. Dřív zmizely
  // tiše a nebylo je jak vrátit — proto se ptáme a rovnou řekneme, čeho se to týká.
  async function delCamView(i: number) {
    const gone = camViews[i]; if (!gone) return
    const { callouts: nc } = viewRefs(gone.id)
    if (!(await ask({
      title: `Smazat pohled „${gone.name}"?`,
      message: nc ? `Přestane se v něm ukazovat ${nc}× popisek (popisky samy zůstanou).` : undefined,
      okLabel: 'Smazat', danger: true,
    }))) return
    persistCamViews(camViews.filter((_, j) => j !== i))
    onViewDeleted(gone.id)
    if (activeViewId === gone.id) setActiveViewId(null)
  }

  return {
    activeDirty,
    activeViewId,
    camViews,
    delCamView,
    duplicateCamView,
    gotoCamView,
    moveCamView,
    renameCamView,
    renamingViewId,
    saveCamView,
    setActiveViewId,
    setRenamingViewId,
    stepCamView,
    updateCamView,
  }
}
