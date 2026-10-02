/**
 * Prezentační prvky navázané na uložené pohledy: popisky (tečka + čára + bublina) a pulzující
 * zvýraznění parcel. Vysunou / spustí se jen v pohledech, ke kterým patří.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { pickGround } from './sceneUtils'
import { PulseLayer, PULSE_COLOR_DEFAULT, PULSE_COUNT_DEFAULT, type PulseSet } from './pulse'
import type { Callout } from './callouts'
import type { MapClickOwner, ParcelEntry } from './types'
import type { ScenePersist } from './lib/scenePersist'

export type PresentationTool = ReturnType<typeof usePresentation>

export function usePresentation(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  viewerReady: boolean
  sceneRef: React.RefObject<ScenePersist>
  calloutMode: boolean
  activeViewId: string | null
  presentOn: boolean
  parcelsRef: React.RefObject<Map<string, ParcelEntry>>
  releaseMapClick: (who: MapClickOwner) => void
}) {
  const { viewerRef, viewerReady, sceneRef, calloutMode, activeViewId, presentOn, parcelsRef, releaseMapClick } = deps
  const scene = sceneRef.current // jen počáteční hodnoty stavu

  const [callouts, setCallouts] = useState<Callout[]>(() => scene.initial.callouts ?? [])
  const [calloutSel, setCalloutSel] = useState<string | null>(null)
  // vzhled posledně upravovaného popisku → nový ho zdědí, ať se nemusí stylovat pokaždé znovu
  const calloutStyleRef = useRef<Pick<Callout, 'dot' | 'frame' | 'size'>>({})
  const [pulses, setPulses] = useState<PulseSet[]>(() => scene.initial.pulses ?? [])
  const [pulseColor, setPulseColor] = useState(PULSE_COLOR_DEFAULT)
  const [pulseCount, setPulseCount] = useState(PULSE_COUNT_DEFAULT)
  const pulseLayerRef = useRef<PulseLayer | null>(null)

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

  useEffect(() => {
    const v = viewerRef.current
    if (!viewerReady || !v || v.isDestroyed()) return
    const layer = new PulseLayer(v)
    pulseLayerRef.current = layer
    layer.sync(pulses)
    return () => { layer.destroy(); pulseLayerRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady])
  useEffect(() => { pulseLayerRef.current?.sync(pulses) }, [pulses])

  // ── pulzující zvýraznění parcel ──
  function persistPulses(ps: PulseSet[]) { setPulses(ps); sceneRef.current.patchState({ pulses: ps }) }
  /** Okopíruje prstence PRÁVĚ vybraných parcel do nové sady — od té chvíle je na výběru nezávislá. */
  function addPulseFromSelection() {
    const rings = [...parcelsRef.current.values()]
      .map(p => p.ring.map(([lo, la]) => [lo, la] as [number, number]))
      .filter(r => r.length >= 3)
    if (!rings.length) { toast.error('Nejdřív vyber parcely'); return }
    const set: PulseSet = { id: `pl${Date.now()}`, name: `${rings.length}× parcela`, rings, color: pulseColor, count: pulseCount, views: activeViewId ? [activeViewId] : [] }
    persistPulses([...pulses, set])
    if (!activeViewId) toast.info('Sada vznikla, ale není vybraný pohled — nemá se kde spustit')
  }
  function delPulse(id: string) { persistPulses(pulses.filter(p => p.id !== id)) }
  /** úprava už vytvořené sady — barva se přebarví za běhu, geometrie se nepřestavuje */
  function updatePulse(id: string, patch: Partial<PulseSet>) { persistPulses(pulses.map(p => p.id === id ? { ...p, ...patch } : p)) }
  function togglePulseHere(id: string, on: boolean) {
    if (!activeViewId) return
    persistPulses(pulses.map(p => p.id !== id ? p
      : { ...p, views: on ? [...new Set([...p.views, activeViewId])] : p.views.filter(x => x !== activeViewId) }))
  }
  function playPulse(id: string) { pulseLayerRef.current?.trigger(new Set([id])) }

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

  /** Spustí pulzy patřící k pohledu (null = zastavit všechny). Pulz je primitiv — musí se říct hned. */
  function triggerPulses(viewId: string | null) {
    pulseLayerRef.current?.trigger(new Set(viewId ? pulses.filter(p => p.views.includes(viewId)).map(p => p.id) : []))
  }

  /** Kolik popisků a pulzů visí na pohledu. */
  function viewRefs(viewId: string) {
    return {
      callouts: callouts.filter(c => c.views.includes(viewId)).length,
      pulses: pulses.filter(p => p.views.includes(viewId)).length,
    }
  }

  /** Smazaný pohled: popisky a pulzy na něm přestanou viset (samy zůstanou). */
  function forgetView(viewId: string) {
    persistCallouts(callouts.map(c => c.views.includes(viewId) ? { ...c, views: c.views.filter(x => x !== viewId) } : c))
    persistPulses(pulses.map(p => p.views.includes(viewId) ? { ...p, views: p.views.filter(x => x !== viewId) } : p))
  }

  // vysunuté jsou jen popisky patřící aktivnímu pohledu; bez pohledu nesvítí nic
  const visibleCallouts = new Set(presentOn && activeViewId ? callouts.filter(c => c.views.includes(activeViewId)).map(c => c.id) : [])

  return {
    addPulseFromSelection,
    calloutSel,
    callouts,
    delCallout,
    delPulse,
    forgetView,
    playPulse,
    pulseColor,
    pulseCount,
    pulses,
    setCalloutSel,
    setPulseColor,
    setPulseCount,
    toggleCalloutHere,
    togglePulseHere,
    triggerPulses,
    updateCallout,
    updatePulse,
    viewRefs,
    visibleCallouts,
  }
}
