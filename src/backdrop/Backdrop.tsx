/**
 * Pozadí přihlášení a přehledu scén: čtyři desky téhož kousku krajiny nad sebou — odspoda
 * 3D terén (vrstevnicový model), katastr, topografie a ortofoto.
 *
 *  - `login`: desky se v cyklu rozkládají a zase skládají (CSS animace, viz backdrop.css),
 *  - `overview`: mapy odletí, terén se přiblíží přes celou obrazovku a zůstane jako ztlumený
 *    podklad pod kartami scén. Přepnutí (po přihlášení) se přehraje jako plynulý přechod.
 *
 * Textury kreslí worker (landscapeWorker.ts) — hlavní vlákno jen přebírá hotové bitmapy.
 * Ve scéně s mapou se pozadí vůbec nekreslí (App.tsx), ať nebere grafiku Cesiu.
 */
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { K, N, drawSet, makeWorld, type LayerSet, type Surface } from './landscape'
import type { LandscapeRequest, LandscapeResponse } from './landscapeWorker'
import './backdrop.css'

export type BackdropMode = 'login' | 'overview'

/** odspoda nahoru; i = 0 je terén */
const LAYERS = [
  { i: 0, name: '3D terén 5G', side: '#a98458' },
  { i: 1, name: 'Katastr', side: '#d9d6cc' },
  { i: 2, name: 'Topografie', side: '#e3d8bf' },
  { i: 3, name: 'Ortofoto', side: '#3e4a30' },
] as const
/** rozlišení terénu v přehledu (přiblížený přes celou obrazovku) */
const HI = 1024
const EASE = 'cubic-bezier(.65, 0, .35, 1)'
/** pod touhle šířkou stoh stojí uprostřed za přihlášením (sedí na `xl` v LoginPage) */
const WIDE = 1280

type Z = { c: number[]; o: number[] }

// ── textury: worker, a kde nejde, totéž na hlavním vlákně ─────────────────────────
type Source = ImageBitmap | Surface
function textureSource() {
  let worker: Worker | null = null
  let nextId = 1
  const pending = new Map<number, (r: Source[] | Error) => void>()
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('bez OffscreenCanvas')
    worker = new Worker(new URL('./landscapeWorker.ts', import.meta.url), { type: 'module', name: 'krajina' })
    worker.onmessage = (e: MessageEvent<LandscapeResponse>) => {
      const r = e.data, done = pending.get(r.id)
      pending.delete(r.id)
      done?.(r.ok ? r.bitmaps : new Error(r.message))
    }
    worker.onerror = e => { for (const done of pending.values()) done(new Error(e.message || 'worker spadl')); pending.clear(); worker = null }
  } catch { worker = null }
  let world: ReturnType<typeof makeWorld> | null = null
  return {
    get(set: LayerSet, res: number): Promise<Source[]> {
      if (worker) {
        const id = nextId++
        const w = worker
        return new Promise((resolve, reject) => {
          pending.set(id, r => (r instanceof Error ? reject(r) : resolve(r)))
          w.postMessage({ id, set, res } satisfies LandscapeRequest)
        })
      }
      // bez workeru: na hlavním vlákně, ale až po vykreslení stránky
      return new Promise(resolve => setTimeout(() => { world ??= makeWorld(); resolve(drawSet(world, set, res)) }, 50))
    },
    stop() {
      worker?.terminate(); worker = null
      for (const done of pending.values()) done(new Error('zrušeno'))
      pending.clear()
    },
  }
}

function paint(target: HTMLCanvasElement, src: Source) {
  if (target.width !== src.width) { target.width = src.width; target.height = src.height }
  target.getContext('2d')?.drawImage(src as CanvasImageSource, 0, 0)
  if ('close' in src && typeof src.close === 'function') src.close()   // ImageBitmap — uvolnit hned
}

