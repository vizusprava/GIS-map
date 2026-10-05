/**
 * Potvrzovací a dotazovací okno appky — místo systémového `confirm()` a `prompt()`.
 *
 * Systémové okno vypadá v každém prohlížeči jinak, nahoře píše „Web localhost říká" a nedá se
 * nastylovat ani rozšířit (tlačítko „Smazat" místo „OK", červená u nevratných věcí). Tohle je
 * totéž jako slib:
 *
 *     if (!(await ask({ title: 'Smazat pohled?', okLabel: 'Smazat', danger: true }))) return
 *     const name = await askText({ title: 'Název řezu', value: 'Řez 1' })   // null = zrušeno
 *
 * Okno kreslí `<DialogHost />` (main.tsx). Enter potvrdí, Esc nebo klik vedle zruší. Dokud je
 * otevřené, žádná klávesa nedojde k mapě — zkratky nástrojů, Esc ani šipky pohledů pod ním
 * nesmí nic dělat. Bez hostitele (testy v Node) se sáhne po systémovém okně.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

type Base = {
  title: string
  /** text pod nadpisem; řádky z `\n` se zachovají */
  message?: ReactNode
  okLabel?: string
  cancelLabel?: string
  /** nevratná akce (mazání) — potvrzovací tlačítko je červené */
  danger?: boolean
}
type Req =
  | (Base & { kind: 'confirm'; resolve: (ok: boolean) => void })
  | (Base & { kind: 'prompt'; value: string; resolve: (v: string | null) => void })

const queue: Req[] = []
let wake: (() => void) | null = null
let showing = false

/**
 * Je okno otevřené? Kdo poslouchá klávesy v zachytávací fázi (Esc u panelů lišty, přehled zkratek),
 * musí ho nechat být — jinak by Esc zavřel panel pod oknem a okno by ho vůbec nedostalo.
 */
export const isDialogOpen = () => showing || modals > 0

/** Je otevřené právě tohle okno (ask/askText)? Pro větší okna, nad kterými se může objevit. */
export const isAskOpen = () => showing

let modals = 0
/**
 * Větší vlastní okno (sdílení scény): dokud je otevřené, hlásí se v `isDialogOpen`, ať mu
 * lišta mapy nesebere Esc.
 */
export function useModal() {
  useEffect(() => { modals++; return () => { modals-- } }, [])
}

function enqueue(r: Req) {
  queue.push(r)
  wake?.()
}

/** Potvrzení: true = potvrdil, false = zrušil. */
export function ask(o: Base): Promise<boolean> {
  if (!wake) return Promise.resolve(window.confirm([o.title, o.message].filter(Boolean).join('\n\n')))
  return new Promise(resolve => enqueue({ ...o, kind: 'confirm', resolve }))
}

/** Dotaz na text: vrátí zadaný text (oříznutý), nebo null, když zrušil nebo nechal prázdné. */
export function askText(o: Base & { value?: string }): Promise<string | null> {
  if (!wake) return Promise.resolve(window.prompt(o.title, o.value ?? '')?.trim() || null)
  return new Promise(resolve => enqueue({ ...o, kind: 'prompt', value: o.value ?? '', resolve }))
}

export function DialogHost() {
  const [cur, setCur] = useState<Req | null>(null)
  const [text, setText] = useState('')
  // otevřená žádost i mimo render — vyzvednutí z fronty nesmí běžet ve funkci pro setState,
  // tu StrictMode volá dvakrát a druhé vyzvednutí by žádost ztratilo
  const curRef = useRef<Req | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // další žádost z fronty, jakmile je okno volné
  useEffect(() => {
    const next = () => {
      if (curRef.current || !queue.length) return
      const r = queue.shift() as Req
      curRef.current = r
      setText(r.kind === 'prompt' ? r.value : '')
      setCur(r)
    }
    wake = next
    next()
    return () => { wake = null }
  }, [])
  useEffect(() => { if (!cur) wake?.() }, [cur])

  const close = (ok: boolean) => {
    if (!cur) return
    if (cur.kind === 'confirm') cur.resolve(ok)
    else cur.resolve(ok ? text.trim() || null : null)
    curRef.current = null
    setCur(null)
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    showing = !!cur
    if (!cur) return
    const prev = document.activeElement as HTMLElement | null
    if (cur.kind === 'prompt') { inputRef.current?.focus(); inputRef.current?.select() } else okRef.current?.focus()
    // Klávesy mimo okno (fokus zůstal na mapě) se pohltí ještě v zachytávací fázi, ať je nedostanou
    // zkratky nástrojů ani Esc v MapView. Esc a Enter se tu rovnou vyřídí.
    const onKey = (e: KeyboardEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return
      e.stopImmediatePropagation()
      e.preventDefault()
      if (e.key === 'Escape') closeRef.current(false)
      if (e.key === 'Enter') closeRef.current(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.() }
  }, [cur])

  if (!cur) return null
  const okCls = cur.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-teal-600 hover:bg-teal-500'
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
      // klik vedle okna ho zruší; žádný klik z okna nedojde k mapě ani k liště (zavřela by panel pod ním)
      onPointerDown={e => { e.stopPropagation(); if (e.target === e.currentTarget) close(false) }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={cur.title}
        data-dialog
        // klávesy v okně: Enter / Esc vyřídí okno a nic nepustí dál k mapě
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Escape') { e.preventDefault(); close(false) }
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); close(true) }
        }}
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-gray-700 bg-gray-900 p-4 text-gray-100 shadow-2xl"
      >
        <div className="text-sm font-medium">{cur.title}</div>
        {cur.message && <div className="whitespace-pre-line text-xs leading-relaxed text-gray-300">{cur.message}</div>}
        {cur.kind === 'prompt' && (
          <input
            ref={inputRef}
            value={text}
            onChange={e => setText(e.target.value)}
            className="rounded-lg bg-gray-800 px-2.5 py-1.5 text-sm text-gray-100 outline-none ring-1 ring-gray-700 focus:ring-teal-600"
          />
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => close(false)} data-dialog-cancel className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700">
            {cur.cancelLabel ?? 'Zrušit'}
          </button>
          <button ref={okRef} onClick={() => close(true)} data-dialog-ok className={`rounded-lg px-3 py-1.5 text-xs text-white ${okCls}`}>
            {cur.okLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
