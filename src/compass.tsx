/**
 * Kompas — kam se kamera dívá vůči světovým stranám, a kliknutím na písmeno pohled tím směrem.
 *
 * Růžice se otáčí o `-heading`: nahoře je vždycky směr pohledu (tam ukazuje i pevná modrá ryska)
 * a písmena se pod ní protáčejí, takže S míří na skutečný sever.
 *
 * Písmena se ale s růžicí NEPŘEKLÁPĚJÍ — každé se kolem svého místa otočí zpátky nahoru. Na
 * papírové růžici se točí celá, jenže tady jsou 9 px vysoká a otočené „Z" je k nerozeznání od
 * „N": při pohledu k západu by kompas ukazoval sever přesně tam, kde není. Ověřeno vyrenderováním.
 *
 * Kreslí se PŘÍMO do atributů SVG, ne přes React state: heading se mění každý snímek a překreslovat
 * kvůli tomu strom MapView (tisíce řádků) by bylo trestuhodné. Stejný důvod jako u popisků.
 *
 * POZOR na volbu události — a je to PŘESNĚ NAOPAK než u popisků (viz callouts.tsx): „kamera z ruky"
 * naklání kameru v `preRender` a v `postRender` ji vrací zpátky. Popisky se musí trefit do snímku,
 * takže potřebují tu rozechvělou kameru z `preRender`. Kompas chce naopak to skutečné natočení —
 * v `preRender` by se s chvěním klepal (~1°) a při každém snímku zbytečně přepisoval DOM.
 */
import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { viewCenterGround } from './sceneUtils'

/** menší změny než tohle (ve stupních) nemá cenu psát do DOMu — na 64 px stejně nejsou vidět */
const MIN_STEP_DEG = 0.15

/**
 * Světové strany po obvodu růžice. `x`/`y` je zároveň střed, kolem kterého se písmeno narovnává
 * A střed jeho klikací plochy — kolečko v tom bodě je vůči otáčení růžice neměnné, takže sedí
 * na písmenu v každém natočení. `deg` je azimut, na který se pohled otočí po kliknutí.
 */
const MARKS = [
  { t: 'S', deg: 0, name: 'sever', x: 32, y: 16, fill: '#fca5a5' },
  { t: 'V', deg: 90, name: 'východ', x: 52, y: 36, fill: '#9ca3af' },
  { t: 'J', deg: 180, name: 'jih', x: 32, y: 56, fill: '#9ca3af' },
  { t: 'Z', deg: 270, name: 'západ', x: 12, y: 36, fill: '#9ca3af' },
]

/**
 * Poloměr klikací plochy písmene. Písmena sedí 20 od středu, takže se terče o poloměru 7,5
 * vejdou dovnitř kruhu (20 + 7,5 < 28) a přitom se navzájem nepřekrývají (rozteč 28,3 > 15).
 * Zvětšit už to nejde: přesahovaly by přes okraj růžice a nahoře i pod pevnou rysku.
 */
const HIT_R = 7.5

