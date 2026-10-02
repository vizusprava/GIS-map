/**
 * Prezentační popisky (tečka + čára + bublina) navázané na uložené pohledy — vysunou se jen
 * v pohledech, ke kterým patří, a jen se zapnutou prezentací.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { pickGround } from './sceneUtils'
import type { Callout } from './callouts'
import type { MapClickOwner } from './types'
import type { ScenePersist } from './lib/scenePersist'

export type PresentationTool = ReturnType<typeof usePresentation>

export function usePresentation(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  viewerReady: boolean
  sceneRef: React.RefObject<ScenePersist>
  calloutMode: boolean
  activeViewId: string | null
  presentOn: boolean
  releaseMapClick: (who: MapClickOwner) => void
}) {
  const { viewerRef, sceneRef, calloutMode, activeViewId, presentOn, releaseMapClick } = deps
  const scene = sceneRef.current // jen počáteční hodnoty stavu

  const [callouts, setCallouts] = useState<Callout[]>(() => scene.initial.callouts ?? [])
  const [calloutSel, setCalloutSel] = useState<string | null>(null)
  // vzhled posledně upravovaného popisku → nový ho zdědí, ať se nemusí stylovat pokaždé znovu
  const calloutStyleRef = useRef<Pick<Callout, 'dot' | 'frame' | 'size'>>({})

  // Režim přidání popisku: klik do mapy položí kotvu. Popisek se rovnou přiřadí aktivnímu pohledu,
  // aby po vytvoření hned vyjel — jinak by uživatel udělal popisek a nic by se nestalo.
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !calloutMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    handler.setInputAction((evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const g = pickGround(v, evt.position)
      if (!g) { toast.info('Tady se nepodařilo najít povrch'); return }
      const p = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
      const last = calloutStyleRef.current
      const c: Callout = { id: `c${Date.now()}`, text: 'Nový popisek', anchor: [p.x, p.y, p.z], off: [110, -80], views: activeViewId ? [activeViewId] : [], ...last }
      setCallouts(prev => { const next = [...prev, c]; saveCallouts(next); return next })  // funkční tvar → efekt nemusí viset na `callouts`
      setCalloutSel(c.id)
      releaseMapClick('callout')
      if (!activeViewId) toast.info('Popisek vznikl, ale není vybraný žádný pohled — zůstane zasunutý')
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [calloutMode, activeViewId])

  // ── prezentační popisky (tečka + čára + bublina), vázané na uložené pohledy ──
  function saveCallouts(cs: Callout[]) { sceneRef.current.patchState({ callouts: cs }) }
  function persistCallouts(cs: Callout[]) { setCallouts(cs); saveCallouts(cs) }
  function updateCallout(id: string, patch: Partial<Callout>) {
    if (patch.dot || patch.frame || patch.size) {
      const { dot, frame, size } = { ...calloutStyleRef.current, ...patch }
      calloutStyleRef.current = { dot, frame, size }
    }
    persistCallouts(callouts.map(c => c.id === id ? { ...c, ...patch } : c))
  }
  function delCallout(id: string) { persistCallouts(callouts.filter(c => c.id !== id)); if (calloutSel === id) setCalloutSel(null) }
  /** zapne/vypne popisek v PRÁVĚ aktivním pohledu */
  function toggleCalloutHere(id: string, on: boolean) {
    if (!activeViewId) return
    persistCallouts(callouts.map(c => c.id !== id ? c
      : { ...c, views: on ? [...new Set([...c.views, activeViewId])] : c.views.filter(x => x !== activeViewId) }))
  }

  /** Kolik popisků visí na pohledu. */
  function viewRefs(viewId: string) {
    return { callouts: callouts.filter(c => c.views.includes(viewId)).length }
  }

  /** Smazaný pohled: popisky na něm přestanou viset (samy zůstanou). */
  function forgetView(viewId: string) {
    persistCallouts(callouts.map(c => c.views.includes(viewId) ? { ...c, views: c.views.filter(x => x !== viewId) } : c))
  }

  // vysunuté jsou jen popisky patřící aktivnímu pohledu; bez pohledu nesvítí nic
  const visibleCallouts = new Set(presentOn && activeViewId ? callouts.filter(c => c.views.includes(activeViewId)).map(c => c.id) : [])

  return {
    calloutSel,
    callouts,
    delCallout,
    forgetView,
    setCalloutSel,
    toggleCalloutHere,
    updateCallout,
    viewRefs,
    visibleCallouts,
  }
}
