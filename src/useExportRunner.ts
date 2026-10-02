/**
 * Dlouhé exporty — jeden ukazatel průběhu, jedno zrušení, jedno místo na chyby.
 *
 * Vlastní práci dělají moduly v `export/`; ty o komponentě nevědí nic a dostanou jen
 * `ExportCtx` (signál zrušení + hlášení průběhu) a vrátí hlášku pro úspěšný toast. Tady
 * zůstala obsluha: zamknout tlačítka, nastavit ukazatel, přeložit chybu na toast a uklidit.
 *
 * Kanály jsou dva, protože panel má dva ukazatele: jeden u dlaždic a jeden u výřezu. Nejsou
 * to dvě fronty — běžet může vždycky jen jeden export a `abort` platí na ten právě běžící.
 */
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { isAbortError } from './config'
import type { ExportCtx } from './export/ctx'

/** kam se hlásí průběh: stav tlačítka, procenta a text fáze */
export type ExportUi = {
  busy: boolean
  setBusy: (b: boolean) => void
  setPct: (p: number) => void
  setMsg: (m: string) => void
}

export type ExportRunner = ReturnType<typeof useExportRunner>

export function useExportRunner() {
  const abortRef = useRef<AbortController | null>(null)

  // kanál dlaždic
  const [tileBusy, setTileBusy] = useState(false)
  const [tileProgress, setTileProgress] = useState('')
  const [tilePct, setTilePct] = useState(-1)   // 0..1 = určitý průběh (stahování), -1 = neurčitý

  // kanál výřezu (terén + ortofoto, mapy, dávkové exporty)
  const [cutoutBusy, setCutoutBusy] = useState(false)
  const [cutoutProgress, setCutoutProgress] = useState('')
  const [cutoutPct, setCutoutPct] = useState(-1)

  const tileUi: ExportUi = { busy: tileBusy, setBusy: setTileBusy, setPct: setTilePct, setMsg: setTileProgress }
  const cutoutUi: ExportUi = { busy: cutoutBusy, setBusy: setCutoutBusy, setPct: setCutoutPct, setMsg: setCutoutProgress }

  async function runExport(ui: ExportUi, failMsg: string, job: (ctx: ExportCtx) => Promise<string>) {
    if (ui.busy) return
    const ac = new AbortController()
    abortRef.current = ac
    ui.setBusy(true); ui.setPct(-1); ui.setMsg('připravuji…')
    try {
      toast.success(await job({ signal: ac.signal, report: (pct, msg) => { ui.setPct(pct); ui.setMsg(msg) } }))
    } catch (e) {
      if (isAbortError(e)) { toast.info('Export zrušen'); return }
      console.error(`${failMsg}:`, e)
      toast.error(e instanceof Error ? e.message : failMsg)
    } finally {
      abortRef.current = null
      ui.setBusy(false); ui.setMsg(''); ui.setPct(-1)
    }
  }

  /** Zruší právě běžící export (a cokoli jiného, co si vzalo `abortRef`). */
  function cancelExport() { abortRef.current?.abort() }

  return {
    runExport, cancelExport, abortRef, tileUi, cutoutUi,
    tileBusy, tileProgress, tilePct,
    cutoutBusy, cutoutProgress, cutoutPct,
  }
}
