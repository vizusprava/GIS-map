/**
 * Průvodce v mapě: bublina s vysvětlením stojí VŽDY na stejném místě (uprostřed viditelné
 * mapy) a k místu, o kterém je řeč, z ní vede svítící paprsek; místo samo dostane modrý
 * rámeček. Obsah je v `steps.tsx`, stav (zapnuto, kde uživatel skončil) v `tourStore`.
 *
 * Dřív si bublina hledala místo vedle zvýrazněného prvku a uhýbala nabídkám — poskakovala
 * a nedalo se předvídat, kde bude. Teď je pořád uprostřed; kdyby zrovna něco zakrývala, jde
 * chytit za hlavičku a odtáhnout (posun si pamatuje pro další kroky).
 *
 * Obrazovka se neztmavuje a nic kromě bubliny nechytá myš — mapou jde hýbat a nástroje
 * zkoušet, i když se zrovna na něco ukazuje (úkoly „zkus to" bez toho ani nejdou).
 *
 * Úkol kroku se hlídá dotazem každou čtvrtvteřinu (`task.done`), ne událostmi — ty by musely
 * protéct z půlky appky. Splněný úkol zůstane `DONE_WAIT_S` vteřin (Další jde hned), pak
 * průvodce pokračuje sám. Poloha zvýrazněného místa se měří desetkrát za vteřinu (panel se
 * rozbalí, lišta se přeskládá…), jen dokud je průvodce zapnutý.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Compass, GripHorizontal, ListChecks, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTourStore } from './tourStore'
import { CHAPTERS, snapOf, type TourCtx, type TourSnap } from './steps'

type Rect = { top: number; left: number; width: number; height: number }
type View = 'step' | 'done' | 'menu' | 'finale'

const EDGE = 12, PAD = 6
/** jak dlouho zůstane splněný úkol, než průvodce sám pokračuje */
const DONE_WAIT_S = 10
/** zhasnutí starého a rozsvícení nového zvýraznění při změně kroku (ms) */
const FADE_MS = 280
/** spodní okraj bubliny pod středem obrazovky (px) — bublina průměrné výšky je pak zhruba uprostřed */
const BOTTOM_BELOW_MID = 120
/** odtažení bubliny ze středu — drží se pro celé sezení (další kroky, znovuotevření) */
let dragOffset = { x: 0, y: 0 }

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
  // změřit hned před vykreslením nového kroku, ať rámeček a paprsek nejdou chvíli odjinud
  useLayoutEffect(() => {
    let scrolled = false
    const measure = () => {
      const panel = document.querySelector('[data-tour="panel"]')?.getBoundingClientRect()
      setMapLeft(l => { const v = panel && panel.right > 1 ? panel.right : 0; return Math.abs(v - l) > 1 ? v : l })
      const el = target ? document.querySelector(target) : null
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

  // ── bublina: pevně uprostřed viditelné mapy (+ kam ji uživatel odtáhl) ──
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 340, h: 200 })
  useLayoutEffect(() => {
    const b = bubbleRef.current
    if (!b) return
    const w = b.offsetWidth, h = b.offsetHeight
    setSize(s => (Math.abs(s.w - w) > 1 || Math.abs(s.h - h) > 1 ? { w, h } : s))
  })
  const [off, setOff] = useState(dragOffset)
  const vw = window.innerWidth, vh = window.innerHeight
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  // drží se SPODNÍ okraj (kousek pod středem): tlačítko Další je pak pořád na stejném místě,
  // ať je text kroku dlouhý nebo krátký — jde proklikávat bez míření
  const box: Rect = {
    left: clamp(mapLeft + (vw - mapLeft - size.w) / 2 + off.x, EDGE, vw - size.w - EDGE),
    top: clamp(vh / 2 + BOTTOM_BELOW_MID + off.y - size.h, EDGE, vh - size.h - EDGE),
    width: size.w, height: size.h,
  }
  // tažení za hlavičku (ne za tlačítka v ní)
  const drag = useRef<{ x: number; y: number; o: { x: number; y: number } } | null>(null)
  const onGrab = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    drag.current = { x: e.clientX, y: e.clientY, o: off }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDrag = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const o = { x: d.o.x + e.clientX - d.x, y: d.o.y + e.clientY - d.y }
    dragOffset = o
    setOff(o)
  }
  const onDrop = () => { drag.current = null }

  const big = !!rect && rect.width * rect.height > 0.45 * vw * vh
  const ring = rect && !big ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD } : null
  const ray = ring ? beam(box, ring) : null

  // Při přechodu na další krok se zvýraznění nepřesouvá: staré zhasne (kopie na chvíli
  // zůstane a vybledne) a nové se o chvilku později rozsvítí na svém místě.
  const last = useRef<{ key: string; ring: Rect | null; ray: Ray | null } | null>(null)
  const [ghost, setGhost] = useState<{ id: string; ring: Rect | null; ray: Ray | null } | null>(null)
  useEffect(() => {
    const p = last.current
    if (!p || p.key === stepKey || (!p.ring && !p.ray)) return
    setGhost({ id: p.key, ring: p.ring, ray: p.ray })
    const t = setTimeout(() => setGhost(null), FADE_MS)
    return () => clearTimeout(t)
  }, [stepKey])
  useEffect(() => { last.current = { key: stepKey, ring, ray } })

  const stepNo = pos >= 0 ? steps.indexOf(pos) + 1 : 0
  const actions = step?.actions?.(ctx, chapterStart.current.get(chapter.id) ?? null)

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]" data-tour-overlay>
      {/* zvýraznění: modrý svítící rámeček a paprsek k němu; obrazovka se neztmavuje. Velké
          místo (mapa) bez rámečku i paprsku — ukazovalo by se na všechno */}
      <div data-tour-marks>
        <style>{`
          @keyframes tour-beam { to { stroke-dashoffset: -28 } }
          @keyframes tour-in { from { opacity: 0 } to { opacity: 1 } }
          @keyframes tour-out { from { opacity: 1 } to { opacity: 0 } }
        `}</style>
        {ghost && <Marks key={`g-${ghost.id}`} ring={ghost.ring} ray={ghost.ray} anim={`tour-out ${FADE_MS}ms ease-in forwards`} />}
        {/* stálé zpoždění: změněná hodnota `animation` by rozsvícení v půlce spustila znovu */}
        <Marks key={stepKey} ring={ring} ray={ray} anim={`tour-in ${FADE_MS}ms ease-out ${Math.round(FADE_MS * 0.6)}ms both`} current />
      </div>

      <div
        ref={bubbleRef}
        data-tour-bubble={view === 'step' ? `${chapter.id}/${step?.id ?? ''}` : view}
        className="pointer-events-auto absolute w-[min(340px,calc(100vw-24px))] rounded-xl border border-sky-500/50 bg-gray-900/97 p-3 text-gray-200 shadow-2xl"
        style={{ top: box.top, left: box.left }}
      >
        <div
          data-tour-grip
          onPointerDown={onGrab} onPointerMove={onDrag} onPointerUp={onDrop} onPointerCancel={onDrop}
          title="Chyť a odtáhni, kdyby bublina něco zakrývala"
          className="-mx-3 -mt-3 mb-1.5 flex cursor-grab items-center gap-1.5 rounded-t-xl px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wide text-sky-300 select-none active:cursor-grabbing"
        >
          <Compass size={12} />
          <span className="min-w-0 flex-1 truncate">
            {view === 'menu' ? 'Průvodce — kapitoly' : `${chapter.title}${view === 'step' && stepNo ? ` · ${stepNo}/${steps.length}` : ''}`}
          </span>
          <GripHorizontal size={14} className="shrink-0 text-gray-600" />
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

