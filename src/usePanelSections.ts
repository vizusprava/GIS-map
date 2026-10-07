/**
 * Sekce levého panelu: co je sbalené, sjetí k sekci, která právě vznikla, a soustředění panelu
 * na zapnutý nástroj.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SectionFocus } from './ui'
import type { ToolId } from './toolColors'

const OPEN_KEY = 'geo.opensec'

/** kontextové sekce, které se po objevení rozbalí a panel k nim sjede (viz `revealSection`) */
export type RevealFlags = { parcely: boolean; dlazdice: boolean; uzemi: boolean; model: boolean; mestcast: boolean; rastr: boolean }

/** na co se panel soustředí — viz `SectionFocus` (ui.tsx) */
export type FocusTarget = { id: string; tool: ToolId; also?: readonly string[]; keep?: readonly string[] }

export function usePanelSections(deps: {
  /** které kontextové sekce právě existují */
  reveal: RevealFlags
  /** sekce zapnutého nástroje / vybraného modelu (null = nic, nebo jeho sekce ještě není) */
  focusTarget: FocusTarget | null
  /** nástroj se dá zapnout i se zavřeným panelem — nastavení má být vidět */
  openPanel: () => void
}) {
  const { reveal, focusTarget, openPanel } = deps

  // Sbalení sekcí. Klíč chybí = použij výchozí hodnotu sekce, takže nové sekce nemusí nic
  // doplňovat a stav přežije i jejich přejmenování.
  const [openSec, setOpenSec] = useState<Record<string, boolean>>(() => {
    try { const v = localStorage.getItem(OPEN_KEY); if (v) return JSON.parse(v) as Record<string, boolean> } catch { /* */ }
    return {}
  })
  const remember = (v: Record<string, boolean>) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(v)) } catch { /* */ } }
  // Sekce, na které uživatel sám klikl, zatímco panel drží nástroj (viz `sectionFocus` níž) —
  // ty se pak řídí jeho volbou, ne nástrojem. Se začátkem i koncem soustředění se maže.
  const [secTouched, setSecTouched] = useState<ReadonlySet<string>>(() => new Set())
  const toggleSec = (id: string, next: boolean) => {
    setSecTouched(s => (s.has(id) ? s : new Set(s).add(id)))
    setOpenSec(prev => { const v = { ...prev, [id]: next }; remember(v); return v })
  }

  // Kontextové sekce (Parcely, Dlaždice, Vybraný model…) existují jen když je co ukazovat.
  // Sedí hned pod tím, co je vyrobilo, ale panel může být odscrollovaný jinde — po objevení
  // je proto rozbalíme a sjedeme k nim, ať se po výběru nemusí nic hledat.
  const panelScrollRef = useRef<HTMLDivElement>(null)
  const scrollTo = (id: string) => requestAnimationFrame(() => {
    panelScrollRef.current?.querySelector(`[data-sec="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
  function revealSection(id: string) {
    setOpenSec(prev => {
      if (prev[id] !== false) return prev            // sbalená jen když ji uživatel sám zavřel
      const v = { ...prev, [id]: true }
      remember(v)
      return v
    })
    scrollTo(id)
  }
  // Sleduje se jen „je / není", ne obsah — jinak by panel poskakoval při každé přidané parcele.
  // Pořadí efektů je schválně stejné jako dřív v MapView: nejdřív tyhle, pak soustředění na
  // nástroj — když chtějí obojí naráz, vyhraje (sjede poslední) sekce nástroje.
  useEffect(() => { if (reveal.parcely) revealSection('parcely') }, [reveal.parcely]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reveal.dlazdice) revealSection('dlazdice') }, [reveal.dlazdice]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reveal.uzemi) revealSection('uzemi') }, [reveal.uzemi]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reveal.model) revealSection('model') }, [reveal.model]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reveal.mestcast) revealSection('mestcast') }, [reveal.mestcast]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reveal.rastr) revealSection('rastr') }, [reveal.rastr]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Soustředění panelu na zapnutý nástroj: jeho sekce se rozbalí a obarví barvou nástroje
   * (`toolColors.ts`), ostatní se sbalí, ať je hned po ruce, co k nástroji patří. Začne, až
   * sekce existuje, a skončí vypnutím nástroje — panel se pak vrátí, jak byl (viz `SectionFocus`).
   * Stejně se chová vybraný model (klik na model v mapě): drží ho, dokud je vybraný.
   */
  const focusId = focusTarget?.id ?? null
  const focusTool = focusTarget?.tool ?? null
  // pole přicházejí každým renderem nová — porovnává se obsah
  const alsoKey = focusTarget?.also?.join('\n') ?? ''
  const keepKey = focusTarget?.keep?.join('\n') ?? ''
  useEffect(() => {
    setSecTouched(new Set())
    if (!focusId) return
    openPanel()
    scrollTo(focusId)
  }, [focusId]) // eslint-disable-line react-hooks/exhaustive-deps
  const sectionFocus = useMemo<SectionFocus>(
    () => (focusId && focusTool
      ? { id: focusId, tool: focusTool, touched: secTouched, also: alsoKey ? alsoKey.split('\n') : [], keep: keepKey ? keepKey.split('\n') : [] }
      : null),
    [focusId, focusTool, secTouched, alsoKey, keepKey],
  )

  return { openSec, toggleSec, panelScrollRef, sectionFocus }
}
