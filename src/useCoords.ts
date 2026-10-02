/**
 * Odečet souřadnic bodů z mapy (S-JTSK + Bpv) pro přenos do Maxu / SynthEyes — viz coords.tsx.
 */
import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { toast } from 'sonner'
import { toolTheme } from './toolColors'
import { geoidN } from './geoid'
import { sjtskOf } from './tiles'
import { fetchElevSamplerSJTSK } from './elevation'
import { pickGround } from './sceneUtils'
import type { CoordPoint } from './lib/types'
import type { ScenePersist } from './lib/scenePersist'

/** barva odečtených bodů v mapě — nastavuje se v toolColors.ts */
const COORD_COLOR = Cesium.Color.fromCssColorString(toolTheme('coords').map)

export type CoordsTool = ReturnType<typeof useCoords>

export function useCoords(deps: {
  viewerRef: React.RefObject<Cesium.Viewer | null>
  viewerReady: boolean
  sceneRef: React.RefObject<ScenePersist>
  coordsMode: boolean
}) {
  const { viewerRef, viewerReady, sceneRef, coordsMode } = deps
  const scene = sceneRef.current // jen počáteční hodnoty stavu

  const [coordPts, setCoordPts] = useState<CoordPoint[]>(() => scene.initial.coords?.pts ?? [])
  const [coordShift, setCoordShift] = useState<[number, number, number]>(() => scene.initial.coords?.shift ?? [0, 0, 0])
  const coordEntsRef = useRef<Map<string, Cesium.Entity>>(new Map())

  // Značky patřily vieweru, který zaniká spolu s komponentou. Při změně se jen posouvají, ne
  // staví znovu — se zapomenutými entitami starého vieweru by nový (StrictMode, návrat do
  // scény) žádné neukázal.
  useEffect(() => () => coordEntsRef.current.clear(), [])

  /**
   * Odečet bodu z mapy → S-JTSK + Bpv, tedy soustava exportovaného terénu.
   *
   * Výška se čte PŘÍMO z ČÚZK DMR 5G, ne z terénu v Cesiu. Dva důvody, oba podstatné:
   *
   *  - Cesium to u našeho vlastního terénního provideru ani neumí: `sampleTerrainMostDetailed`
   *    sahá na `terrainProvider.availability`, které `makeDmrTerrain` nemá, a spadne na
   *    „Cannot read properties of undefined (reading 'computeMaximumLevelAtPosition')".
   *  - I kdyby fungovalo, vracelo by výšku z právě vykreslené úrovně terénu, tedy při oddáleném
   *    pohledu hrubou.
   *
   * ČÚZK vrátí přesnou hodnotu, a hlavně TU SAMOU, ze které se počítá export — čísla z panelu
   * pak sedí s modelem v Maxu. Vrací syrové Bpv bez geoidu, takže se nic nepřepočítává; geoid
   * se přičítá jen u značky v mapě, protože Cesium kreslí nad elipsoidem.
   */
  /** Přesná výška z ČÚZK pro bod v S-JTSK. Společné pro přidání i přetažení. */
  async function cuzkHeight(x: number, y: number): Promise<number | null> {
    // malý výřez kolem bodu — DMR 5G má body po ~5 m, 20m okno na 8 px bohatě stačí
    const sample = await fetchElevSamplerSJTSK('dmr5g', x - 10, y - 10, x + 10, y + 10, 8, 8)
    return sample(x, y)
  }

  /** Souřadnice + výška pro dané místo, nebo null když se to nepovede (hlášku už ukázala). */
  async function coordAt(lon: number, lat: number): Promise<{ x: number; y: number; z: number } | null> {
    const [x, y] = sjtskOf(lon, lat)
    let z: number | null = null
    try {
      z = await cuzkHeight(x, y)
    } catch (e) {
      console.error('Dotažení výšky z ČÚZK selhalo:', e)
      toast.error('Výšku se nepodařilo dotáhnout z ČÚZK')
      return null
    }
    if (z == null) { toast.error('ČÚZK pro to místo nemá výšku (mimo pokrytí?)'); return null }
    return { x, y, z }
  }

  async function addCoordPoint(lon: number, lat: number) {
    const c = await coordAt(lon, lat)
    if (!c) return
    persistCoords([...coordPts, { id: `c${Date.now()}`, ...c, lon, lat }], coordShift)
    toast.success(`Bod: ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${c.z.toFixed(2)}`)
  }

  /**
   * Bod přetažený jinam. Během tažení jede značka za myší po vykresleném terénu (rychlé, ale
   * hrubé); přesná výška se dotáhne z ČÚZK teprve po puštění, ať se neposílá dotaz na každý pohyb.
   */
  async function moveCoordPoint(id: string, lon: number, lat: number) {
    const c = await coordAt(lon, lat)
    if (!c) return
    persistCoords(coordPts.map(p => (p.id === id ? { ...p, ...c, lon, lat } : p)), coordShift)
    toast.success(`Přesunuto: ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${c.z.toFixed(2)}`)
  }

  function persistCoords(pts: CoordPoint[], shift: [number, number, number]) {
    setCoordPts(pts); setCoordShift(shift)
    sceneRef.current.patchState({ coords: { pts, shift } })
  }

  /**
   * Klikání a tažení odečtených bodů — stejný vzorec jako u měření.
   *
   * Tažení má přednost: LEFT_DOWN se nejdřív podívá, jestli pod kurzorem není existující značka.
   * Když je, vypne se ovládání kamery a bod jede za myší; teprve když není, přidá se nový až na
   * LEFT_CLICK, tedy po puštění.
   *
   * `justDragged` je pojistka proti tomu, že Cesium pošle LEFT_CLICK i po velmi krátkém tažení —
   * bez ní by drobné posunutí bodu rovnou vyrobilo další bod na tomtéž místě.
   */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed() || !coordsMode) return
    const handler = new Cesium.ScreenSpaceEventHandler(v.scene.canvas)
    const ssc = v.scene.screenSpaceCameraController
    let dragId: string | null = null
    let justDragged = false

    const idAt = (screen: Cesium.Cartesian2): string | null => {
      const picked = v.scene.pick(screen) as { id?: unknown } | undefined
      const ent = picked?.id
      if (!ent) return null
      for (const [id, e] of coordEntsRef.current) if (e === ent) return id
      return null
    }

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      justDragged = false
      const id = idAt(e.position)
      if (!id) return
      dragId = id
      ssc.enableInputs = false
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (!dragId) return
      const g = pickGround(v, e.endPosition)
      const ent = coordEntsRef.current.get(dragId)
      if (g && ent) ent.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height))
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    handler.setInputAction(() => {
      if (!dragId) return
      const id = dragId
      dragId = null
      justDragged = true
      ssc.enableInputs = true
      const pos = coordEntsRef.current.get(id)?.position?.getValue(Cesium.JulianDate.now())
      if (!pos) return
      const c = Cesium.Cartographic.fromCartesian(pos)
      void moveCoordPoint(id, Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude))
    }, Cesium.ScreenSpaceEventType.LEFT_UP)

    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (dragId || justDragged) return // klik bezprostředně po tažení nový bod nepřidává
      if (idAt(e.position)) return      // klik na existující značku taky ne
      const g = pickGround(v, e.position)
      if (g) void addCoordPoint(g.lon, g.lat)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    return () => { handler.destroy(); ssc.enableInputs = true }
  }, [coordsMode, coordPts, coordShift])

  // značky odečtených bodů — překreslí se, kdykoliv se seznam změní
  useEffect(() => {
    const v = viewerRef.current
    if (!v || v.isDestroyed()) return
    for (const [id, ent] of coordEntsRef.current) {
      if (!coordPts.some(p => p.id === id)) { v.entities.remove(ent); coordEntsRef.current.delete(id) }
    }
    coordPts.forEach((p, i) => {
      // body držíme v Bpv, Cesium kreslí nad elipsoidem
      const at = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.z + geoidN(p.lon, p.lat))
      const has = coordEntsRef.current.get(p.id)
      if (has) {
        // po přetažení sedí značka tam, kam ji dotáhla myš — srovnat na přesnou výšku z ČÚZK
        has.position = new Cesium.ConstantPositionProperty(at)
        if (has.label) has.label.text = new Cesium.ConstantProperty(String(i + 1))
        return
      }
      const ent = v.entities.add({
        position: at,
        point: { pixelSize: 9, color: COORD_COLOR, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: String(i + 1), font: '11px sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 2, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      coordEntsRef.current.set(p.id, ent)
    })
  }, [coordPts, viewerReady])

  return {
    coordPts,
    coordShift,
    persistCoords,
  }
}
