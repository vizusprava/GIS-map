/**
 * 2D výkres řezu — obrys z `sliceObject` vykreslený jako SVG s kótami, daty a exportem.
 *
 * Kreslí se ve světových jednotkách (metry) a teprve `view` (měřítko + střed) je překlápí
 * do souřadnic viewBoxu. Díky tomu jsou kóty, mřížka i měření pořád ve skutečných rozměrech
 * a zoom je jen změna jednoho čísla.
 *
 * Export je něco jiného než obrazovka: SVG, PNG i tisk jdou přes `sectionSheet` na
 * normovaný list v pevném měřítku, s rámečkem a razítkem. Na obrazovce chceme tmavý panel
 * a zoom na kolečku, na papír naopak 1:100 a čáry v milimetrech.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { createPortal } from 'react-dom'
import { X, Download, Ruler, Maximize2, Sun, Moon, Trash2, Table2, Tag, Palette, Layers, Spline, Printer, Eye, EyeOff, Focus, PaintBucket, TriangleRight, Scissors } from 'lucide-react'
import type { Pt2, SectionPoly, SectionResult } from './sectionCut'
import { buildSectionDxf, filterResult, fmtLen, polySegments } from './sectionCut'
import type { SectionView, SectionViewRect } from './sectionView'
import type { SheetFormat, TitleBlock } from './sectionSheet'
import { sectionSheet, sheetInfo, penScreen, SCALES } from './sectionSheet'
import { placeLabels } from './labels'

/** druhy čar ve výkrese — zároveň vrstvy, které jde zhasínat */
type PolyKind = 'cut' | 'nearby' | 'ctx' | 'view' | 'viewHidden'

const KINDS: [PolyKind, string][] = [
  ['cut', 'Řez rovinou'],
  ['nearby', 'Řez — přibráno z okolí'],
  ['ctx', 'Řez z tloušťky'],
  ['view', 'Pohled — obrys'],
  ['viewHidden', 'Pohled — zakryté'],
]

/** převod pojmenované vrstvy na kód stylu čáry */
const KIND_CODE: Record<PolyKind, string> = { cut: 'k', nearby: 'n', ctx: 'c', view: 'v', viewHidden: 'vh' }

function kindOf(p: SectionPoly): PolyKind {
  if (p.projected) return p.hidden ? 'viewHidden' : 'view'
  if (p.nearby) return 'nearby'
  return p.depth !== 0 ? 'ctx' : 'cut'
}

/**
 * Jak vypadá který druh čáry — odvozeno z PER v `sectionSheet`, aby okno a papír nešly
 * každý svou cestou. Rozlišuje TLOUŠŤKA a ČÁRKOVÁNÍ, ne průhlednost: poloprůhledné čáry
 * byly při přiblížení na tmavém podkladu k nepřečtení a vypadaly jako díry v obrysu.
 * Pořadí důležitosti drží barva (řez barevně, pohled šedě) a síla čáry.
 */
const LINE_STYLE: Record<string, { width: number; opacity: number; dash?: string }> = {
  k: { ...penScreen('cut'), opacity: 1 },
  o: { ...penScreen('cutOpen'), opacity: 1 },
  n: { ...penScreen('nearby'), opacity: 1 },
  c: { ...penScreen('context'), opacity: 1 },
  v: { ...penScreen('view'), opacity: 1 },
  vh: { ...penScreen('viewHidden'), opacity: 1 },
}

const VB_W = 1400
const VB_H = 900
const PAD = 90
const ACCENT = '#f97316'

/**
 * Barvy pro rozlišení materiálů a objektů. Dvě sady, protože stejný odstín nemůže být
 * čitelný na tmavém panelu i na bílém papíře — pořadí je v obou stejné, takže barva
 * konkrétního materiálu se přepnutím papíru nezmění, jen zesvětlí nebo ztmaví.
 */
const HUES_DARK = ['#60a5fa', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#f472b6', '#a3e635', '#2dd4bf', '#fb923c']
const HUES_LIGHT = ['#1d4ed8', '#15803d', '#b45309', '#b91c1c', '#7e22ce', '#0e7490', '#be185d', '#4d7c0f', '#0f766e', '#c2410c']

type View = { s: number; cx: number; cy: number }
type Measure = { a: Pt2; b: Pt2 }

function download(data: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** vzdálenost bodu od úsečky ve světových jednotkách */
function segDist(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])
}

const fmtArea = (a: number) => (a < 1 ? (a * 10000).toFixed(0) + ' cm²' : a.toFixed(3) + ' m²')

/** „Hezká" délka měřítka (1/2/5 × 10^k) nejblíž zadanému počtu metrů. */
function niceLength(m: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(m)))
  const n = m / pow
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow
}

/** Krok mřížky tak, aby na výkrese vyšlo zhruba 8–20 dílků. */
function gridStep(spanM: number): number {
  return niceLength(spanM / 12) || 1
}

function fitView(r: SectionResult): View {
  const w = Math.max(r.width, 1e-6)
  const h = Math.max(r.height, 1e-6)
  const s = Math.min((VB_W - PAD * 2) / w, (VB_H - PAD * 2) / h)
  return { s, cx: (r.minU + r.maxU) / 2, cy: (r.minV + r.maxV) / 2 }
}

