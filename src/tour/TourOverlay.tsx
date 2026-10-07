/**
 * Průvodce v mapě: orámuje místo, o kterém je řeč, a vedle něj ukáže bublinu s vysvětlením.
 * Obsah je v `steps.tsx`, stav (zapnuto, kde uživatel skončil) v `tourStore`.
 *
 * Obrazovka se neztmavuje a nic kromě bubliny nechytá myš — mapou jde hýbat a nástroje
 * zkoušet, i když se zrovna na něco ukazuje (úkoly „zkus to" bez toho ani nejdou). Bublina
 * se vyhýbá otevřeným nabídkám lišty, ať nezakryje, co si uživatel právě rozbalil.
 *
 * Úkol kroku se hlídá dotazem každou čtvrtvteřinu (`task.done`), ne událostmi — ty by musely
 * protéct z půlky appky. Splněný úkol zůstane `DONE_WAIT_S` vteřin (Další jde hned), pak
 * průvodce pokračuje sám. Poloha zvýrazněného místa a překážek se měří desetkrát za vteřinu
 * (panel se rozbalí, nabídka otevře…), jen dokud je průvodce zapnutý.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Compass, ListChecks, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTourStore } from './tourStore'
import { CHAPTERS, snapOf, type TourCtx, type TourSnap } from './steps'

type Rect = { top: number; left: number; width: number; height: number }
type View = 'step' | 'done' | 'menu' | 'finale'

const GAP = 12, EDGE = 12, PAD = 6
/** jak dlouho zůstane splněný úkol, než průvodce sám pokračuje */
const DONE_WAIT_S = 10
/** horní okraj bubliny „nahoře" — pod lištou hledání */
const TOP_Y = 72

export function TourOverlay({ ctx }: { ctx: TourCtx }) {
  const on = useTourStore(s => s.prefs.on)
  return on ? <Tour ctx={ctx} /> : null
}

