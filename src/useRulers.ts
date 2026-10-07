/**
 * Ruční měření vzdáleností a ploch.
 *
 * Hotová měření žijí ve stavu (a ukládají se do scény), rozkreslené se pozná podle `rulerDraftId`.
 * Vrstva si kreslení řídí sama (ruler.ts) a čte živá data, takže tažení bodu nemusí přes React.
 *
 * Přichycení: při kreslení se klik kousek od existujícího bodu (`SNAP_PX`) přichytí přesně na
 * něj. Klik na PRVNÍ bod rozkresleného měření ho uzavře a dokončí (čára se vrátí do začátku,
 * plocha je uzavřená vždy), klik na POSLEDNÍ bod ho jen dokončí. Bod, kam klik skočí, se při
 * najetí zvětší a nápověda v liště řekne, co klik udělá.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { pickGround } from './sceneUtils'
import { RulerLayer, type Ruler as RulerData, type RulerHit, type RulerPoint } from './ruler'
import type { MapClickOwner } from './types'
import type { ScenePersist } from './lib/scenePersist'

export type RulersTool = ReturnType<typeof useRulers>

/** Jak daleko od bodu (CSS px) se klik ještě přichytí na něj. */
const SNAP_PX = 12
/** Posun myši (px), od kterého je stisk na bodu tažení, a ne klik. */
const DRAG_PX = 4

/** Co udělá klik, ke kterému se myš zrovna přichytila — pro nápovědu v liště. */
export type RulerSnap = 'close' | 'finish' | 'point' | null