/** Tažení okna za lištu + změna velikosti za pravý dolní roh. Drží se v mezích okna prohlížeče. */
function useFloatingBox(enabled: boolean, slot = 0) {
  // `slot` rozhodí víc oken kaskádou, ať druhý výkres nepřistane přesně na prvním
  const [box, setBox] = useState(() => ({
    x: Math.max(16, window.innerWidth - 980 - slot * 56),
    y: 96 + slot * 44,
    w: Math.min(940, Math.max(420, window.innerWidth - 80)),
    h: Math.min(680, Math.max(360, window.innerHeight - 160)),
  }))
  const dragRef = useRef<{ mode: 'move' | 'size'; x: number; y: number; box: typeof box } | null>(null)

  useEffect(() => {
    if (!enabled) return
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (d.mode === 'move') {
        setBox(b => ({
          ...b,
          x: Math.min(window.innerWidth - 120, Math.max(-b.w + 120, d.box.x + dx)),
          y: Math.min(window.innerHeight - 44, Math.max(0, d.box.y + dy)),
        }))
      } else {
        setBox(b => ({ ...b, w: Math.max(380, d.box.w + dx), h: Math.max(300, d.box.h + dy) }))
      }
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  }, [enabled])

  const start = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // klik na tlačítko v liště je klik, ne tažení oknem
    if (mode === 'move' && (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragRef.current = { mode, x: e.clientX, y: e.clientY, box }
  }
  return { box, startMove: start('move'), startSize: start('size') }
}

export function SectionDrawing({ result, name, onClose, float = false, slot = 0, epoch = 0, bgView, originZ = null, onNewSection }: {
  result: SectionResult
  /** jméno modelu — jde do názvu souboru i do rohového razítka */
  name: string
  onClose: () => void
  /** plovoucí okno místo přes celou obrazovku — v mapě chceme vidět i model pod výkresem */
  float?: boolean
  /** pořadí okna — víc výkresů naráz se rozhodí kaskádou, ať se nepřekrývají */
  slot?: number
  /**
   * Roste jen při novém zadání řezu. Živý přepočet (posun čáry v mapě) mění `result`, ale
   * `epoch` nechává — podle toho okno pozná, kdy se má znovu vystředit a kdy ne.
   */
  epoch?: number
  /** pravoúhlý pohled do řezu; leží pod obrysem ve stejných souřadnicích */
  bgView?: SectionView | null
  /**
   * Nadmořská výška počátku výkresu v soustavě modelu (u S-JTSK modelu Bpv). Z ní se
   * dopočítá výška libovolného bodu výkresu; `null` = výšky se neukazují.
   */
  originZ?: number | null
  /**
   * Nový řez odvozený z tohohle výkresu: obdélník vytažený v pohledu určí, kudy vést kolmou
   * rovinu a jak daleko a vysoko se v ní dívat. `undefined` = funkce se nenabízí.
   */
  onNewSection?: (rect: SectionViewRect) => void
}) {
  const [view, setView] = useState<View>(() => fitView(result))
  const [paper, setPaper] = useState(false)
  const [measureMode, setMeasureMode] = useState(false)
  /** odečítání nadmořské výšky klikem do výkresu */
  const [levelMode, setLevelMode] = useState(false)
  const [levels, setLevels] = useState<Pt2[]>([])
  /** vytahování obdélníku, ze kterého vznikne nový kolmý řez */
  const [cropMode, setCropMode] = useState(false)
  const [cropFrom, setCropFrom] = useState<Pt2 | null>(null)
  const [measures, setMeasures] = useState<Measure[]>([])
  const [pending, setPending] = useState<Pt2 | null>(null)
  const [cursor, setCursor] = useState<Pt2 | null>(null)
  const [hoverPoly, setHoverPoly] = useState<number | null>(null)
  const [hoverGroup, setHoverGroup] = useState<string | null>(null)
  /** barvit podle materiálu, nebo podle objektu v modelu */
  const [groupMode, setGroupMode] = useState<'group' | 'object'>('group')
  /** kóty jednotlivých úseků obrysu (délka + sklon) */
  const [showDims, setShowDims] = useState(false)
  /** pravoúhlý pohled pod obrysem — zapnutý, jakmile je k dispozici */
  const [showView, setShowView] = useState(true)
  /** obrysy pohledu: vše (i zakryté čárkovaně) / jen viditelné / vypnuto */
  const [showLines, setShowLines] = useState<'all' | 'visible' | 'off'>('all')
  /** barevná výplň uvnitř uzavřených řezných obrysů — na hustém výkrese spíš překáží */
  const [showFill, setShowFill] = useState(true)
  /** schovat drobty menší než X cm — u ploch skoro rovnoběžných s rovinou jich vzniká hodně */
  const [minSizeCm, setMinSizeCm] = useState(0)
  // v plovoucím okně je místa málo — data se dají odklopit
  const [showData, setShowData] = useState(!float)
  /**
   * Papír: formát, měřítko a razítko. Razítko se pamatuje v prohlížeči, ať ho nemusíš
   * u každého výkresu vyplňovat znovu.
   */
  const [sheetFormat, setSheetFormat] = useState<SheetFormat>('A3')
  const [sheetLandscape, setSheetLandscape] = useState(true)
  /** 0 = dopočítat nejbližší normované měřítko, aby se výkres vešel */
  const [sheetScale, setSheetScale] = useState(0)
  const [sheetHatch, setSheetHatch] = useState(true)
  const [title, setTitle] = useState<TitleBlock>(() => {
    const base: TitleBlock = {
      stavba: '', objekt: '', vykres: name, vypracoval: '',
      datum: new Date().toLocaleDateString('cs-CZ'), cislo: '',
    }
    try {
      const raw = localStorage.getItem('geo-studio.razitko')
      if (raw) return { ...base, ...JSON.parse(raw) as Partial<TitleBlock>, vykres: name }
    } catch { /* bez uloženého razítka se prostě začne na prázdném */ }
    return base
  })
  useEffect(() => {
    // název výkresu patří ke konkrétnímu řezu, zbytek razítka je pro celou zakázku
    try {
      const { vykres: _vykres, ...rest } = title
      localStorage.setItem('geo-studio.razitko', JSON.stringify(rest))
    } catch { /* privátní okno bez úložiště — nevadí */ }
  }, [title])
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)
  const fbox = useFloatingBox(float, slot)

  /**
   * Nový výkres se vystředí a zahodí měření. Při živém překreslení téhož řezu se ale zoom
   * ani kóty nesahá — jinak by výkres pod rukama uskakoval pokaždé, když se čára v mapě hne.
   */
  useEffect(() => { setView(fitView(result)); setMeasures([]); setLevels([]); setPending(null) }, [epoch]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Nadmořská výška bodu výkresu.
   *
   * Osy výkresu jsou v prostoru natočené, takže svislou složku nese jak `v`, tak (u šikmé
   * nebo vodorovné roviny) i `u`. Výška se proto skládá z obou — jinak by u půdorysu nebo
   * šikmého řezu vycházela nesmyslně.
   */
  const elevAt = (q: Pt2): number | null =>
    originZ === null ? null : originZ + q[0] * result.u.z + q[1] * result.v.z
  const elevText = (q: Pt2): string => {
    const z = elevAt(q)
    return z === null ? '—' : z.toFixed(3) + ' m'
  }

  /** výškové body s dopočítanou výškou — jdou i na papír a do DXF */
  const levelList = useMemo(
    () => levels.map(q => ({ p: q, z: elevAt(q) })).filter((x): x is { p: Pt2; z: number } => x.z !== null),
    [levels, originZ, result], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const activeView = bgView ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (cropMode) { setCropMode(false); setCropFrom(null) }
      else if (levelMode) setLevelMode(false)
      else if (measureMode) setMeasureMode(false)
      else if (pending) setPending(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending, cropMode, levelMode, measureMode])

  // svět (metry) ↔ viewBox
  const toVb = (p: Pt2): [number, number] => [
    (p[0] - view.cx) * view.s + VB_W / 2,
    -(p[1] - view.cy) * view.s + VB_H / 2,
  ]
  const vbToWorld = (x: number, y: number): Pt2 => [
    (x - VB_W / 2) / view.s + view.cx,
    -(y - VB_H / 2) / view.s + view.cy,
  ]
  const clientToVb = (cx: number, cy: number): [number, number] => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const m = svg.getScreenCTM()
    if (!m) return [0, 0]
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse())
    return [p.x, p.y]
  }

  /** Přichycení na nejbližší vrchol obrysu do 12 jednotek viewBoxu — kóty pak sedí na hranu. */
  const snap = (w: Pt2): Pt2 => {
    const tol = 12 / view.s
    let best: Pt2 | null = null
    let bestD = tol
    for (const poly of result.polys) {
      for (const pt of poly.pts) {
        const d = Math.hypot(pt[0] - w[0], pt[1] - w[1])
        if (d < bestD) { bestD = d; best = pt }
      }
    }
    return best ?? w
  }

  function onWheel(e: React.WheelEvent) {
    const [vx, vy] = clientToVb(e.clientX, e.clientY)
    const before = vbToWorld(vx, vy)
    const s = Math.min(1e7, Math.max(0.05, view.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    // střed dopočítáme tak, aby bod pod kurzorem zůstal na místě
    const cx = before[0] - (vx - VB_W / 2) / s
    const cy = before[1] + (vy - VB_H / 2) / s
    setView({ s, cx, cy })
  }

  function onPointerDown(e: React.PointerEvent) {
    if (cropMode && e.button === 0) {
      const [vx, vy] = clientToVb(e.clientX, e.clientY)
      setCropFrom(vbToWorld(vx, vy))
      svgRef.current?.setPointerCapture?.(e.pointerId)
      return
    }
    if (measureMode && e.button === 0) return
    dragRef.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
    // capture na plátno, ne na obrys — jinak by se při tažení zasekl hover polylinie
    svgRef.current?.setPointerCapture?.(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent) {
    const [vx, vy] = clientToVb(e.clientX, e.clientY)
    const w = vbToWorld(vx, vy)
    setCursor(measureMode || levelMode ? snap(w) : w)
    if (cropMode) return                          // při vytahování výřezu se plátnem neposouvá
    const d = dragRef.current
    // obrys pod kurzorem; při tažení se nehledá, tam jde o plynulost posunu
    if (!d) setHoverPoly(pickPoly(w, 6 / view.s))
    if (!d) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const scale = VB_W / rect.width      // viewBox jednotek na obrazovkový px
    setView(v => ({ ...v, cx: d.cx - ((e.clientX - d.x) * scale) / v.s, cy: d.cy + ((e.clientY - d.y) * scale) / v.s }))
  }

  function onPointerUp(e: React.PointerEvent) {
    if (cropMode && cropFrom) {
      const [vx, vy] = clientToVb(e.clientX, e.clientY)
      const to = vbToWorld(vx, vy)
      setCropFrom(null)
      const rect = {
        minU: Math.min(cropFrom[0], to[0]), maxU: Math.max(cropFrom[0], to[0]),
        minV: Math.min(cropFrom[1], to[1]), maxV: Math.max(cropFrom[1], to[1]),
      }
      // moc malý obdélník je spíš uklouznutí než záměr
      if (rect.maxU - rect.minU > 0.05 && rect.maxV - rect.minV > 0.05) {
        setCropMode(false)
        onNewSection?.(rect)
      }
      return
    }
    const wasDrag = dragRef.current && (Math.abs(e.clientX - dragRef.current.x) > 3 || Math.abs(e.clientY - dragRef.current.y) > 3)
    dragRef.current = null
    if ((!measureMode && !levelMode) || e.button !== 0 || wasDrag) return
    const [vx, vy] = clientToVb(e.clientX, e.clientY)
    const p = snap(vbToWorld(vx, vy))
    if (levelMode) { setLevels(l => [...l, p]); return }
    if (!pending) setPending(p)
    else { setMeasures(m => [...m, { a: pending, b: p }]); setPending(null) }
  }

  const grid = useMemo(() => {
    const step = gridStep(Math.max(result.width, result.height))
    const halfW = VB_W / 2 / view.s
    const halfH = VB_H / 2 / view.s
    const x0 = Math.ceil((view.cx - halfW) / step) * step
    const y0 = Math.ceil((view.cy - halfH) / step) * step
    const xs: number[] = []
    const ys: number[] = []
    for (let x = x0; x <= view.cx + halfW && xs.length < 400; x += step) xs.push(x)
    for (let y = y0; y <= view.cy + halfH && ys.length < 400; y += step) ys.push(y)
    return { step, xs, ys }
  }, [view, result])

  const scaleBar = useMemo(() => {
    const target = 220 / view.s
    const len = niceLength(target)
    return { len, px: len * view.s }
  }, [view])

  const ink = paper ? '#111827' : '#e5e7eb'
  const inkSoft = paper ? '#4b5563' : '#9ca3af'
  const gridCol = paper ? '#e5e7eb' : '#1f2937'
  const bg = paper ? '#ffffff' : '#0b0f19'

  const dimOff = 34 / view.s        // odsazení kótovací čáry od obrysu, v metrech
  const tick = 7 / view.s

  function exportSvg(): string {
    return buildSheet()
  }

  function doExportSvg() {
    download(exportSvg(), fileBase(name) + '.svg', 'image/svg+xml')
  }

  /**
   * Tisk listu — a tím i PDF: prohlížeč umí „Uložit jako PDF" a výsledek je vektorový,
   * takže se z něj dá v PDF pořád měřit. Vlastní knihovna na PDF by tu byla navíc.
   */
  function doPrint() {
    const w = window.open('', '_blank')
    if (!w) { toast.error('Prohlížeč zablokoval okno tisku — povol pro tuhle stránku vyskakovací okna.'); return }
    const page = `@page { size: ${sheet.widthMm}mm ${sheet.heightMm}mm; margin: 0 }`
    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' + fileBase(name) + '</title>' +
      '<style>' + page + ' html,body{margin:0;padding:0} svg{display:block}</style></head><body>' +
      buildSheet() + '</body></html>',
    )
    w.document.close()
    w.focus()
    // vykreslení listu je synchronní, ale Safari chce snímek navíc, než pustí tisk
    setTimeout(() => w.print(), 250)
  }

  function doExportDxf() {
    download(buildSectionDxf(shown, { hatch: sheetHatch, dims: showDims, levels: levelList }), fileBase(name) + '.dxf', 'application/dxf')
  }

  function doExportPng() {
    const svg = exportSvg()
    const img = new Image()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    img.onload = () => {
      // 300 dpi z rozměru listu v mm — tisknutelný rastr, ne screenshot
      const dpi = 300
      const c = document.createElement('canvas')
      c.width = Math.round((sheet.widthMm / 25.4) * dpi)
      c.height = Math.round((sheet.heightMm / 25.4) * dpi)
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      c.toBlob(b => { if (b) download(b, fileBase(name) + '.png', 'image/png') }, 'image/png')
    }
    img.src = url
  }


  /** Materiály (nebo objekty) v řezu, seřazené podle délky čar — nejvýraznější nahoře. */
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; length: number; area: number; count: number; width: number; height: number }>()
    for (const p of result.polys) {
      // pohled do legendy nepatří — kreslí se šedě jako jedna vrstva, ne podle materiálu
      if (p.projected) continue
      if (p.depth !== 0 && !p.nearby) continue
      const key = groupMode === 'group' ? p.group : p.object
      const g = map.get(key) ?? { key, length: 0, area: 0, count: 0, width: 0, height: 0 }
      g.length += p.length
      if (p.closed) g.area += p.hole ? -p.area : p.area
      g.count++
      g.width = Math.max(g.width, p.width)
      g.height = Math.max(g.height, p.height)
      map.set(key, g)
    }
    return [...map.values()].sort((a, b) => b.length - a.length)
  }, [result, groupMode])

  /**
   * Filtr vrstev.
   *
   * `offGroups` jsou zhasnuté materiály (nebo objekty) — přepínají se v legendě. `offKinds`
   * jsou zhasnuté DRUHY čar: samotný řez, okolí, kontext z tloušťky, pohled a jeho zakrytá
   * část. Obojí platí i pro export, protože list i DXF se staví z profiltrovaného výsledku
   * — co nevidíš na obrazovce, není ani na papíře.
   */
  const [offGroups, setOffGroups] = useState<Set<string>>(new Set())
  const [offKinds, setOffKinds] = useState<Set<PolyKind>>(new Set())
  // zhasnuté vrstvy patří ke konkrétnímu výkresu; nový řez začíná s rozsvíceným vším
  useEffect(() => { setOffGroups(new Set()); setOffKinds(new Set()) }, [epoch])

  const visible = (p: SectionPoly): boolean => {
    if (offKinds.has(kindOf(p))) return false
    if (p.projected) return showLines !== 'off' && !(p.hidden && showLines === 'visible')
    return !offGroups.has(groupMode === 'group' ? p.group : p.object)
  }

  /** jen to, co je vidět — z tohohle se kreslí i exportuje */
  const shown = useMemo(() => filterResult(result, visible), [result, offGroups, offKinds, groupMode, showLines]) // eslint-disable-line react-hooks/exhaustive-deps

  /** zhasne všechno kromě jedné skupiny; podruhé zase rozsvítí */
  const isolate = (key: string) => setOffGroups(prev => {
    const others = groups.filter(g => g.key !== key).map(g => g.key)
    const alone = prev.size === others.length && others.every(k => prev.has(k))
    return alone ? new Set() : new Set(others)
  })

  /** rozměry listu a měřítko pro panel — levné, bez sestavování SVG */
  const sheet = useMemo(
    () => sheetInfo(shown, sheetFormat, sheetLandscape, sheetScale),
    [shown, sheetFormat, sheetLandscape, sheetScale],
  )

  /** Celý list se skládá až když je opravdu potřeba — při exportu nebo tisku. */
  function buildSheet(): string {
    return sectionSheet(shown, {
      format: sheetFormat,
      landscape: sheetLandscape,
      scale: sheetScale,
      title,
      color: k => (HUES_LIGHT[groups.findIndex(g => g.key === k)] ?? '#111827'),
      keyOf: p => (groupMode === 'group' ? p.group : p.object),
      dims: showDims,
      lines: showLines,
      hatch: sheetHatch,
      measures,
      levels: levelList,
    }).svg
  }


  const colorOf = useMemo(() => {
    const hues = paper ? HUES_LIGHT : HUES_DARK
    const order = new Map(groups.map((g, i) => [g.key, hues[i % hues.length]]))
    return (key: string) => order.get(key) ?? (paper ? '#111827' : '#e5e7eb')
  }, [groups, paper])

  const rings = useMemo(
    () => result.polys.map((p, i) => ({ p, i })).filter(x => x.p.closed && !x.p.projected && (x.p.depth === 0 || x.p.nearby)).sort((a, b) => b.p.area - a.p.area),
    [result],
  )
  const ctxCount = useMemo(() => result.polys.filter(p => p.depth !== 0 && !p.nearby).length, [result])

  /**
   * Obrysy si držíme zvlášť zapamatované — u terénních řezů jich jsou tisíce a přepočítávat
   * je při každém pohybu myší (kvůli odečtu souřadnic) by výkres znatelně zpomalilo.
   */
  const minSize = minSizeCm / 100
  const hidden = useMemo(
    () => (minSize > 0 ? result.polys.filter(p => Math.max(p.width, p.height) < minSize).length : 0),
    [result, minSize],
  )

  const hasProjected = useMemo(() => result.polys.some(p => p.projected), [result])
  const hasHidden = useMemo(() => result.polys.some(p => p.projected && p.hidden), [result])
  /** obrys pohledu, který se právě nemá kreslit */
  const skipLine = (p: SectionPoly) => !visible(p)

  /**
   * Mřížkový rejstřík obrysů pro najíždění myší.
   *
   * Obrysy se kreslí po hromádkách (viz níž), takže na nich nevisí žádné pointer handlery
   * a co je pod kurzorem se musí najít v JS. Prostá pravidelná mřížka stačí: obrys se zapíše
   * do všech buněk, které jeho obálka protíná, a při dotazu se prohledá jen okolí kurzoru.
   */
  const polyIndex = useMemo(() => {
    const span = Math.max(result.width, result.height, 1)
    const cell = span / 64
    const cells = new Map<string, number[]>()
    result.polys.forEach((p, i) => {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
      for (const pt of p.pts) {
        if (pt[0] < u0) u0 = pt[0]; if (pt[0] > u1) u1 = pt[0]
        if (pt[1] < v0) v0 = pt[1]; if (pt[1] > v1) v1 = pt[1]
      }
      for (let cxi = Math.floor(u0 / cell); cxi <= Math.floor(u1 / cell); cxi++) {
        for (let cyi = Math.floor(v0 / cell); cyi <= Math.floor(v1 / cell); cyi++) {
          const key = cxi + ':' + cyi
          const list = cells.get(key)
          if (list) list.push(i); else cells.set(key, [i])
        }
      }
    })
    return { cell, cells }
  }, [result])

  /** Který obrys je pod bodem (ve světových jednotkách)? `null`, když žádný v dosahu. */
  function pickPoly(w: Pt2, tolWorld: number): number | null {
    const { cell, cells } = polyIndex
    const cx0 = Math.floor((w[0] - tolWorld) / cell)
    const cx1 = Math.floor((w[0] + tolWorld) / cell)
    const cy0 = Math.floor((w[1] - tolWorld) / cell)
    const cy1 = Math.floor((w[1] + tolWorld) / cell)
    let best: number | null = null
    let bestD = tolWorld
    const seen = new Set<number>()
    for (let cxi = cx0; cxi <= cx1; cxi++) {
      for (let cyi = cy0; cyi <= cy1; cyi++) {
        for (const i of cells.get(cxi + ':' + cyi) ?? []) {
          if (seen.has(i)) continue
          seen.add(i)
          const p = result.polys[i]
          if (skipLine(p)) continue
          if (minSize > 0 && Math.max(p.width, p.height) < minSize) continue
          for (let k = 1; k < p.pts.length; k++) {
            const d = segDist(w, p.pts[k - 1], p.pts[k])
            if (d < bestD) { bestD = d; best = i }
          }
        }
      }
    }
    return best
  }

  /**
   * Obrysy po hromádkách místo jednoho prvku na obrys.
   *
   * Hustý pohled má i po slití desetitisíce čar. Jako samostatné `<polyline>` to znamená
   * desetitisíce uzlů, které musí React při každém posunu porovnat a prohlížeč hit-testovat
   * při každém hnutí myší — okno se pak táhne. Takhle z toho je pár `<path>`, jeden na
   * kombinaci druhu čáry a barvy, a najíždění řeší rejstřík výš.
   *
   * Výplně jdou do jedné cesty s pravidlem even-odd, takže díry vyjdou samy od sebe.
   */
  const pathEls = useMemo(() => {
    type Bucket = { d: string[]; stroke: string; width: number; opacity: number; dash?: string }
    const strokes = new Map<string, Bucket>()
    const fills = new Map<string, string[]>()

    for (const p of result.polys) {
      if (skipLine(p)) continue
      if (minSize > 0 && Math.max(p.width, p.height) < minSize) continue
      const d = p.pts
        .map((pt, i) => (i ? 'L' : 'M') + ((pt[0] - view.cx) * view.s + VB_W / 2).toFixed(2) + ' ' + (-(pt[1] - view.cy) * view.s + VB_H / 2).toFixed(2))
        .join('')
      const key = groupMode === 'group' ? p.group : p.object
      // kontext z tloušťky i promítnuté hrany pohledu jdou slabě; řez a okolí plně
      /**
       * Pohled je šedý, ŘEZ je barevný — a kontext z tloušťky je pořád řez, jen o kousek
       * vedle roviny, takže barvu materiálu dostane taky (jen čárkovaně a slaběji). Dokud
       * se kreslil šedě jako pohled, vypadalo to, že řez některé prvky prostě nebere.
       */
      const isView = p.projected
      const isCtx = p.depth !== 0 && !p.nearby
      const col = isView ? inkSoft : colorOf(key)

      if (showFill && !isView && !isCtx && p.closed) {
        const list = fills.get(col)
        if (list) list.push(d + 'Z'); else fills.set(col, [d + 'Z'])
      }
      const kind = isView ? (p.hidden ? 'vh' : 'v') : isCtx ? 'c' : p.nearby ? 'n' : p.closed ? 'k' : 'o'
      const bk = kind + '|' + col
      let b = strokes.get(bk)
      if (!b) {
        b = { d: [], stroke: col, ...LINE_STYLE[kind] }
        strokes.set(bk, b)
      }
      b.d.push(d)
    }

    const els: React.ReactNode[] = []
    for (const [k, list] of fills) {
      els.push(<path key={'f' + k} d={list.join('')} fill={k} fillOpacity={0.1} fillRule="evenodd" stroke="none" />)
    }
    for (const [k, b] of strokes) {
      els.push(
        <path
          key={'s' + k}
          d={b.d.join('')}
          fill="none"
          stroke={b.stroke}
          strokeWidth={b.width}
          strokeOpacity={b.opacity}
          strokeDasharray={b.dash}
          strokeLinejoin="round"
          strokeLinecap="round"
        />,
      )
    }
    return els
  }, [result, view, groupMode, colorOf, inkSoft, minSize, showLines, showFill])

  /** Zvýraznění: obrys pod myší a celá skupina z legendy. Jen tohle je „živé". */
  const hiEls = useMemo(() => {
    const els: React.ReactNode[] = []
    const toPath = (p: SectionPoly) => p.pts
      .map((pt, i) => (i ? 'L' : 'M') + ((pt[0] - view.cx) * view.s + VB_W / 2).toFixed(2) + ' ' + (-(pt[1] - view.cy) * view.s + VB_H / 2).toFixed(2))
      .join('')
    if (hoverGroup) {
      const d: string[] = []
      for (const p of result.polys) {
        if (skipLine(p) || (p.depth !== 0 && !p.nearby) || p.projected) continue
        if ((groupMode === 'group' ? p.group : p.object) === hoverGroup) d.push(toPath(p))
      }
      if (d.length) els.push(<path key="hg" d={d.join('')} fill="none" stroke={ACCENT} strokeWidth={2.6} strokeLinejoin="round" />)
    }
    if (hoverPoly !== null && result.polys[hoverPoly]) {
      els.push(<path key="hp" d={toPath(result.polys[hoverPoly])} fill="none" stroke={ACCENT} strokeWidth={3.2} strokeLinejoin="round" />)
    }
    return els
  }, [result, view, hoverPoly, hoverGroup, groupMode, showLines])

  /**
   * Kóty úseků: délka a sklon každé rovné části obrysu. Popisují se jen úseky, které jsou
   * dost dlouhé na to, aby se text vešel — jinak by z výkresu byla nečitelná změť.
   */
  const dimEls = useMemo(() => {
    if (!showDims) return null
    /**
     * Kótuje se podle délky NA OBRAZOVCE, ne podle podílu z rozměru výkresu.
     *
     * Dřív se prahovalo na 5 % šířky výkresu, takže na 20 m širokém řezu vypadlo všechno
     * pod metr — tedy obrubník, tloušťky, zábradlí, prakticky všechny zajímavé rozměry.
     * Takhle se okótuje všechno, na co se vejde text, a přiblížením se odkryje zbytek.
     */
    const cand: { i: number; s: ReturnType<typeof polySegments>[number]; px: number; x1: number; y1: number; x2: number; y2: number }[] = []
    for (let i = 0; i < result.polys.length; i++) {
      const p = result.polys[i]
      if (p.depth !== 0 && !p.nearby && !p.projected) continue
      if (skipLine(p) || (p.projected && p.hidden)) continue
      if (minSize > 0 && Math.max(p.width, p.height) < minSize) continue
      for (const s of polySegments(p)) {
        const x1 = (s.a[0] - view.cx) * view.s + VB_W / 2
        const y1 = -(s.a[1] - view.cy) * view.s + VB_H / 2
        const x2 = (s.b[0] - view.cx) * view.s + VB_W / 2
        const y2 = -(s.b[1] - view.cy) * view.s + VB_H / 2
        const px = Math.hypot(x2 - x1, y2 - y1)
        if (px < 52) continue                                // text by se nevešel
        cand.push({ i, s, px, x1, y1, x2, y2 })
      }
    }
    // když je jich moc, nechají se ty nejdelší — ty nesou nejvíc informace
    cand.sort((a, b) => b.px - a.px)
    /**
     * Popisky se rozmístí tak, aby se nepřekrývaly: co se nevejde ani po odsazení, se
     * vynechá. Dřív se každý posadil doprostřed svého úseku a při nahuštění z toho byla
     * změť přes sebe — čitelnost je u kóty důležitější než úplnost.
     */
    const spots = placeLabels(cand.slice(0, 400).map(c => {
      let deg = (Math.atan2(c.y2 - c.y1, c.x2 - c.x1) * 180) / Math.PI
      if (deg > 90) deg -= 180
      if (deg < -90) deg += 180
      const text = fmtLen(c.s.length) + ' · ' + c.s.angle.toFixed(1) + '°'
      return { ...c, x: (c.x1 + c.x2) / 2, y: (c.y1 + c.y2) / 2 - 6, w: text.length * 7.2, h: 15, angle: deg, text }
    }), { pad: 1.5, max: 220 })
    return spots.map(({ i, x: mx, y: my, angle: deg, text }, k) => {
      return (
        <text
          key={i + '-' + k}
          x={mx} y={my}
          transform={`rotate(${deg.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)})`}
          textAnchor="middle"
          fontSize={13}
          fontFamily="ui-monospace, monospace"
          fill={ink}
          opacity={0.85}
          style={{ pointerEvents: 'none' }}
        >
          {text}
        </text>
      )
    })
  }, [showDims, showLines, result, view, ink, minSize])

  const az = ((Math.atan2(result.normal.x, -result.normal.z) * 180) / Math.PI + 360) % 360
  const tilt = (Math.asin(Math.max(-1, Math.min(1, result.normal.y))) * 180) / Math.PI

  return createPortal(
    // nad kořenem vieweru (z-9999), protože se portáluje vedle něj, ne do něj
    <div
      className={float
        ? 'fixed z-[10000] flex flex-col rounded-xl border border-gray-700 bg-gray-950/95 shadow-2xl overflow-hidden'
        : 'fixed inset-0 z-[10000] bg-gray-950/95 flex flex-col'}
      style={float ? { left: fbox.box.x, top: fbox.box.y, width: fbox.box.w, height: fbox.box.h } : undefined}
    >
      {/*
       * Lišta má dva řádky: nahoře jméno a export (a v plovoucím okně je to zároveň úchyt
       * na tažení), dole nástroje. Na jednom řádku se to nevešlo — název se lámal a export
       * i křížek vypadávaly z okna — tlačítek je na šířku plovoucího okna moc.
       */}
      <div className="shrink-0 border-b border-gray-800 bg-gray-900/80">
        <div
          className={`h-10 flex items-center gap-2 px-3 ${float ? 'cursor-move select-none' : ''}`}
          onPointerDown={float ? fbox.startMove : undefined}
        >
          <span className="text-sm font-semibold text-gray-200 whitespace-nowrap shrink-0">Řez — 2D výkres</span>
          <span className="text-xs text-gray-500 truncate min-w-0">{name}</span>
          <div className="flex-1" />
          <button onClick={doExportDxf} title="Vektorový výkres pro CAD" className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">
            <Download size={14} /> DXF
          </button>
          <button onClick={doExportSvg} title="Výkres na bílém papíře" className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">
            <Download size={14} /> SVG
          </button>
          <button onClick={doExportPng} title="Obrázek výkresu ve 300 dpi" className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">
            <Download size={14} /> PNG
          </button>
          <button onClick={doPrint} title={`Tisk listu ${sheetFormat} v měřítku 1 : ${sheet.scale} — v dialogu lze uložit jako PDF`} className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 transition-colors">
            <Printer size={14} /> PDF
          </button>
          <div className="w-px h-5 bg-gray-700 shrink-0" />
          <button onClick={onClose} title="Zavřít" className="shrink-0 p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"><X size={18} /></button>
        </div>

        <div className="h-10 flex items-center gap-1 px-2 border-t border-gray-800/70 overflow-x-auto" style={{ scrollbarWidth: 'thin' }}>
          <button onClick={() => setView(fitView(result))} title="Vystředit na výkres"
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            <Maximize2 size={14} /> Na celý
          </button>
          <button onClick={() => { setMeasureMode(m => !m); setLevelMode(false); setCropMode(false); setPending(null) }} title="Měření ve výkrese"
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${measureMode ? 'bg-orange-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
            <Ruler size={14} /> Měřit
          </button>
          {onNewSection && (
            <button onClick={() => { setCropMode(m => !m); setCropFrom(null); setMeasureMode(false); setLevelMode(false); setPending(null) }}
              title="Nový řez odsud — vytáhni ve výkrese obdélník a vznikne kolmý řez jeho levou hranou, omezený na jeho hloubku i výšku"
              className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${cropMode ? 'bg-cyan-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
              <Scissors size={14} /> Řez odsud
            </button>
          )}
          {originZ !== null && (
            <button onClick={() => { setLevelMode(m => !m); setMeasureMode(false); setCropMode(false); setPending(null) }}
              title="Výškový bod — klikni do výkresu a připíše se nadmořská výška v soustavě modelu"
              className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${levelMode ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
              <TriangleRight size={14} /> Výška
            </button>
          )}
          {(measures.length > 0 || levels.length > 0 || pending) && (
            <button onClick={() => { setMeasures([]); setLevels([]); setPending(null) }} title="Smazat kóty a výškové body"
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
              <Trash2 size={14} />
            </button>
          )}
          <button onClick={() => setPaper(p => !p)} title={paper ? 'Tmavé pozadí' : 'Bílý papír'}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            {paper ? <Moon size={14} /> : <Sun size={14} />}
          </button>

          <div className="w-px h-5 bg-gray-800 mx-1 shrink-0" />

          {activeView && (
            <button onClick={() => setShowView(s => !s)} title="Pohled do výřezu pod obrysem — co je za rovinou vidět, se správným zakrytím"
              className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${showView ? 'bg-sky-800 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
              <Layers size={14} /> Pohled
            </button>
          )}
          {hasProjected && (
            <button
              onClick={() => setShowLines(s => (s === 'all' ? (hasHidden ? 'visible' : 'off') : s === 'visible' ? 'off' : 'all'))}
              title={hasHidden
                ? 'Obrysy pohledu — promítnuté hrany. Klikáním: vše (zakryté čárkovaně) → jen viditelné → vypnuto'
                : 'Obrysy pohledu — promítnuté hrany z výřezu, dají se kótovat a měřit'}
              className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${showLines === 'off' ? 'text-gray-400 hover:text-white hover:bg-gray-800' : 'bg-sky-900 text-white'}`}>
              <Spline size={14} /> {showLines === 'visible' ? 'Jen viditelné' : 'Obrysy'}
            </button>
          )}
          <button onClick={() => setShowFill(f => !f)}
            title="Barevná výplň uvnitř uzavřených řezných obrysů. Rastr pohledu vypíná tlačítko „Pohled“, šrafy na papíře najdeš v panelu „Papír a razítko“."
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${showFill ? 'bg-sky-900 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
            <PaintBucket size={14} /> Výplň
          </button>

          <div className="w-px h-5 bg-gray-800 mx-1 shrink-0" />

          <button onClick={() => setShowDims(d => !d)} title="Kóty úseků — délka a sklon každé rovné části obrysu"
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${showDims ? 'bg-orange-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
            <Tag size={14} /> Kóty
          </button>
          <button onClick={() => setGroupMode(m => (m === 'group' ? 'object' : 'group'))}
            title={groupMode === 'group' ? 'Barví se podle materiálu — přepnout na objekty' : 'Barví se podle objektu — přepnout na materiály'}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
            <Palette size={14} /> {groupMode === 'group' ? 'Materiál' : 'Objekt'}
          </button>
          <button onClick={() => setShowData(d => !d)} title="Rozměry a data"
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${showData ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}>
            <Table2 size={14} /> Data
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Výkres */}
        <div className="flex-1 min-w-0 relative" style={{ background: bg }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid meet"
            className="w-full h-full"
            style={{ cursor: measureMode || levelMode || cropMode ? 'crosshair' : 'grab', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
            onDragStart={e => e.preventDefault()}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => { dragRef.current = null; setCursor(null) }}
          >
            {/* mřížka */}
            <g stroke={gridCol} strokeWidth={1}>
              {grid.xs.map(x => { const [px] = toVb([x, 0]); return <line key={'gx' + x} x1={px} y1={0} x2={px} y2={VB_H} /> })}
              {grid.ys.map(y => { const [, py] = toVb([0, y]); return <line key={'gy' + y} x1={0} y1={py} x2={VB_W} y2={py} /> })}
            </g>

            {/* Pravoúhlý pohled pod obrysem. Leží ve stejných souřadnicích jako řez, takže
                se kryje na milimetry a měřit jde přes obojí. */}
            {activeView && showView && (() => {
              /**
               * Rastr je jen TÓN pod vektorovou kresbou a má pevný počet pixelů. Jakmile se
               * přiblížíš víc, než na kolik je rozlišený, přestane nést informaci a zůstanou
               * z něj rozmazané fleky — tak se místo toho plynule vytratí a zbude čistá čárová
               * kresba, která je stejně ta přesná.
               */
              const sharp = activeView.pxPerM / Math.max(view.s, 1e-6)
              const fade = Math.max(0, Math.min(1, (sharp - 0.4) / 0.6))
              if (fade <= 0) return null
              const [x0, y1] = toVb([activeView.rect.minU, activeView.rect.minV])
              const [x1, y0] = toVb([activeView.rect.maxU, activeView.rect.maxV])
              return (
                <image
                  href={activeView.url}
                  x={x0} y={y0}
                  width={Math.max(0.01, x1 - x0)}
                  height={Math.max(0.01, y1 - y0)}
                  preserveAspectRatio="none"
                  opacity={(paper ? 0.9 : 0.75) * fade}
                  style={{ pointerEvents: 'none' }}
                />
              )
            })()}

            {/* obrysy */}
            {pathEls}
            {hiEls}
            {dimEls}

            {/* celkové kóty */}
            {result.polys.length > 0 && (
              <g stroke={ACCENT} fill={ACCENT} strokeWidth={1.2} style={{ pointerEvents: 'none' }}>
                {(() => {
                  const yy = result.minV - dimOff
                  const [x1, y1] = toVb([result.minU, yy])
                  const [x2] = toVb([result.maxU, yy])
                  const [, ya] = toVb([result.minU, result.minV])
                  const [, yb] = toVb([result.minU, yy - tick])
                  return (
                    <>
                      <line x1={x1} y1={y1} x2={x2} y2={y1} />
                      <line x1={x1} y1={ya} x2={x1} y2={yb} strokeDasharray="3 3" opacity={0.6} />
                      <line x1={x2} y1={ya} x2={x2} y2={yb} strokeDasharray="3 3" opacity={0.6} />
                      <text x={(x1 + x2) / 2} y={y1 - 8} textAnchor="middle" fontSize={17} fontFamily="ui-monospace, monospace" stroke="none">
                        {fmtLen(result.width)}
                      </text>
                    </>
                  )
                })()}
                {(() => {
                  const xx = result.minU - dimOff
                  const [x1, y1] = toVb([xx, result.minV])
                  const [, y2] = toVb([xx, result.maxV])
                  const [xa] = toVb([result.minU, result.minV])
                  const [xb] = toVb([xx - tick, result.minV])
                  return (
                    <>
                      <line x1={x1} y1={y1} x2={x1} y2={y2} />
                      <line x1={xa} y1={y1} x2={xb} y2={y1} strokeDasharray="3 3" opacity={0.6} />
                      <line x1={xa} y1={y2} x2={xb} y2={y2} strokeDasharray="3 3" opacity={0.6} />
                      <text x={x1 - 8} y={(y1 + y2) / 2} textAnchor="middle" fontSize={17} fontFamily="ui-monospace, monospace" stroke="none"
                        transform={`rotate(-90 ${x1 - 8} ${(y1 + y2) / 2})`}>
                        {fmtLen(result.height)}
                      </text>
                    </>
                  )
                })()}
              </g>
            )}

            {/* měření uvnitř výkresu */}
            <g style={{ pointerEvents: 'none' }}>
              {measures.map((m, i) => {
                const [x1, y1] = toVb(m.a)
                const [x2, y2] = toVb(m.b)
                const dist = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1])
                return (
                  <g key={'m' + i} stroke="#38bdf8" fill="#38bdf8">
                    <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={2} />
                    <circle cx={x1} cy={y1} r={4} stroke="none" />
                    <circle cx={x2} cy={y2} r={4} stroke="none" />
                    <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 9} textAnchor="middle" fontSize={16} fontFamily="ui-monospace, monospace" stroke="none">
                      {fmtLen(dist)}
                    </text>
                  </g>
                )
              })}
              {pending && cursor && (() => {
                const [x1, y1] = toVb(pending)
                const [x2, y2] = toVb(cursor)
                const dist = Math.hypot(cursor[0] - pending[0], cursor[1] - pending[1])
                return (
                  <g stroke="#38bdf8" fill="#38bdf8" opacity={0.8}>
                    <line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={1.5} strokeDasharray="5 4" />
                    <circle cx={x1} cy={y1} r={4} stroke="none" />
                    <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 9} textAnchor="middle" fontSize={16} fontFamily="ui-monospace, monospace" stroke="none">
                      {fmtLen(dist)}
                    </text>
                  </g>
                )
              })()}
              {measureMode && cursor && (() => {
                const [x, y] = toVb(cursor)
                return <circle cx={x} cy={y} r={5} fill="none" stroke="#38bdf8" strokeWidth={1.5} />
              })()}
            </g>

            {/* výškové body */}
            <g style={{ pointerEvents: 'none' }}>
              {levels.map((q, i) => {
                const [x, y] = toVb(q)
                return (
                  <g key={'lv' + i} stroke="#facc15" fill="#facc15">
                    {/* trojúhelníček špičkou do bodu, jako výšková kóta ve výkrese */}
                    <path d={`M${x} ${y} L${x - 7} ${y - 12} L${x + 7} ${y - 12} Z`} strokeWidth={1.5} fillOpacity={0.25} />
                    <line x1={x - 13} y1={y - 12} x2={x + 13} y2={y - 12} strokeWidth={1.5} />
                    <text x={x} y={y - 16} textAnchor="middle" fontSize={16} fontFamily="ui-monospace, monospace" stroke="none">
                      {elevText(q)}
                    </text>
                  </g>
                )
              })}
              {levelMode && cursor && (() => {
                const [x, y] = toVb(cursor)
                return (
                  <g stroke="#facc15" fill="#facc15" opacity={0.7}>
                    <path d={`M${x} ${y} L${x - 7} ${y - 12} L${x + 7} ${y - 12} Z`} strokeWidth={1.5} fillOpacity={0.15} />
                    <text x={x} y={y - 16} textAnchor="middle" fontSize={16} fontFamily="ui-monospace, monospace" stroke="none">
                      {elevText(cursor)}
                    </text>
                  </g>
                )
              })()}
            </g>

            {cropMode && cropFrom && cursor && (() => {
              const [x1, y1] = toVb(cropFrom)
              const [x2, y2] = toVb(cursor)
              const w = Math.abs(x2 - x1)
              const h = Math.abs(y2 - y1)
              return (
                <g style={{ pointerEvents: 'none' }}>
                  <rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={w} height={h}
                    fill="#22d3ee" fillOpacity={0.08} stroke="#22d3ee" strokeWidth={1.5} strokeDasharray="6 4" />
                  <text x={(x1 + x2) / 2} y={Math.min(y1, y2) - 8} textAnchor="middle" fontSize={15}
                    fontFamily="ui-monospace, monospace" fill="#22d3ee">
                    {fmtLen(Math.abs(cursor[0] - cropFrom[0]))} × {fmtLen(Math.abs(cursor[1] - cropFrom[1]))}
                  </text>
                </g>
              )
            })()}

            {/* měřítko + krok mřížky */}
            <g transform={`translate(24 ${VB_H - 34})`} stroke={ink} fill={ink} style={{ pointerEvents: 'none' }}>
              <line x1={0} y1={0} x2={scaleBar.px} y2={0} strokeWidth={2} />
              <line x1={0} y1={-6} x2={0} y2={6} strokeWidth={2} />
              <line x1={scaleBar.px} y1={-6} x2={scaleBar.px} y2={6} strokeWidth={2} />
              <text x={scaleBar.px / 2} y={-12} textAnchor="middle" fontSize={15} fontFamily="ui-monospace, monospace" stroke="none">
                {fmtLen(scaleBar.len)}
              </text>
              <text x={0} y={20} fontSize={12} fill={inkSoft} stroke="none" fontFamily="ui-monospace, monospace">
                mřížka {fmtLen(grid.step)}
              </text>
            </g>

            {/* popisky os */}
            <text x={VB_W - 20} y={VB_H - 20} textAnchor="end" fontSize={13} fill={inkSoft} fontFamily="ui-monospace, monospace">
              vodorovně {result.uLabel} · svisle {result.vLabel}
            </text>
          </svg>

          {cursor && (
            <div className="absolute top-2 left-3 text-[11px] font-mono px-2 py-1 rounded bg-gray-900/80 border border-gray-700 text-gray-300 pointer-events-none">
              {cursor[0].toFixed(3)} ; {cursor[1].toFixed(3)} m
              {originZ !== null && <span className="ml-2 text-amber-300">▲ {elevText(cursor)}</span>}
              {measureMode && <span className="text-sky-400 ml-2">{pending ? 'druhý bod' : 'první bod'}</span>}
            </div>
          )}

          {/* Co je pod kurzorem — bez tohohle se u drobného útržku nedá poznat, odkud je */}
          {hoverPoly !== null && result.polys[hoverPoly] && (() => {
            const p = result.polys[hoverPoly]
            return (
              <div className="absolute bottom-2 left-3 max-w-[22rem] rounded border border-gray-700 bg-gray-900/90 px-2 py-1.5 pointer-events-none">
                <div className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorOf(groupMode === 'group' ? p.group : p.object) }} />
                  <span className="truncate text-[11px] text-gray-200">{p.object}</span>
                  <span className="truncate text-[10px] text-gray-500">· {p.group}</span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-gray-400">
                  {fmtLen(p.width)} × {fmtLen(p.height)} · {p.closed ? fmtArea(p.area) : 'otevřená čára'} · {p.pts.length} bodů
                </div>
                <div className="font-mono text-[10px] text-gray-600">
                  {p.projected
                    ? (p.hidden ? 'zakrytý obrys pohledu, ' : 'obrys pohledu, ') + fmtLen(Math.abs(p.viewDepth)) + ' za rovinou'
                    : p.nearby
                      ? 'z okolí, ' + fmtLen(Math.abs(p.depth)) + ' od roviny'
                      : p.depth !== 0
                        ? 'kontext z tloušťky, ' + fmtLen(Math.abs(p.depth)) + ' od roviny'
                        : 'v rovině řezu'}
                </div>
              </div>
            )
          })()}
        </div>

        {/* Data */}
        <div className={`${showData ? '' : 'hidden'} ${float ? 'w-60' : 'w-72'} shrink-0 border-l border-gray-800 bg-gray-900/80 overflow-y-auto`}>
          <Section title="Rozměry">
            <Row k={'Šířka (' + result.uLabel + ')'} v={fmtLen(shown.width)} big />
            <Row k={'Výška (' + result.vLabel + ')'} v={fmtLen(shown.height)} big />
            <Row k="Plocha řezu" v={fmtArea(shown.area)} big />
            <Row k="Délka čar" v={fmtLen(shown.cutLength)} />
            <div className="flex items-baseline justify-between gap-2 pt-1">
              <span className="text-[11px] text-gray-500">Skrýt drobty pod</span>
              <span className="flex items-center gap-1">
                <input
                  type="number" min={0} max={200} step={1} value={minSizeCm}
                  onChange={e => setMinSizeCm(Math.max(0, Number(e.target.value) || 0))}
                  className="w-14 rounded border border-gray-700 bg-gray-800 px-1 py-0.5 text-right font-mono text-[11px] text-gray-200 outline-none focus:border-orange-600"
                />
                <span className="font-mono text-[10px] text-gray-500">cm</span>
              </span>
            </div>
            {hidden > 0 && <Row k="Skryto" v={String(hidden) + ' útržků'} />}
            <Row k="Uzavřené obrysy" v={String(shown.loops)} />
            <Row k="Otevřené čáry" v={String(shown.opens)} />
            {result.nearbyCount > 0 && <Row k="Přibráno z okolí" v={String(result.nearbyCount) + ' obj.'} />}
            {hasProjected && <Row k="Čáry pohledu" v={String(result.polys.filter(p => p.projected && !p.hidden).length)} />}
            {hasHidden && <Row k="Z toho zakryté" v={String(result.polys.filter(p => p.hidden).length)} />}
            {ctxCount > 0 && <Row k="Čáry z tloušťky" v={String(ctxCount)} />}
          </Section>

          <Section title="Rovina řezu">
            <Row k="Bod" v={`${result.origin.x.toFixed(3)} ; ${result.origin.y.toFixed(3)} ; ${result.origin.z.toFixed(3)}`} />
            <Row k="Normála" v={`${result.normal.x.toFixed(3)} ; ${result.normal.y.toFixed(3)} ; ${result.normal.z.toFixed(3)}`} />
            <Row k="Azimut" v={az.toFixed(1) + '°'} />
            <Row k="Sklon" v={tilt.toFixed(1) + '°'} />
          </Section>

          <Section title="Vrstvy">
            <div className="space-y-0.5">
              {KINDS.map(([kind, label]) => {
                const n = result.polys.filter(p => kindOf(p) === kind).length
                if (!n) return null
                const on = !offKinds.has(kind)
                return (
                  <button
                    key={kind}
                    onClick={() => setOffKinds(prev => {
                      const next = new Set(prev)
                      if (!next.delete(kind)) next.add(kind)
                      return next
                    })}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-800/60"
                  >
                    {on ? <Eye size={12} className="shrink-0 text-gray-400" /> : <EyeOff size={12} className="shrink-0 text-gray-600" />}
                    <svg width="26" height="10" className="shrink-0" style={{ opacity: on ? 1 : 0.3 }}>
                      <line
                        x1={1} y1={5} x2={25} y2={5}
                        stroke={kind === 'view' || kind === 'viewHidden' ? inkSoft : '#9ca3af'}
                        strokeWidth={LINE_STYLE[KIND_CODE[kind]].width}
                        strokeOpacity={LINE_STYLE[KIND_CODE[kind]].opacity}
                        strokeDasharray={LINE_STYLE[KIND_CODE[kind]].dash}
                      />
                    </svg>
                    <span className={`flex-1 truncate text-[11px] ${on ? 'text-gray-300' : 'text-gray-600 line-through'}`}>{label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-gray-600">{n}</span>
                  </button>
                )
              })}
            </div>
            <p className="pt-1 text-[10px] leading-relaxed text-gray-600">
              Barevně je ŘEZ — to, čím rovina prochází; barva podle materiálu nebo objektu.
              Šedě je POHLED — co je za rovinou vidět. Co má jen šedý obrys, rovina neprotíná.
            </p>
            {(offKinds.size > 0 || offGroups.size > 0) && (
              <button
                onClick={() => { setOffKinds(new Set()); setOffGroups(new Set()) }}
                className="mt-1 w-full rounded bg-gray-800 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-700"
              >
                Rozsvítit vše ({offKinds.size + offGroups.size} zhasnuto)
              </button>
            )}
          </Section>

          {groups.length > 0 && (
            <Section title={(groupMode === 'group' ? 'Materiály' : 'Objekty') + ' (' + groups.length + ')'}>
              <div className="space-y-0.5">
                {groups.slice(0, 30).map(g => {
                  const on = !offGroups.has(g.key)
                  return (
                    <div
                      key={g.key}
                      onMouseEnter={() => setHoverGroup(g.key)}
                      onMouseLeave={() => setHoverGroup(h => (h === g.key ? null : h))}
                      className={`rounded px-2 py-1 transition-colors ${hoverGroup === g.key ? 'bg-gray-800' : 'hover:bg-gray-800/60'}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setOffGroups(prev => {
                            const next = new Set(prev)
                            if (!next.delete(g.key)) next.add(g.key)
                            return next
                          })}
                          title={on ? 'Zhasnout tuhle vrstvu' : 'Rozsvítit'}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        >
                          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: on ? colorOf(g.key) : 'transparent', outline: on ? 'none' : '1px solid #4b5563' }} />
                          <span className={`flex-1 truncate text-[11px] ${on ? 'text-gray-300' : 'text-gray-600 line-through'}`} title={g.key}>{g.key}</span>
                          <span className="shrink-0 font-mono text-[10px] text-gray-600">{g.count}×</span>
                        </button>
                        <button
                          onClick={() => isolate(g.key)}
                          title="Nechat svítit jen tuhle vrstvu (druhý klik zase rozsvítí vše)"
                          className="shrink-0 rounded p-0.5 text-gray-600 hover:bg-gray-700 hover:text-white"
                        >
                          <Focus size={11} />
                        </button>
                      </div>
                      <div className="mt-0.5 flex justify-between pl-4 font-mono text-[10px] text-gray-500">
                        <span>{fmtLen(g.width)} × {fmtLen(g.height)}</span>
                        <span>{g.area > 0 ? fmtArea(g.area) : fmtLen(g.length)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="pt-1 text-[10px] leading-relaxed text-gray-600">
                Klik na řádek vrstvu zhasne, ikona vpravo nechá svítit jen ji. Zhasnuté vrstvy nejdou ani do DXF, SVG a tisku.
              </p>
            </Section>
          )}

          {rings.length > 0 && (
            <Section title={'Obrysy (' + rings.length + ')'}>
              <div className="space-y-0.5">
                {rings.slice(0, 40).map(({ p, i }, k) => (
                  <button
                    key={i}
                    onMouseEnter={() => setHoverPoly(i)}
                    onMouseLeave={() => setHoverPoly(h => (h === i ? null : h))}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-[11px] font-mono transition-colors ${hoverPoly === i ? 'bg-orange-900/40 text-orange-200' : 'text-gray-400 hover:bg-gray-800'}`}
                  >
                    <span className="shrink-0 text-gray-600">#{k + 1}{p.hole ? ' díra' : p.nearby ? ' okolí' : ''}</span>
                    <span>{fmtArea(p.area)}</span>
                    <span className="text-gray-500">o {fmtLen(p.length)}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}

          {result.missed.length > 0 && (
            <Section title={'Nevykresleno (' + result.missed.length + ')'}>
              <div className="space-y-0.5">
                {result.missed.slice(0, 15).map(m => (
                  <div key={m.object} className="rounded px-2 py-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex-1 truncate text-[11px] text-gray-300" title={m.object}>{m.object}</span>
                      <span className="shrink-0 font-mono text-[10px] text-orange-300">{fmtLen(m.gap)}</span>
                    </div>
                    <div className="font-mono text-[10px] text-gray-600">{m.reason}</div>
                  </div>
                ))}
              </div>
              <p className="pt-1 text-[10px] leading-relaxed text-gray-600">
                Objekty u roviny, ze kterých ve výkrese nic není, od nejbližšího. Číslo je mezera k rovině —
                stačí zvednout „Přibrat objekty z okolí“ nad ni.
              </p>
            </Section>
          )}

          {levelList.length > 0 && (
            <Section title={'Výškové body (' + levelList.length + ')'}>
              {levelList.map((lv, i) => (
                <div key={'lv' + i} className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
                  <span className="truncate text-gray-500">{lv.p[0].toFixed(2)} ; {lv.p[1].toFixed(2)}</span>
                  <span className="shrink-0 text-amber-300">{lv.z.toFixed(3)} m</span>
                </div>
              ))}
              <p className="pt-1 text-[10px] leading-relaxed text-gray-600">
                Výška je v soustavě, ve které model přišel — u georeferencovaného S-JTSK modelu Bpv.
                Body jdou i na papír a do DXF (hladina RIZ_VYSKY).
              </p>
            </Section>
          )}

          {measures.length > 0 && (
            <Section title={'Změřeno (' + measures.length + ')'}>
              {measures.map((m, i) => (
                <Row key={i} k={'kóta ' + (i + 1)} v={fmtLen(Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]))} />
              ))}
            </Section>
          )}

          <Section title="Papír a razítko">
            <div className="flex items-center gap-1.5">
              <select value={sheetFormat} onChange={e => setSheetFormat(e.target.value as SheetFormat)} title="Formát papíru"
                className="flex-1 rounded-md bg-gray-800 px-1.5 py-1 text-[11px] text-gray-200 outline-none">
                <option value="A4">A4</option>
                <option value="A3">A3</option>
                <option value="A2">A2</option>
              </select>
              <select value={sheetLandscape ? 'l' : 'p'} onChange={e => setSheetLandscape(e.target.value === 'l')} title="Orientace"
                className="flex-1 rounded-md bg-gray-800 px-1.5 py-1 text-[11px] text-gray-200 outline-none">
                <option value="l">na šířku</option>
                <option value="p">na výšku</option>
              </select>
              <select value={sheetScale} onChange={e => setSheetScale(Number(e.target.value))} title="Měřítko výkresu"
                className="flex-1 rounded-md bg-gray-800 px-1.5 py-1 text-[11px] text-gray-200 outline-none">
                <option value={0}>auto</option>
                {SCALES.map(s => <option key={s} value={s}>1 : {s}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-gray-500">Vyjde na</span>
              <span className={`font-mono ${sheet.fits ? 'text-gray-300' : 'text-red-400'}`}>
                1 : {sheet.scale}{sheet.fits ? '' : ' — nevejde se'}
              </span>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={sheetHatch} onChange={e => setSheetHatch(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              Šrafovat řezné plochy
            </label>
            {([
              ['stavba', 'Stavba'],
              ['objekt', 'Objekt'],
              ['vykres', 'Název výkresu'],
              ['vypracoval', 'Vypracoval'],
              ['datum', 'Datum'],
              ['cislo', 'Číslo výkresu'],
            ] as [keyof TitleBlock, string][]).map(([field, label]) => (
              <label key={field} className="flex items-center gap-2 text-[11px] text-gray-400">
                <span className="w-24 shrink-0">{label}</span>
                <input
                  value={title[field]}
                  onChange={e => setTitle(t => ({ ...t, [field]: e.target.value }))}
                  className="min-w-0 flex-1 rounded-md bg-gray-800 px-1.5 py-1 text-[11px] text-gray-200 outline-none focus:ring-1 focus:ring-cyan-600"
                />
              </label>
            ))}
          </Section>

          <Section title="Výpočet">
            <Row k="Objektů" v={String(result.meshCount)} />
            <Row k="Trojúhelníků" v={result.triCount.toLocaleString('cs')} />
            <Row k="Čas" v={result.ms.toFixed(0) + ' ms'} />
          </Section>

          <p className="px-3 pb-4 text-[10px] text-gray-600 leading-relaxed">
            Kolečkem zoom, tažením posun. „Měřit" přichytává na vrcholy obrysu.
            DXF je ve skutečných metrech, počátek = bod roviny; hladiny mají barvy i typ čáry, šrafy a kóty jdou na vlastní.
            SVG, PNG i tisk jdou na list papíru v pevném měřítku — dá se z nich měřit pravítkem.
          </p>
        </div>
      </div>

      {/* úchyt na změnu velikosti okna */}
      {float && (
        <div
          onPointerDown={fbox.startSize}
          title="Změnit velikost okna"
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          style={{ background: 'linear-gradient(135deg, transparent 50%, #4b5563 50%)' }}
        />
      )}
    </div>,
    document.body,
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-3 border-b border-gray-800">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Row({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-gray-500 shrink-0">{k}</span>
      <span className={`font-mono text-right ${big ? 'text-sm text-orange-300' : 'text-[11px] text-gray-300'}`}>{v}</span>
    </div>
  )
}

function fileBase(name: string) {
  return 'rez-' + name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40)
}