function Tour({ ctx }: { ctx: TourCtx }) {
  const { prefs, set, stop } = useTourStore()
  const ctxRef = useRef(ctx)
  useEffect(() => { ctxRef.current = ctx })

  const chapter = CHAPTERS[Math.min(prefs.chapter, CHAPTERS.length - 1)]
  const [view, setView] = useState<View>('step')
  // začátek kapitoly (pro úklid ukázek) — jen v paměti; po reloadu se úklid nenabídne
  const chapterStart = useRef(new Map<string, TourSnap>())

  /** platné kroky kapitoly (podmínka `when`) — vyhodnocuje se při každém pohybu, scéna se mění */
  const valid = (ci: number) => CHAPTERS[ci].steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.when || s.when(ctx, chapterStart.current.get(CHAPTERS[ci].id) ?? null))
    .map(x => x.i)

  // uložený krok, který teď neplatí (scéna se změnila) → nejbližší další platný
  const steps = valid(prefs.chapter)
  const pos = steps.find(i => i >= prefs.step) ?? -1
  const step = pos >= 0 ? chapter.steps[pos] : null

  const finishChapter = () => {
    const done = prefs.done.includes(chapter.id) ? prefs.done : [...prefs.done, chapter.id]
    set({ done, step: chapter.steps.length })
    setView(prefs.chapter >= CHAPTERS.length - 1 ? 'finale' : 'done')
  }
  const next = () => {
    const n = steps.find(i => i > pos)
    if (n == null) finishChapter()
    else set({ step: n })
  }
  const prev = () => {
    const p = [...steps].reverse().find(i => i < pos)
    if (p != null) set({ step: p })
  }
  const goChapter = (ci: number) => { set({ chapter: ci, step: 0 }); setView('step') }
  const quit = () => {
    stop()
    toast.info('Průvodce je vypnutý — zapneš ho v přehledu zkratek (klávesa pod Esc) nebo v nastavení účtu.', { duration: 5000 })
  }
  const finishAll = () => {
    set({ on: false, chapter: 0, step: 0, done: CHAPTERS.map(c => c.id) })
    toast.success('Průvodce dokončen. Kdykoliv ho projdeš znovu z přehledu zkratek (klávesa pod Esc).')
  }

  // uložený krok za koncem kapitoly (průvodce se zavřel na obrazovce „hotovo")
  useEffect(() => {
    if (view === 'step' && !step) setView(prefs.chapter >= CHAPTERS.length - 1 && prefs.done.includes(chapter.id) ? 'finale' : 'done')
  }, [view, step, prefs.chapter]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── začátek kroku: příprava, snímek stavu, jestli je úkol ještě co plnit ──
  const stepKey = `${chapter.id}/${step?.id ?? '-'}/${view}`
  const [snap, setSnap] = useState<TourSnap | null>(null)
  const [task, setTask] = useState(false)
  const [success, setSuccess] = useState(false)
  useEffect(() => {
    setSuccess(false)
    if (view !== 'step' || !step) { setTask(false); return }
    const c = ctxRef.current
    step.before?.(c)
    const s = snapOf(c)
    if (!chapterStart.current.has(chapter.id)) chapterStart.current.set(chapter.id, s)
    setSnap(s)
    setTask(!!step.task && !step.task.done(c, s))
  }, [stepKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── úkol: hlídá se, dokud ho uživatel nesplní; pak „Výborně!" a samo dál ──
  useEffect(() => {
    if (!task || success || !snap || !step?.task) return
    const t = setInterval(() => { if (step.task!.done(ctxRef.current, snap)) setSuccess(true) }, 250)
    return () => clearInterval(t)
  }, [task, success, snap, stepKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // splněný úkol chvíli zůstane (ať si uživatel přečte, co udělal), Další jde kliknout hned
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (!success) return
    setLeft(DONE_WAIT_S)
    const t = setInterval(() => setLeft(l => l - 1), 1000)
    return () => clearInterval(t)
  }, [success])
  useEffect(() => { if (success && left === 0) next() }, [left]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── poloha zvýrazněného místa ──
  const target = view === 'step' ? step?.target : undefined
  const [rect, setRect] = useState<Rect | null>(null)
  const [mapLeft, setMapLeft] = useState(0)
  /**
   * Co bublina nesmí zakrýt — změří se JEDNOU na začátku kroku: lišta a místo nad ní, kam se
   * rozbalují její nabídky a panely (i zavřené), nápověda nad lištou, panel, minimapa. Pak už
   * bublinou nic nehýbe: otevřená nabídka ji neodstrčí, protože pro ni bylo místo nechané.
   */
  const [obstacles, setObstacles] = useState<Rect[]>([])
  /** zvýrazněné místo je v liště dole — bublina vedle lišty nebo nad místem pro její nabídky */
  const [inBar, setInBar] = useState(false)
  const [barRect, setBarRect] = useState<Rect | null>(null)
  // změřit hned před vykreslením nového kroku — jinak bublina na snímek skočí doprostřed
  // obrazovky (bez místa) a teprve pak odjede, kam patří
  useLayoutEffect(() => {
    let scrolled = false, obsDone = false
    const measure = () => {
      const panel = document.querySelector('[data-tour="panel"]')?.getBoundingClientRect()
      setMapLeft(l => { const v = panel && panel.right > 1 ? panel.right : 0; return Math.abs(v - l) > 1 ? v : l })
      const bar = document.querySelector('[data-tour="lista"]')
      const el = target ? document.querySelector(target) : null
      const inside = !!bar && !!el && bar.contains(el)
      if (!obsDone && (el || !target)) {
        obsDone = true
        const obs: Rect[] = []
        if (bar) {
          // místo nad každou skupinou lišty, kam se rozbalí její nabídka (krátká), nebo panel
          // (Kamera, Prezentace — vysoký); otevírají se nahoru, vystředěné nad skupinou
          for (const g of bar.querySelectorAll('[data-tour^="lista-"]')) {
            const r = rectOf(g), panel = g.hasAttribute('data-tour-panel')
            const w = panel ? 336 : 208, h = panel ? Math.min(0.7 * window.innerHeight, 620) + 8 : 250
            obs.push({ left: r.left + r.width / 2 - w / 2, width: w, top: Math.max(0, r.top - h), height: Math.min(h, r.top) })
          }
          for (const sib of bar.parentElement?.children ?? []) if (sib !== bar) obs.push(rectOf(sib))
        }
        // panel, minimapu, lištu a hledání nezakrývat (kromě případu, kdy se ukazuje právě na ně)
        for (const sel of ['[data-tour="panel"]', '[data-tour="roh"]', '[data-tour="lista"]', '[data-tour="hledani"]']) {
          const o = document.querySelector(sel)
          if (o && (!el || (!o.contains(el) && !el.contains(o)))) obs.push(rectOf(o))
        }
        setObstacles(obs.filter(r => r.width > 0 && r.height > 0))
      }
      setBarRect(o => { const n = bar ? rectOf(bar) : null; return n && o && sameRects([o], [n]) ? o : n })
      const r = el?.getBoundingClientRect()
      if (!el || !r || r.width < 1 || r.height < 1) { setRect(null); return }
      setInBar(inside)
      // místo v panelu může být odscrollované — jednou ho přisunout do pohledu
      if (!scrolled) { scrolled = true; el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
      setRect(o => (o && sameRects([o], [r]) ? o : { top: r.top, left: r.left, width: r.width, height: r.height }))
    }
    measure()
    const t = setInterval(measure, 100)
    return () => clearInterval(t)
  }, [target, stepKey])

  // ── bublina: změřit a postavit vedle zvýrazněného místa ──
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 340, h: 200 })
  useLayoutEffect(() => {
    const b = bubbleRef.current
    if (!b) return
    const w = b.offsetWidth, h = b.offsetHeight
    setSize(s => (Math.abs(s.w - w) > 1 || Math.abs(s.h - h) > 1 ? { w, h } : s))
  })
  const vw = window.innerWidth, vh = window.innerHeight
  const big = !!rect && rect.width * rect.height > 0.45 * vw * vh
  const prefer = view === 'step' ? step?.prefer : undefined
  // Bublina se postaví na začátku kroku a pak STOJÍ — nehýbe s ní otevírání nabídek ani drobné
  // změny (popisek skupiny lišty se přepíše, přibude řádek „Výborně"). Znovu jen když se
  // zvýrazněné místo opravdu posune (panel doroluje k sekci), změní se okno nebo bublina
  // znatelně vyroste.
  const frozen = useRef<{ key: string; rect: Rect | null; size: { w: number; h: number }; vw: number; vh: number; obs: Rect[]; at: Pos } | null>(null)
  const place = useMemo(() => {
    const f = frozen.current
    const far = (a: Rect | null, b: Rect | null) => (!a || !b ? a !== b : Math.abs(a.top - b.top) > 40 || Math.abs(a.left - b.left) > 40)
    // překážky se mění jen jednou, když se na začátku kroku změří
    if (f && f.key === stepKey && f.obs === obstacles && !far(f.rect, rect) && f.vw === vw && f.vh === vh && Math.abs(f.size.h - size.h) < 40) {
      // stejné místo; jen kdyby bublina trochu narostla, ať nevyleze z okna
      return { top: Math.max(EDGE, Math.min(vh - size.h - EDGE, f.at.top)), left: Math.max(EDGE, Math.min(vw - size.w - EDGE, f.at.left)) }
    }
    const at = bubblePlace({ rect, big, size, vw, vh, mapLeft, obstacles, inBar, bar: barRect, prefer })
    frozen.current = { key: stepKey, rect, size, vw, vh, obs: obstacles, at }
    return at
  }, [rect, big, size, vw, vh, mapLeft, obstacles, inBar, barRect, prefer, stepKey])

  const stepNo = pos >= 0 ? steps.indexOf(pos) + 1 : 0
  const actions = step?.actions?.(ctx, chapterStart.current.get(chapter.id) ?? null)

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]" data-tour-overlay>
      {/* zvýraznění: jen rámeček kolem místa, obrazovka se neztmavuje (mapa i nabídky musí
          být vidět, uživatel v nich zrovna něco zkouší); velké místo (mapa) bez rámečku */}
      {rect && !big && (
        <div
          data-tour-ring
          className="absolute rounded-xl ring-2 ring-sky-400 transition-all duration-300"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD, boxShadow: '0 0 0 4px rgba(56, 189, 248, 0.25), 0 0 18px rgba(56, 189, 248, 0.45)' }}
        >
          <div className="absolute inset-0 animate-pulse rounded-xl ring-2 ring-sky-300/60" />
        </div>
      )}

      <div
        ref={bubbleRef}
        data-tour-bubble={view === 'step' ? `${chapter.id}/${step?.id ?? ''}` : view}
        className="pointer-events-auto absolute w-[min(340px,calc(100vw-24px))] rounded-xl border border-sky-500/50 bg-gray-900/97 p-3 text-gray-200 shadow-2xl transition-[top,left] duration-300"
        style={place}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-sky-300">
          <Compass size={12} />
          <span className="min-w-0 flex-1 truncate">
            {view === 'menu' ? 'Průvodce — kapitoly' : `${chapter.title}${view === 'step' && stepNo ? ` · ${stepNo}/${steps.length}` : ''}`}
          </span>
          {view !== 'menu' && (
            <button onClick={() => setView('menu')} title="Kapitoly průvodce" className="flex items-center gap-1 rounded px-1 py-0.5 normal-case tracking-normal text-gray-400 hover:bg-gray-800 hover:text-gray-200">
              <ListChecks size={12} /> Kapitoly
            </button>
          )}
          <button onClick={quit} title="Ukončit průvodce" data-tour-quit className="rounded p-0.5 text-gray-400 hover:bg-gray-800 hover:text-gray-200"><X size={14} /></button>
        </div>

        {view === 'step' && step && <>
          <div className="text-sm font-semibold text-gray-100">{step.title}</div>
          <div className="mt-1 text-xs leading-relaxed text-gray-300">{step.body}</div>
          {task && step.task && (
            <div className={`mt-2 flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition-colors ${success ? 'border-emerald-500/60 bg-emerald-900/30 text-emerald-200' : 'border-sky-500/40 bg-sky-950/40 text-sky-100'}`} data-tour-task={success ? 'hotovo' : 'ceka'}>
              {success
                ? <><Check size={14} className="shrink-0" /> <span>Výborně! Dál pokračuju za {Math.max(0, left)} s — nebo klikni na Další.</span></>
                : <><span className="relative flex size-2 shrink-0"><span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400 opacity-75" /><span className="relative inline-flex size-2 rounded-full bg-sky-400" /></span> Zkus to: {step.task.label}</>}
            </div>
          )}
          <div className="mt-3 flex items-center gap-1.5">
            <button onClick={prev} disabled={stepNo <= 1} className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:invisible">
              <ChevronLeft size={13} /> Zpět
            </button>
            <div className="flex-1" />
            {actions ? actions.map(a => (
              <button key={a.label} onClick={() => { a.run(); next() }} className={`rounded-lg px-2.5 py-1 text-xs ${a.primary ? 'bg-sky-600 text-white hover:bg-sky-500' : 'text-gray-300 hover:bg-gray-800'}`}>{a.label}</button>
            )) : (
              <button onClick={next} data-tour-next className={`flex items-center gap-0.5 rounded-lg px-2.5 py-1 text-xs ${task && !success ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200' : 'bg-sky-600 text-white hover:bg-sky-500'}`}>
                {task && !success ? 'Přeskočit' : 'Další'} <ChevronRight size={13} />
              </button>
            )}
          </div>
        </>}

        {view === 'done' && <>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-300"><Check size={16} /> Kapitola {chapter.title} je hotová</div>
          {CHAPTERS[prefs.chapter + 1] && (
            <div className="mt-1 text-xs text-gray-300">Další: <span className="text-gray-100">{CHAPTERS[prefs.chapter + 1].title}</span> — {CHAPTERS[prefs.chapter + 1].summary}.</div>
          )}
          <div className="mt-3 flex items-center justify-end gap-1.5">
            <button onClick={quit} className="rounded-lg px-2.5 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200">Ukončit</button>
            <button onClick={() => goChapter(prefs.chapter + 1)} data-tour-next className="flex items-center gap-0.5 rounded-lg bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500">Pokračovat <ChevronRight size={13} /></button>
          </div>
        </>}

        {view === 'finale' && <>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-300"><Check size={16} /> Hotovo!</div>
          <div className="mt-1 text-xs leading-relaxed text-gray-300">Prošel jsi všechno důležité. Průvodce kdykoliv znovu spustíš v přehledu zkratek (klávesa pod <span className="text-gray-100">Esc</span>) nebo v nastavení účtu — kapitoly jdou projít i jednotlivě.</div>
          <div className="mt-3 flex justify-end">
            <button onClick={finishAll} data-tour-next className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs text-white hover:bg-sky-500">Zavřít průvodce</button>
          </div>
        </>}

        {view === 'menu' && <>
          <div className="flex flex-col gap-1">
            {CHAPTERS.map((c, i) => (
              <button key={c.id} onClick={() => goChapter(i)} data-tour-chapter={c.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-gray-800 ${i === prefs.chapter ? 'bg-gray-800/70' : ''}`}>
                <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] ${prefs.done.includes(c.id) ? 'bg-emerald-600 text-white' : 'border border-gray-600 text-gray-400'}`}>
                  {prefs.done.includes(c.id) ? <Check size={10} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-gray-100">{c.title}</span>
                  <span className="block text-[11px] text-gray-400">{c.summary}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex justify-end">
            <button onClick={() => setView(step ? 'step' : 'done')} className="rounded-lg px-2.5 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200">Zpět</button>
          </div>
        </>}
      </div>
    </div>
  )
}

type Pos = { top: number; left: number }

const rectOf = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height } }
const sameRects = (a: Rect[], b: Rect[]) => a.length === b.length && a.every((r, i) =>
  Math.abs(r.top - b[i].top) < 0.5 && Math.abs(r.left - b[i].left) < 0.5 && Math.abs(r.width - b[i].width) < 0.5 && Math.abs(r.height - b[i].height) < 0.5)
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top))

