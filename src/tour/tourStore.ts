/**
 * Průvodce aplikací — jestli je zapnutý, kde uživatel skončil a které kapitoly prošel.
 *
 * Ukládá se k ÚČTU (Supabase `user_metadata.geo_tour`), takže platí na každém počítači —
 * bez úpravy databáze, metadata si přihlášený uživatel zapisuje sám. Kopie v localStorage
 * drží stav bez přihlášení (veřejný prohlížeč, kouřový test) a přes výpadek sítě.
 *
 * Nový uživatel (účet založený po `TOUR_SINCE`) dostane průvodce jednou nabídnutý po prvním
 * přihlášení (přehled scén). Kdo odmítne nebo ho vypne, zapne si ho v nastavení účtu nebo
 * v přehledu zkratek v mapě.
 */
import { create } from 'zustand'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'

/** Účty založené od tohoto dne dostanou průvodce nabídnutý po prvním přihlášení. */
export const TOUR_SINCE = '2026-10-07T00:00:00Z'

export type TourPrefs = {
  /** zapnutý průvodce se ve scéně ukazuje (od místa, kde uživatel skončil) */
  on: boolean
  chapter: number
  step: number
  /** id prošlých kapitol */
  done: string[]
  /** nabídka po prvním přihlášení už padla (ať se neptá znovu) */
  asked: boolean
}

const EMPTY: TourPrefs = { on: false, chapter: 0, step: 0, done: [], asked: false }
const META = 'geo_tour'
const localKey = (uid: string | null) => `geo.tour.${uid ?? 'host'}`

type TourState = {
  prefs: TourPrefs
  /** nabídnout průvodce (nový účet, ještě se neptal) */
  offer: boolean
  /** změna stavu (uloží se lokálně hned, k účtu s malým odkladem) */
  set: (patch: Partial<TourPrefs>) => void
  /** zapnout — od začátku, od dané kapitoly, nebo tam, kde uživatel skončil */
  start: (from?: 'resume' | 'beginning' | number) => void
  stop: () => void
}

function parse(v: unknown): TourPrefs | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Partial<TourPrefs>
  return {
    on: !!o.on,
    chapter: Number.isInteger(o.chapter) ? o.chapter! : 0,
    step: Number.isInteger(o.step) ? o.step! : 0,
    done: Array.isArray(o.done) ? o.done.filter(x => typeof x === 'string') : [],
    asked: !!o.asked,
  }
}

function readLocal(uid: string | null): TourPrefs | null {
  try { const v = localStorage.getItem(localKey(uid)); return v ? parse(JSON.parse(v)) : null } catch { return null }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let uid: string | null = null
let canSaveRemote = false

/** K účtu s odkladem — krokování průvodce by jinak posílalo požadavek za každé „Další". */
function save(prefs: TourPrefs) {
  try { localStorage.setItem(localKey(uid), JSON.stringify(prefs)) } catch { /* jen pohodlí */ }
  if (!canSaveRemote) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    supabase.auth.updateUser({ data: { [META]: prefs } }).then(({ error }) => {
      if (error) console.warn('Stav průvodce se k účtu neuložil:', error.message)
    }, (e: unknown) => console.warn('Stav průvodce se k účtu neuložil:', e))
  }, 1200)
}

export const useTourStore = create<TourState>((set, get) => ({
  prefs: EMPTY,
  offer: false,
  set: patch => {
    const prefs = { ...get().prefs, ...patch }
    set({ prefs, offer: get().offer && !prefs.asked })
    save(prefs)
  },
  start: from => {
    const p = get().prefs
    if (from === 'beginning') get().set({ on: true, asked: true, chapter: 0, step: 0, done: [] })
    else if (typeof from === 'number') get().set({ on: true, asked: true, chapter: from, step: 0 })
    else get().set({ on: true, asked: true, chapter: p.chapter, step: p.step })
  },
  stop: () => get().set({ on: false, asked: true }),
}))

/**
 * Stav průvodce podle přihlášeného uživatele. Načítá se jen při ZMĚNĚ uživatele, ne při
 * každé aktualizaci jeho objektu — uložení metadat vrátí upraveného uživatele a znovunačtení
 * by přepsalo krok, na který se mezitím pokročilo.
 */
function load(user: User | null) {
  const id = user && !user.is_anonymous ? user.id : null
  if (id === uid && useTourStore.getState().prefs !== EMPTY) return
  uid = id
  canSaveRemote = !!id
  const remote = id ? parse(user?.user_metadata?.[META]) : null
  const prefs = remote ?? readLocal(id) ?? EMPTY
  const isNew = !!user && !user.is_anonymous && !!user.created_at && user.created_at >= TOUR_SINCE
  useTourStore.setState({ prefs, offer: isNew && !prefs.asked })
}

load(useAuthStore.getState().user)
useAuthStore.subscribe(s => load(s.user))
