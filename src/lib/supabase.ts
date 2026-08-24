/**
 * Klient Supabase — jediné místo, kde se appka připojuje k backendu.
 *
 * ANON klíč je veřejný schválně: data chrání RLS politiky (viz sql/001_init.sql), ne tajnost
 * klíče. Session se drží v localStorage pod vlastním jménem, aby se nepletla s jinou appkou
 * na stejné doméně.
 */
import { createClient } from '@supabase/supabase-js'

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON as string | undefined

/** Bez konfigurace nemá cenu appku spouštět — řekneme to hned a jasně, ne až 401 z fetche. */
export const supabaseConfigured = !!rawUrl && !!anon

// `new URL(...).origin` odřízne případné lomítko/cestu na konci, jinak se lepí dvojité `//`
const url = rawUrl ? new URL(rawUrl).origin : 'http://localhost'

export const supabase = createClient(url, anon ?? 'anon-key-missing', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // PKCE schválně: odkazy z e-mailu (potvrzení účtu, změna hesla) se pak vracejí jako
    // `?code=…` v query. Implicitní flow je vrací ve fragmentu (`#access_token=…`), což se
    // bije s HashRouterem — appka by v adrese viděla cestu, která neexistuje.
    flowType: 'pkce',
    storageKey: 'gis-map-session',
  },
})

/** Bucket na všechny uživatelské soubory (modely, výkresy, rastry, textury, náhledy). */
export const BUCKET = 'geo'