/** mezera mezi dvěma obdélníky (0, když se dotýkají nebo překrývají) */
const gapBetween = (a: Rect, b: Rect) => Math.hypot(
  Math.max(0, a.left - (b.left + b.width), b.left - (a.left + a.width)),
  Math.max(0, a.top - (b.top + b.height), b.top - (a.top + a.height)),
)

/**
 * Kam s bublinou. Zkusí se rozumná místa (vedle zvýrazněného místa, vedle lišty, mřížka přes
 * obrazovku) a vyhraje NEJBLIŽŠÍ ke zvýrazněnému místu z těch, které nic nezakrývají —
 * zvýrazněné místo, lištu, místo nad skupinami lišty, kam se rozbalí jejich nabídky a panely,
 * nápovědu nad lištou, panel, minimapu, hledání. Když nic takového není, to s nejmenším
 * překryvem.
 *
 * Velké místo (mapa) má bublinu nahoře uprostřed viditelné mapy, pod hledáním; `prefer`
 * kroku (třeba vpravo od hledání, pod ním se rozbalí výsledky) vyhraje, když je volné.
 */
function bubblePlace(o: {
  rect: Rect | null; big: boolean; size: { w: number; h: number }; vw: number; vh: number
  mapLeft: number; obstacles: Rect[]; inBar: boolean; bar: Rect | null; prefer?: 'below' | 'above' | 'left' | 'right'
}): Pos {
  const { rect, big, size, vw, vh, mapLeft, obstacles, inBar, bar, prefer } = o
  const clampX = (x: number) => Math.max(EDGE, Math.min(vw - size.w - EDGE, x))
  const clampY = (y: number) => Math.max(EDGE, Math.min(vh - size.h - EDGE, y))
  const mapCenterX = clampX(mapLeft + (vw - mapLeft - size.w) / 2)
  if (!rect) return { top: clampY((vh - size.h) / 2), left: mapCenterX }

  const t: Rect = { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD }
  const blockers = big ? obstacles : inBar && bar ? [t, bar, ...obstacles] : [t, ...obstacles]
  const cost = (p: Pos) => { const b = { ...p, width: size.w, height: size.h }; return blockers.reduce((s, x) => s + overlap(b, x), 0) }
  const at = (p: Pos): Pos => ({ top: clampY(p.top), left: clampX(p.left) })
  const cx = rect.left + rect.width / 2 - size.w / 2, cy = rect.top + rect.height / 2 - size.h / 2

  if (big) {
    const l = Math.max(rect.left, mapLeft)
    for (const p of [{ top: TOP_Y, left: l + (rect.left + rect.width - l - size.w) / 2 }, { top: TOP_Y, left: mapCenterX }]) {
      const q = at(p)
      if (cost(q) === 0) return q
    }
  }
  const sides = {
    below: { top: t.top + t.height + GAP, left: cx },
    above: { top: t.top - GAP - size.h, left: cx },
    right: { top: cy, left: t.left + t.width + GAP },
    left: { top: cy, left: t.left - GAP - size.w },
  }
  if (prefer && !big) { const q = at(sides[prefer]); if (cost(q) === 0) return q }

  const cands: Pos[] = [sides.below, sides.above, sides.right, sides.left]
  if (bar) {
    // vedle lišty, spodním okrajem u spodního okraje lišty
    cands.push({ top: bar.top + bar.height - size.h, left: bar.left - GAP - size.w }, { top: bar.top + bar.height - size.h, left: bar.left + bar.width + GAP })
  }
  const xs = [cx, rect.left, rect.left + rect.width - size.w, mapLeft + EDGE, mapCenterX, vw - size.w - EDGE]
  const ys = [cy, TOP_Y, vh - size.h - EDGE, ...(bar ? [bar.top - GAP - size.h, bar.top - 262 - size.h] : [])]
  for (const x of xs) for (const y of ys) cands.push({ top: y, left: x })

  let best: Pos | null = null, bestKey = Infinity, fallback: Pos = at(cands[0]), fallbackCost = Infinity
  for (const p of cands) {
    const q = at(p), c = cost(q)
    if (c === 0) {
      const d = gapBetween({ ...q, width: size.w, height: size.h }, t)
      if (d < bestKey) { bestKey = d; best = q }
    } else if (c < fallbackCost) { fallbackCost = c; fallback = q }
  }
  return best ?? fallback
}
