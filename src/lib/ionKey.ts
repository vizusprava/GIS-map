/**
 * Klíč Cesium ion — přes něj jde 3D realita (Google Photorealistic 3D Tiles).
 *
 * Výchozí je SDÍLENÝ zkušební klíč appky (`VITE_CESIUM_ION_TOKEN`): stačí na vyzkoušení, ale
 * jeho měsíční kvótu čerpají všichni dohromady. Kdo 3D realitu používá hodně, nastaví si
 * vlastní klíč — uloží se k účtu (Supabase `user_metadata.ion_token`), takže platí na každém
 * počítači, kde se přihlásí, a čerpá jeho vlastní kvótu.
 *
 * Klíč ion je „veřejný" klíč pro prohlížeč (v appce je stejně vidět), proto nevadí, že leží
 * v metadatech účtu; omezit ho jde v ion na konkrétní adresu webu.
 */
import { ION_TOKEN, GOOGLE_3D_ION_ASSET } from '../config'
import { supabase } from './supabase'
import { useAuthStore } from '../stores/authStore'

/** Vlastní klíč přihlášeného uživatele, nebo null (pak se bere sdílený). */
export function userIonToken(): string | null {
  const t = useAuthStore.getState().user?.user_metadata?.ion_token
  return typeof t === 'string' && t.trim() ? t.trim() : null
}

/** Klíč, se kterým se má mapa připojit: vlastní, jinak sdílený zkušební. */
export function effectiveIonToken(): string | undefined {
  return userIonToken() ?? ION_TOKEN
}

/** Hook: vlastní klíč (překreslí se, když si ho uživatel změní). */
export function useUserIonToken(): string | null {
  const t = useAuthStore(s => s.user?.user_metadata?.ion_token)
  return typeof t === 'string' && t.trim() ? t.trim() : null
}

export type IonCheck = { ok: true } | { ok: false; reason: string }

/**
 * Ověří klíč přímo u Cesium ion: platí a má přístup ke Google 3D? Ptá se na koncový bod
 * assetu — přesně ten dotaz, kterým se 3D realita v mapě připojuje.
 */
export async function checkIonToken(token: string): Promise<IonCheck> {
  try {
    const res = await fetch(`https://api.cesium.com/v1/assets/${GOOGLE_3D_ION_ASSET}/endpoint`, {
      headers: { Authorization: `Bearer ${token.trim()}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) return { ok: true }
    if (res.status === 401) return { ok: false, reason: 'Klíč je neplatný nebo zrušený.' }
    if (res.status === 403) return { ok: false, reason: 'Klíč nemá přístup ke Google 3D — v ion u klíče povol asset „Google Photorealistic 3D Tiles".' }
    if (res.status === 404) return { ok: false, reason: 'Klíč platí, ale účet nemá přidané Google Photorealistic 3D Tiles — přidej je v ion v Asset Depot.' }
    return { ok: false, reason: `Cesium ion odpověděl HTTP ${res.status}.` }
  } catch {
    return { ok: false, reason: 'Cesium ion se nepodařilo zastihnout — zkontroluj připojení a zkus to znovu.' }
  }
}

/** Uloží (nebo smaže: null) vlastní klíč k účtu. Přihlášení se obnoví samo (USER_UPDATED). */
export async function saveUserIonToken(token: string | null): Promise<void> {
  const { error } = await supabase.auth.updateUser({ data: { ion_token: token?.trim() || null } })
  if (error) throw new Error(`Klíč se nepodařilo uložit: ${error.message}`)
}