type Ray = { x1: number; y1: number; x2: number; y2: number }

/**
 * Rámeček kolem zvýrazněného místa a paprsek k němu z bubliny (čárky běží k cíli).
 * `anim` = rozsvícení / zhasnutí při změně kroku; `current` nese značky pro testy.
 */
function Marks({ ring, ray, anim, current }: { ring: Rect | null; ray: Ray | null; anim: string; current?: boolean }) {
  return (
    <div className="absolute inset-0" style={{ animation: anim }}>
      {ray && (
        <svg data-tour-beam={current || undefined} className="absolute inset-0 h-full w-full overflow-visible">
          <line x1={ray.x1} y1={ray.y1} x2={ray.x2} y2={ray.y2} stroke="rgba(56,189,248,0.25)" strokeWidth={8} strokeLinecap="round" />
          <line
            x1={ray.x1} y1={ray.y1} x2={ray.x2} y2={ray.y2}
            stroke="#38bdf8" strokeWidth={2.5} strokeLinecap="round" strokeDasharray="10 4"
            style={{ animation: 'tour-beam 0.9s linear infinite', filter: 'drop-shadow(0 0 4px rgba(56,189,248,0.9))' }}
          />
          <circle cx={ray.x1} cy={ray.y1} r={4} fill="#38bdf8" />
          <circle cx={ray.x2} cy={ray.y2} r={5} fill="#38bdf8" style={{ filter: 'drop-shadow(0 0 6px rgba(56,189,248,1))' }} />
        </svg>
      )}
      {ring && (
        <div
          data-tour-ring={current || undefined}
          className="absolute rounded-xl ring-2 ring-sky-400"
          style={{ ...ring, boxShadow: '0 0 0 4px rgba(56, 189, 248, 0.25), 0 0 18px rgba(56, 189, 248, 0.45)' }}
        >
          <div className="absolute inset-0 animate-pulse rounded-xl ring-2 ring-sky-300/60" />
        </div>
      )}
    </div>
  )
}

/**
 * Paprsek od bubliny k zvýrazněnému místu: z okraje bubliny ve směru k cíli na okraj cíle
 * (průsečík spojnice středů s obvodem obou obdélníků). null, když se překrývají.
 */
function beam(a: Rect, b: Rect): Ray | null {
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2
  const bx = b.left + b.width / 2, by = b.top + b.height / 2
  const dx = bx - ax, dy = by - ay
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null
  // kolik spojnice středů leží uvnitř obdélníku (od jeho středu k okraji), jako podíl délky
  const exit = (r: Rect) => Math.min(dx ? r.width / 2 / Math.abs(dx) : Infinity, dy ? r.height / 2 / Math.abs(dy) : Infinity)
  const ta = exit(a), tb = exit(b)
  if (ta + tb >= 1) return null
  return { x1: ax + dx * ta, y1: ay + dy * ta, x2: bx - dx * tb, y2: by - dy * tb }
}
