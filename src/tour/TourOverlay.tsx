/**
 * Průvodce v mapě: ztmaví obrazovku kromě místa, o kterém je řeč, a vedle něj ukáže bublinu
 * s vysvětlením. Obsah je v `steps.tsx`, stav (zapnuto, kde uživatel skončil) v `tourStore`.
 *
 * Ztmavení nechytá myš — mapou jde hýbat a nástroje zkoušet, i když se zrovna na něco ukazuje
 * (úkoly „zkus to" bez toho ani nejdou). Klikatelná je jen bublina.
 *
 * Úkol kroku se hlídá dotazem každou čtvrtvteřinu (`task.done`), ne událostmi — ty by musely
 * protéct z půlky appky, a čtvrt vteřiny zpoždění u „Výborně!" nikomu nevadí. Poloha
 * zvýrazněného místa se měří desetkrát za vteřinu (panel se rozbalí, lišta se přeskládá…),
 * jen dokud je průvodce zapnutý.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Compass, ListChecks, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTourStore } from './tourStore'
import { CHAPTERS, snapOf, type TourCtx, type TourSnap } from './steps'

type Rect = { top: number; left: number; width: number; height: number }
type View = 'step' | 'done' | 'menu' | 'finale'

const GAP = 12, EDGE = 12, PAD = 6

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
    toast.info('Průvodce je vypnutý — zapneš ho v přehledu zkratek (?) nebo v nastavení účtu.', { duration: 5000 })
  }
  const finishAll = () => {
    set({ on: false, chapter: 0, step: 0, done: CHAPTERS.map(c => c.id) })
    toast.success('Průvodce dokončen. Kdykoliv ho projdeš znovu z přehledu zkratek (?).')
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
    if (view !== 'step' || !step) return
    const c = ctxRef.current
    step.before?.(c)
    const s = snapOf(c)
    if (!chapterStart.current.has(chapter.id)) chapterStart.current.set(chapter.id, s)
    setSnap(s)
    setTask(!!step.task && !step.task.done(c, s))
    setSuccess(false)
  }, [stepKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── úkol: hlídá se, dokud ho uživatel nesplní; pak „Výborně!" a samo dál ──
  useEffect(() => {
    if (!task || success || !snap || !step?.task) return
    const t = setInterval(() => { if (step.task!.done(ctxRef.current, snap)) setSuccess(true) }, 250)
    return () => clearInterval(t)
  }, [task, success, snap, stepKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!success) return
    const t = setTimeout(next, 1100)
    return () => clearTimeout(t)
  }, [success]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── poloha zvýrazněného místa ──
  const target = view === 'step' ? step?.target : undefined
  const [rect, setRect] = useState<Rect | null>(null)
  const [mapLeft, setMapLeft] = useState(0)
  // změřit hned před vykreslením nového kroku — jinak bublina na snímek skočí doprostřed
  // obrazovky (bez místa) a teprve pak odjede, kam patří
  useLayoutEffect(() => {
    if (!target) { setRect(null); return }
    let scrolled = false
    const measure = () => {
      const panel = document.querySelector('[data-tour="panel"]')?.getBoundingClientRect()
      setMapLeft(l => { const v = panel && panel.right > 1 ? panel.right : 0; return Math.abs(v - l) > 1 ? v : l })
      const el = document.querySelector(target)
      const r = el?.getBoundingClientRect()
      if (!el || !r || r.width < 1 || r.height < 1) { setRect(null); return }
      // místo v panelu může být odscrollované — jednou ho přisunout do pohledu
      if (!scrolled) { scrolled = true; el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
      setRect(o => (o && Math.abs(o.top - r.top) < 0.5 && Math.abs(o.left - r.left) < 0.5 && Math.abs(o.width - r.width) < 0.5 && Math.abs(o.height - r.height) < 0.5
        ? o : { top: r.top, left: r.left, width: r.width, height: r.height }))
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
  const place = useMemo(() => bubblePlace(rect, big, size, vw, vh, mapLeft), [rect, big, size, vw, vh, mapLeft])

  const stepNo = pos >= 0 ? steps.indexOf(pos) + 1 : 0
  const actions = step?.actions?.(ctx, chapterStart.current.get(chapter.id) ?? null)

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]" data-tour-overlay>
      {/* ztmavení: díra kolem zvýrazněného místa, jinak celé (bublina uprostřed); velké místo
          (mapa) se neztmavuje — ztmavit by nebylo co */}
      {rect && !big ? (
        <div
          className="absolute rounded-xl ring-2 ring-sky-400/90 transition-all duration-300"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD, boxShadow: '0 0 0 9999px rgba(3, 7, 18, 0.55)' }}
        />
      ) : !rect && (view !== 'step' || !target) ? (
        <div className="absolute inset-0 bg-gray-950/45" />
      ) : null}

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
                ? <><Check size={14} className="shrink-0" /> Výborně!</>
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
          <div className="mt-1 text-xs leading-relaxed text-gray-300">Prošel jsi všechno důležité. Průvodce kdykoliv znovu spustíš v přehledu zkratek (<span className="text-gray-100">?</span>) nebo v nastavení účtu — kapitoly jdou projít i jednotlivě.</div>
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

/**
 * Kam s bublinou: u velkého místa (mapa) nahoru doprostřed viditelné mapy, jinak na stranu,
 * kde se vejde — pod, nad, vpravo, vlevo (u míst při levém okraji, tedy v panelu, nejdřív
 * vpravo). Nevejde-li se nikam, na stranu s nejvíc místem a přitlačit k okraji okna.
 */
function bubblePlace(rect: Rect | null, big: boolean, size: { w: number; h: number }, vw: number, vh: number, mapLeft: number): React.CSSProperties {
  const clampX = (x: number) => Math.max(EDGE, Math.min(vw - size.w - EDGE, x))
  const clampY = (y: number) => Math.max(EDGE, Math.min(vh - size.h - EDGE, y))
  if (!rect) return { top: clampY((vh - size.h) / 2), left: clampX(mapLeft + (vw - mapLeft - size.w) / 2) }
  if (big) {
    const l = Math.max(rect.left, mapLeft), r = rect.left + rect.width
    return { top: clampY(rect.top + 72), left: clampX(l + (r - l - size.w) / 2) }
  }
  const r = { top: rect.top - PAD, left: rect.left - PAD, bottom: rect.top + rect.height + PAD, right: rect.left + rect.width + PAD }
  const cx = rect.left + rect.width / 2 - size.w / 2, cy = rect.top + rect.height / 2 - size.h / 2
  const sides = {
    below: { fits: vh - r.bottom >= size.h + GAP + EDGE, room: vh - r.bottom, at: { top: r.bottom + GAP, left: clampX(cx) } },
    above: { fits: r.top >= size.h + GAP + EDGE, room: r.top, at: { top: r.top - GAP - size.h, left: clampX(cx) } },
    right: { fits: vw - r.right >= size.w + GAP + EDGE, room: vw - r.right, at: { top: clampY(cy), left: r.right + GAP } },
    left: { fits: r.left >= size.w + GAP + EDGE, room: r.left, at: { top: clampY(cy), left: r.left - GAP - size.w } },
  }
  const order: (keyof typeof sides)[] = rect.left + rect.width < 420 ? ['right', 'below', 'above', 'left'] : ['below', 'above', 'left', 'right']
  const pick = order.find(k => sides[k].fits) ?? order.reduce((a, b) => (sides[b].room > sides[a].room ? b : a))
  const at = sides[pick].at
  return { top: clampY(at.top), left: clampX(at.left) }
}