export function Compass({ viewer }: { viewer: Cesium.Viewer | null }) {
  const dialRef = useRef<SVGGElement>(null)
  const markRefs = useRef<(SVGGElement | null)[]>([])
  const degRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const v = viewer
    if (!v || v.isDestroyed()) return
    let last = NaN
    const sync = () => {
      if (v.isDestroyed()) return
      const h = Cesium.Math.toDegrees(v.camera.heading)
      // rozdíl u přechodu přes sever vyjde velký (359° → 1°), což je v pořádku: pak se překreslit má
      if (Number.isFinite(last) && Math.abs(h - last) < MIN_STEP_DEG) return
      last = h
      dialRef.current?.setAttribute('transform', `rotate(${-h} 32 36)`)
      // ...a každé písmeno zpátky o tolikéž kolem sebe sama, ať zůstane čitelné
      MARKS.forEach((m, i) => markRefs.current[i]?.setAttribute('transform', `rotate(${h} ${m.x} ${m.y})`))
      if (degRef.current) degRef.current.textContent = `${Math.round(h) % 360}°`
    }
    v.scene.postRender.addEventListener(sync)
    sync()
    return () => { if (!v.isDestroyed()) v.scene.postRender.removeEventListener(sync) }
  }, [viewer])

  /**
   * Otočit pohled na daný azimut. Otáčí se kolem BODU, na který se koukáš, ne kolem kamery —
   * otočení na místě by odhodilo pohled někam vedle a člověk by pak hledal, kde vlastně je.
   * Výška nad terénem i sklon zůstávají, mění se jenom azimut. Kratší cestu kolem dokola
   * (třeba z 350° na 0°) si pohlídá samo Cesium při skládání přeletu.
   */
  function faceHeading(deg: number) {
    const v = viewer
    if (!v || v.isDestroyed()) return
    const g = viewCenterGround(v)
    const center = Cesium.Cartesian3.fromDegrees(g.lon, g.lat, g.height)
    const range = Math.max(1, Cesium.Cartesian3.distance(v.camera.positionWC, center))
    v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 1), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(deg), v.camera.pitch, range),
      duration: 0.6,
    })
  }

  return (
    // `div`, ne `button`: klikací jsou samotná písmena a tlačítko se do tlačítka vnořit nedá.
    // Zbytek růžice události spolkne (má výplň), takže se klikem vedle omylem neotočí mapa pod ní.
    <div
      title="Světové strany — klikni na písmeno a pohled se otočí tím směrem"
      className="pointer-events-auto flex flex-col items-center gap-0.5"
    >
      {/* viewBox je vyšší než široký: nad růžicí musí zbýt místo na pevnou rysku, jinak by si
          při pohledu na sever lehla přesně na písmeno S. Střed růžice je proto na (32, 36). */}
      <svg viewBox="0 0 64 72" width={64} height={72} className="drop-shadow-lg">
        <circle cx="32" cy="36" r="28" fill="rgba(17,24,39,0.85)" stroke="rgba(107,114,128,0.7)" strokeWidth="1" />
        {/* pevná ryska = kam se kamera dívá; ta se s růžicí neotáčí */}
        <path d="M32 7.5 L35 0.5 L29 0.5 Z" fill="#38bdf8" />
        <g ref={dialRef}>
          <path d="M32 24 L35.5 36 L28.5 36 Z" fill="#f87171" />
          <path d="M32 48 L35.5 36 L28.5 36 Z" fill="#6b7280" />
          {/* S/V/J/Z, ne N/E/S/W — appka mluví česky a na českých mapách je sever „S" */}
          <g fontSize="9" fontWeight="700" textAnchor="middle" dominantBaseline="central">
            {MARKS.map((m, i) => (
              <g
                key={m.t}
                ref={el => { markRefs.current[i] = el }}
                role="button"
                tabIndex={0}
                aria-label={`Otočit pohled na ${m.name}`}
                onClick={() => faceHeading(m.deg)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); faceHeading(m.deg) } }}
                className="group cursor-pointer outline-none"
              >
                <title>{`Otočit na ${m.name} (${m.deg}°)`}</title>
                {/* terč je větší než písmeno — trefit 9px glyf myší by bylo trápení.
                    `pointerEvents=all` kvůli jistotě: průhledná výplň se jinak nemusí chytat. */}
                <circle
                  cx={m.x} cy={m.y} r={HIT_R}
                  fill="transparent" pointerEvents="all"
                  className="group-hover:fill-white/15 group-focus-visible:fill-white/15"
                />
                <text x={m.x} y={m.y} fill={m.fill} pointerEvents="none" className="group-hover:fill-white">{m.t}</text>
              </g>
            ))}
          </g>
        </g>
        <circle cx="32" cy="36" r="2" fill="#e5e7eb" />
      </svg>
      <span ref={degRef} className="text-[10px] leading-none tabular-nums text-gray-400">0°</span>
    </div>
  )
}
