/**
 * Přihlášený uživatel — jediný zdroj pravdy o session.
 *
 * `init()` se pustí jednou při startu: nejdřív obnoví session z localStorage (aby se po
 * reloadu neblikala přihlašovací stránka) a pak už jen naslouchá změnám ze Supabase
 * (odhlášení v jiné záložce, expirovaný token, potvrzení e-mailu přes odkaz).
 */
import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { Profile } from '../lib/types'

type AuthState = {
  user: User | null
  profile: Profile | null
  /** true, dokud neproběhlo první obnovení session — teprve pak se smí rozhodovat o přesměrování */
  loading: boolean
  /** uživatel přišel z odkazu „zapomenuté heslo“ → místo appky se ukáže formulář na nové heslo */
  recovery: boolean
  init: () => () => void
  signIn: (email: string, password: string) => Promise<void>
  /** Vrací true, když Supabase čeká na potvrzení e-mailu (session zatím není). */
  signUp: (email: string, password: string, displayName: string) => Promise<boolean>
  resetPassword: (email: string) => Promise<void>
  setPassword: (password: string) => Promise<void>
  signOut: () => Promise<void>
}

/** Chyby ze Supabase chodí anglicky — nejčastější přeložíme, ostatní pustíme dál. */
function czech(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) return 'Nesprávný e-mail nebo heslo.'
  if (m.includes('email not confirmed')) return 'E-mail ještě není potvrzený — mrkni do pošty na odkaz.'
  if (m.includes('user already registered') || m.includes('already been registered')) return 'Účet s tímto e-mailem už existuje.'
  if (m.includes('password should be at least')) return 'Heslo musí mít alespoň 6 znaků.'
  if (m.includes('unable to validate email') || m.includes('invalid email')) return 'Neplatná e-mailová adresa.'
  if (m.includes('rate limit') || m.includes('too many requests')) return 'Příliš mnoho pokusů — zkus to za chvíli.'
  return message
}

export const useAuthStore = create<AuthState>((set, _get) => ({
  user: null,
  profile: null,
  loading: true,
  recovery: false,

  init: () => {
    void (async () => {
      const { data } = await supabase.auth.getSession()
      await applySession(data.session, set)
      set({ loading: false })
    })()

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') set({ recovery: true })
      // profil se dotahuje mimo callback: uvnitř onAuthStateChange se nesmí čekat na
      // další supabase volání (klient drží zámek a dotaz by se zablokoval)
      void applySession(session, set)
    })
    return () => sub.subscription.unsubscribe()
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw new Error(czech(error.message))
  },

  signUp: async (email, password, displayName) => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // jméno si přečte trigger handle_new_user() a založí podle něj profil
        data: { display_name: displayName.trim() },
        // Bez tohohle se potvrzovací odkaz řídí Site URL projektu — jenže ta je jedna,
        // zatímco appka běží na localhostu i na Pages v podsložce /GIS-map/. Řekneme si
        // proto o návrat tam, odkud se registrovalo (stejně jako resetPassword níž).
        // Adresa musí být v Supabase v Redirect URLs, jinak ji GoTrue zahodí a spadne
        // zpátky na Site URL.
        emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
      },
    })
    if (error) throw new Error(czech(error.message))
    return !data.session
  },

  resetPassword: async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
    })
    if (error) throw new Error(czech(error.message))
  },

  setPassword: async (password) => {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw new Error(czech(error.message))
    set({ recovery: false })
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ user: null, profile: null, recovery: false })
  },
}))

/** Uloží uživatele ze session a dotáhne k němu profil (jméno do hlavičky). */
async function applySession(session: Session | null, set: (s: Partial<AuthState>) => void) {
  const user = session?.user ?? null
  set({ user })
  if (!user) { set({ profile: null }); return }

  const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  // Profil zakládá trigger; kdyby chyběl (starý účet), poskládáme náhradu z auth dat,
  // ať appka funguje dál a jen v hlavičce chybí hezké jméno.
  set({
    profile: (data as Profile | null) ?? {
      id: user.id,
      email: user.email ?? null,
      display_name: (user.user_metadata?.display_name as string | undefined) ?? user.email?.split('@')[0] ?? null,
      created_at: user.created_at,
    },
  })
}