export function useRulers(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  viewerReady: boolean
  sceneRef: React.RefObject<ScenePersist>
  rulerMode: boolean
  claimMapClick: (owner: MapClickOwner) => void
  setClickOwner: React.Dispatch<React.SetStateAction<MapClickOwner>>
}) {
  const { viewerRef, viewerReady, sceneRef, rulerMode, claimMapClick, setClickOwner } = deps
  const scene = sceneRef.current // jen počáteční hodnoty stavu

  const [rulerKind, setRulerKind] = useState<'line' | 'area'>('line') // co založí další klik do prázdna
  const [rulers, setRulers] = useState<RulerData[]>(() => scene.initial.rulers ?? [])
  const [rulerDraftId, setRulerDraftId] = useState<string | null>(null)
  const [rulerSel, setRulerSel] = useState<string | null>(null)
  const [rulerSnap, setRulerSnap] = useState<RulerSnap>(null)
  const rulerLayerRef = useRef<RulerLayer | null>(null)
  const rulersRef = useRef(rulers); rulersRef.current = rulers
  const rulerDraftRef = useRef<string | null>(null); rulerDraftRef.current = rulerDraftId
  const kindRef = useRef(rulerKind); kindRef.current = rulerKind

  // ── měření: vrstva, ukládání a ovládání myší ────────────────────────────────────────────────
  function persistRulers(rs: RulerData[]) {
    setRulers(rs)
    sceneRef.current.patchState({ rulers: rs })
  }

  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    const layer = new RulerLayer(v)
    rulerLayerRef.current = layer
    return () => { layer.destroy(); rulerLayerRef.current = null }
  }, [viewerReady])

  useEffect(() => { rulerLayerRef.current?.sync(rulers, rulerSel) }, [rulers, rulerSel, viewerReady])

  /**
   * Klikání a tažení bodů měření.
   *
   * Tažení má přednost před přidáním bodu: LEFT_DOWN se nejdřív podívá, jestli pod kurzorem není
   * existující bod. Když je, vypne se ovládání kamery a bod jede za myší; teprve když není, nechá
   * se událost projít a bod se přidá až na LEFT_CLICK (tedy po puštění, ne při tažení kamery).
   *
   * Během tažení se zapisuje rovnou do živých dat vrstvy — do Reactu se výsledek propíše až po
   * puštění, jinak by se při každém pohybu myší překresloval celý panel.
   *
   * Bod se bere z povrchu i s výškou (`pickGround` čte terén, modely i Google dlaždice), takže
   * měření sedí i na svahu a na budově.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !rulerMode) return
    const layer = rulerLayerRef.current
    if (!layer) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    const ssc = v.scene.screenSpaceCameraController
    const canvas = v.scene.canvas
    // Stisk na bodu je zatím jen „možná tažení": tažením se teprve stane až po pár pixelech.
    // Puštění bez pohybu je klik na bod (přichycení, uzavření, dokončení měření).
    let press: { hit: RulerHit; x: number; y: number } | null = null
    let drag: RulerHit | null = null
    let snapped: RulerHit | null = null
    // Cesium pošle LEFT_CLICK i po velmi krátkém tažení (nepřekročí práh pohybu). Bez téhle
    // pojistky by drobné posunutí bodu rovnou přidalo další bod na totéž místo.
    // Nuluje se při KAŽDÉM stisku, ne až v kliku — po opravdovém tažení totiž LEFT_CLICK vůbec
    // nepřijde a příznak by zůstal viset, takže by spolkl další klik.
    let justDragged = false

    const pointAt = (screen: Cesium.Cartesian2): RulerPoint | null => {
      const g = pickGround(v, screen)
      return g ? [g.lon, g.lat, g.height] : null
    }

    /** Co by klik na tenhle bod udělal s rozkresleným měřením (viz `clickPoint`). */
    const snapKind = (h: RulerHit | null): RulerSnap => {
      const d = h && rulersRef.current.find(r => r.id === rulerDraftRef.current)
      if (!h || !d) return null
      if (h.id === d.id && h.idx === 0) return d.pts.length >= 3 ? 'close' : d.pts.length === 1 ? 'finish' : null
      if (h.id === d.id && h.idx === d.pts.length - 1) return 'finish'
      return 'point'
    }
    /** Přichycení pod myší: zvětšený bod, kurzor a nápověda — mění se, jen když se opravdu změní. */
    const showSnap = (h: RulerHit | null) => {
      const kind = snapKind(h)
      const target = kind ? h : null
      if (target?.id === snapped?.id && target?.idx === snapped?.idx) return
      snapped = target
      layer.setSnap(target)
      canvas.style.cursor = target ? 'pointer' : ''
      setRulerSnap(kind)
    }

    /**
     * Klik na existující bod. Bez rozkresleného měření jen výběr (jako dřív). Při kreslení:
     * první bod měření uzavře a dokončí, poslední ho dokončí, jakýkoliv jiný bod (i z jiného
     * měření) se přidá jako další bod přesně na jeho místo.
     */
    const clickPoint = (h: RulerHit) => {
      const d = rulersRef.current.find(r => r.id === rulerDraftRef.current)
      if (!d) return
      const kind = snapKind(h)
      if (kind === 'close') {
        if (d.kind !== 'area') persistRulers(rulersRef.current.map(r => r.id === d.id ? { ...r, closed: true } : r))
        setRulerDraftId(null)
      } else if (kind === 'finish') {
        finishRuler()
      } else if (kind === 'point') {
        const src = rulersRef.current.find(r => r.id === h.id)?.pts[h.idx]
        if (src) persistRulers(rulersRef.current.map(r => r.id === d.id ? { ...r, pts: [...r.pts, [...src] as RulerPoint] } : r))
      }
      showSnap(null) // měření se změnilo — co klik udělá, se při dalším pohybu spočítá znovu
    }

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      justDragged = false
      const h = layer.hit(v.scene.pick(e.position))
      if (!h) return
      press = { hit: h, x: e.position.x, y: e.position.y }
      ssc.enableInputs = false // stisk na bodu nesmí zároveň otáčet mapou
      setRulerSel(h.id)
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (press && !drag && Math.hypot(e.endPosition.x - press.x, e.endPosition.y - press.y) > DRAG_PX) {
        drag = press.hit
        layer.setDragging(drag) // tažený bod nesmí zakrýt model pod kurzorem (viz setDragging)
        showSnap(null)
      }
      if (drag) {
        const p = pointAt(e.endPosition)
        if (p) layer.liveMove(drag.id, drag.idx, p)
        return
      }
      if (!press) showSnap(rulerDraftRef.current ? layer.nearest(e.endPosition, SNAP_PX) : null)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction(() => {
      const wasPress = press
      press = null
      ssc.enableInputs = true
      if (drag) {
        const moved = drag
        drag = null
        layer.setDragging(null)
        justDragged = true
        // živá data vrstvy jsou zdroj pravdy — přepiš z nich stav, ať se posun uloží
        persistRulers(rulersRef.current.map(r => r.id === moved.id ? { ...r, pts: [...r.pts] } : r))
      } else if (wasPress) {
        justDragged = true // LEFT_CLICK, který po tomhle přijde, už bod nepřidá
        clickPoint(wasPress.hit)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_UP)

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (drag || justDragged) return // klik bezprostředně po tažení bod nepřidává
      if (layer.hit(v.scene.pick(e.position))) return
      // kousek vedle tečky: přichytit na nejbližší bod
      const near = rulerDraftRef.current ? layer.nearest(e.position, SNAP_PX) : null
      if (near && snapKind(near)) { clickPoint(near); return }
      const p = pointAt(e.position)
      if (!p) { toast.error('Tady není povrch — klikni na terén nebo model'); return }
      const draft = rulerDraftRef.current
      if (draft) {
        persistRulers(rulersRef.current.map(r => r.id === draft ? { ...r, pts: [...r.pts, p] } : r))
      } else {
        const id = `m${Date.now()}`
        persistRulers([...rulersRef.current, { id, name: `${kindRef.current === 'area' ? 'Plocha' : 'Měření'} ${rulersRef.current.length + 1}`, pts: [p], kind: kindRef.current }])
        setRulerDraftId(id)
        setRulerSel(id)
      }
      showSnap(null)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    // pravý klik ukončí rozkreslené měření (kreslení dál pokračuje novým)
    handler.setInputAction(() => { finishRuler(); showSnap(null) }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

    return () => {
      handler.destroy()
      ssc.enableInputs = true
      layer.setSnap(null)
      layer.setDragging(null)
      canvas.style.cursor = ''
      setRulerSnap(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulerMode])

  /** Ukončí rozkreslené měření. Zahodí nedodělky, které nic neměří: čáru o jednom bodu
   *  a plochu, která nemá aspoň tři body (dvěma body se plocha vymezit nedá). */
  function finishRuler() {
    const draft = rulerDraftRef.current
    if (!draft) return
    const r = rulersRef.current.find(x => x.id === draft)
    const need = r?.kind === 'area' ? 3 : 2
    if (r && r.pts.length < need) persistRulers(rulersRef.current.filter(x => x.id !== draft))
    setRulerDraftId(null)
  }

  /** Zapnutí měření vypne ostatní klikací režimy — jinak by jeden klik dělal dvě věci naráz.
   *  Hotová měření v mapě ale zůstávají, ta na režimu nezávisí. */
  function startRuler(kind: 'line' | 'area') {
    if (rulerMode && rulerKind === kind) { setClickOwner('none'); return }
    finishRuler()                 // rozkreslené se ukončí, i když se jen přepíná druh
    setRulerKind(kind)
    claimMapClick('ruler')
    setClickOwner('ruler')
  }

  function delRuler(id: string) {
    persistRulers(rulersRef.current.filter(r => r.id !== id))
    if (rulerDraftRef.current === id) setRulerDraftId(null)
    if (rulerSel === id) setRulerSel(null)
  }

  function clearRulers() {
    persistRulers([])
    setRulerDraftId(null)
    setRulerSel(null)
  }

  return {
    clearRulers,
    delRuler,
    finishRuler,
    rulerDraftId,
    rulerKind,
    rulerSel,
    rulerSnap,
    rulers,
    setRulerSel,
    startRuler,
  }
}