export function Backdrop({ mode }: { mode: BackdropMode }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const plateRefs = useRef<(HTMLDivElement | null)[]>([])
  const faceRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const sliceRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const zRef = useRef<Z>({ c: [0, 0, 0, 0], o: [0, 0, 0, 0] })
  const modeRef = useRef(mode)
  const hiRequested = useRef(false)
  /** v jakém rozlišení je terén nakreslený — pomalejší nižší nesmí přepsat hotový vyšší */
  const terrainRes = useRef(0)
  const sources = useRef(new Set<ReturnType<typeof textureSource>>())
  const newSource = () => { const s = textureSource(); sources.current.add(s); return s }
  const anims = useRef<Animation[]>([])
  const gen = useRef(0)

  // ── rozměry podle okna ──
  useLayoutEffect(() => {
    const st = stageRef.current
    if (!st) return
    const fit = () => {
      const W = innerWidth, Hh = innerHeight, wide = W >= WIDE
      const size = Math.round(wide ? Math.min(440, W * 0.32, Hh * 0.47) : Math.min(W * 0.74, Hh * 0.5, 420))
      const t = Math.max(6, Math.round(size * 0.018)), gap = Math.round(size * 0.36)
      const step = size * 0.0064, relief = K * step
      // Výšky desek zdola. Složené: mapy leží na sobě hned nad reliéfem terénu, rozjeté po `gap`.
      // Obojí vycentrované, ať stoh při rozjíždění neuhýbá.
      const zc = [0, relief + t, relief + 2 * t, relief + 3 * t], zo = [0, gap, 2 * gap, 3 * gap]
      const mc = zc[3] / 2, mo = zo[3] / 2
      zRef.current = { c: zc.map(z => z - mc), o: zo.map(z => z - mo) }
      const x = wide ? 0.59 : 0.5
      // přehled: deska natočená o 14° ± 10° houpání a nakloněná o 34° musí pokrýt celé okno
      // i v nejhorším natočení, s rezervou na perspektivu
      const th = 24 * Math.PI / 180, tilt = 34 * Math.PI / 180
      const need = Math.max(W * Math.cos(th) + Hh * Math.sin(th), (W * Math.sin(th) + Hh * Math.cos(th)) / Math.cos(tilt))
      const px = (v: number) => `${v.toFixed(1)}px`
      const vars: Record<string, string> = {
        '--bd-size': `${size}px`, '--bd-t': `${t}px`, '--bd-gap': `${gap}px`, '--bd-step': `${step.toFixed(2)}px`,
        '--bd-x': `${x * 100}%`, '--bd-ovx': px(W / 2 - W * x), '--bd-ovs': (need * 1.3 / size).toFixed(2),
        '--bd-gc': px(zc[0] - mc), '--bd-go': px(zo[0] - mo), '--bd-ratio': (zc[3] / zo[3]).toFixed(3),
        '--bd-fc': px(zc[0] - mc - t - 22), '--bd-fo': px(zo[0] - mo - t - 56),
      }
      for (let i = 0; i < 4; i++) { vars[`--bd-z${i}c`] = px(zc[i] - mc); vars[`--bd-z${i}o`] = px(zo[i] - mo) }
      for (const [k, v] of Object.entries(vars)) st.style.setProperty(k, v)
    }
    fit()
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [])

  // ── textury ──
  useEffect(() => {
    const src = newSource()
    let alive = true
    void (async () => {
      try {
        const [maps, terrain] = await Promise.all([src.get('maps', N), src.get('terrain', N)])
        if (!alive) return
        maps.forEach((m, k) => { const c = faceRefs.current[k + 1]; if (c) paint(c, m) })
        paintTerrain(terrain, N)
        stageRef.current?.classList.add('bd-ready')
        if (modeRef.current === 'overview') requestHi()   // pokud mezitím nedoběhl (nebo ho něco zrušilo)
      } catch (e) {
        if (!alive) return   // stránka mezitím odešla
        console.warn('Pozadí se nepodařilo vykreslit:', e)
        stageRef.current?.classList.add('bd-ready')   // aspoň síť a tmavé pozadí
      } finally {
        src.stop()   // na přihlášení stačí tohle; terén pro přehled si pustí vlastní worker
      }
    })()
    const all = sources.current
    return () => {
      alive = false
      for (const s of all) s.stop()
      all.clear()
      for (const a of anims.current) a.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function paintTerrain(set: Source[], res: number) {
    if (res < terrainRes.current) return
    terrainRes.current = res
    const [base, ...slices] = set
    if (faceRefs.current[0]) paint(faceRefs.current[0], base)
    slices.forEach((s, k) => { const c = sliceRefs.current[k]; if (c) paint(c, s) })
  }
  /** Terén ve vyšším rozlišení — jen pro přehled scén, kde je přiblížený přes celou obrazovku. */
  function requestHi() {
    if (hiRequested.current) return
    hiRequested.current = true
    const src = newSource()
    src.get('terrain', HI)
      .then(set => paintTerrain(set, HI))
      .catch(e => { hiRequested.current = false; if (e instanceof Error && e.message !== 'zrušeno') console.warn('Terén v plném rozlišení se nevykreslil:', e) })
      .finally(() => { src.stop(); sources.current.delete(src) })
  }

  // ── přechod přihlášení ↔ přehled ──
  // Desky běží na CSS animaci. Přechod je převezme přes Web Animations od polohy, ve které
  // zrovna jsou; po návratu se CSS cyklus spustí znovu od začátku, všechny desky naráz.
  function go(el: Element | null, prop: 'transform' | 'opacity', to: string, opts: KeyframeAnimationOptions): Animation | null {
    if (!el) return null
    const from = getComputedStyle(el)[prop]
    return el.animate([{ [prop]: from }, { [prop]: to }], { fill: 'forwards', easing: EASE, ...opts })
  }
  function swap(next: (Animation | null)[]) {
    const old = anims.current
    anims.current = next.filter((a): a is Animation => !!a)
    for (const a of old) a.cancel()
  }
  const leaves = (el: HTMLElement) => el.querySelectorAll(':scope > .bd-face, :scope > .bd-side, :scope > .bd-tag')
  const guides = () => stageRef.current?.querySelectorAll('.bd-guide, .bd-floor') ?? []

  function toOverview(instant: boolean) {
    gen.current++
    const d = instant || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1
    const next: (Animation | null)[] = []
    plateRefs.current.forEach((el, i) => {
      if (!el) return
      if (i === 0) {
        next.push(go(el, 'transform', 'translateZ(0px)', { duration: 1600 * d }))
        next.push(go(el.querySelector(':scope > .bd-tag'), 'opacity', '0', { duration: 400 * d }))
        return
      }
      // mapy odletí nahoru (horní první) a cestou zmizí
      const delay = (3 - i) * 90 * d
      const z = new DOMMatrix(getComputedStyle(el).transform).m43
      next.push(go(el, 'transform', `translateZ(${z + 320}px)`, { duration: 1100 * d, delay, easing: 'cubic-bezier(.5, 0, .8, .4)' }))
      for (const leaf of leaves(el)) next.push(go(leaf, 'opacity', '0', { duration: 650 * d, delay: delay + 250 * d, easing: 'ease' }))
    })
    for (const g of guides()) next.push(go(g, 'opacity', '0', { duration: 500 * d, easing: 'ease' }))
    swap(next)
    requestHi()
  }

  function toLogin() {
    const my = ++gen.current
    const d = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1
    const zs = zRef.current.c
    const next: (Animation | null)[] = []
    plateRefs.current.forEach((el, i) => {
      if (!el) return
      if (i === 0) { next.push(go(el, 'transform', `translateZ(${zs[0]}px)`, { duration: 1600 * d })); return }
      // mapy se vrátí odspoda nahoru
      const delay = (350 + (i - 1) * 110) * d
      next.push(go(el, 'transform', `translateZ(${zs[i]}px)`, { duration: 1100 * d, delay, easing: 'cubic-bezier(.2, .6, .35, 1)' }))
      // štítky zůstanou schované (ukáže je až cyklus), plocha a boky se vrátí
      for (const leaf of leaves(el)) next.push(go(leaf, 'opacity', leaf.classList.contains('bd-tag') ? '0' : '1', { duration: 700 * d, delay, easing: 'ease' }))
    })
    next.push(go(plateRefs.current[0]?.querySelector(':scope > .bd-tag') ?? null, 'opacity', '0', { duration: 1 }))
    // stín se vrátí, vodicí linky zůstanou schované — začátek cyklu je složený stoh
    for (const g of guides()) next.push(go(g, 'opacity', g.classList.contains('bd-floor') ? '0.9' : '0', { duration: 900 * d, delay: 600 * d, easing: 'ease' }))
    swap(next)
    void Promise.all(anims.current.map(a => a.finished)).then(() => {
      if (my !== gen.current) return   // mezitím se přepnulo jinam
      // CSS cyklus znovu od začátku (= složený stoh, jak přechod skončil) a pak pustit převzaté
      const st = stageRef.current
      if (!st) return
      st.classList.add('bd-restart'); void st.offsetWidth; st.classList.remove('bd-restart')
      swap([])
    }).catch(() => { /* zrušeno dalším přepnutím */ })
  }

  // první vykreslení rovnou ve správném stavu, další změny jako přechod
  const first = useRef(true)
  useLayoutEffect(() => {
    modeRef.current = mode
    stageRef.current?.classList.toggle('bd-overview', mode === 'overview')
    if (first.current) { first.current = false; if (mode === 'overview') toOverview(true); return }
    if (mode === 'overview') toOverview(false); else toLogin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  return (
    <div ref={stageRef} className="bd-stage" aria-hidden="true">
      <div className="bd-wrap">
        <div className="bd-tilt">
          <div className="bd-stack">
            <div className="bd-floor" />
            {(['nw', 'ne', 'sw', 'se'] as const).map(c => <div key={c} className={`bd-guide ${c}`} />)}
            {LAYERS.map(l => (
              <div
                key={l.i}
                ref={el => { plateRefs.current[l.i] = el }}
                className={l.i === 0 ? 'bd-plate' : 'bd-plate bd-see'}
                style={{ '--zc': `var(--bd-z${l.i}c)`, '--zo': `var(--bd-z${l.i}o)`, '--sc': l.side } as CSSProperties}
              >
                {(['n', 'e', 's', 'w'] as const).map(s => <div key={s} className={`bd-side ${s}`} />)}
                <canvas ref={el => { faceRefs.current[l.i] = el }} className="bd-face" width={1} height={1} />
                {l.i === 0 && (
                  <div className="bd-relief">
                    {Array.from({ length: K }, (_, k) => (
                      <canvas
                        key={k}
                        ref={el => { sliceRefs.current[k] = el }}
                        className="bd-slice"
                        width={1} height={1}
                        style={{ '--k': k + 1 } as CSSProperties}
                      />
                    ))}
                  </div>
                )}
                <div className="bd-tag">{l.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="bd-shade" />
      <div className="bd-veil" />
    </div>
  )
}
