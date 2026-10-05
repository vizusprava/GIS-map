/**
 * Správa vlastního účtu — jméno, e-mail, heslo a smazání účtu i se všemi daty.
 *
 * Změna e-mailu i hesla jde přes Supabase Auth. Smazání potřebuje databázovou funkci
 * `delete_my_account()` (sql/002_account.sql): klient s veřejným klíčem na uživatele v auth
 * nedosáhne. Soubory v bucketu se mažou NAPŘED přes Storage API — Supabase nedovolí mazat
 * je z databáze a po smazání uživatele by v bucketu zůstaly navždy.
 */
import { supabase, BUCKET } from './supabase'
import { removeFiles } from './storage'
import { cacheClear } from '../cache'
import { czech, useAuthStore } from '../stores/authStore'

/** Kam vede odkaz z potvrzovacího e-mailu — tam, odkud se změna spustila (jako u registrace). */
const backHere = () => `${window.location.origin}${window.location.pathname}`

/** Nové zobrazované jméno (hlavička přehledu scén). */
export async function updateDisplayName(name: string): Promise<void> {
  const uid = useAuthStore.getState().user?.id
  const n = name.trim()
  if (!uid) throw new Error('Nejsi přihlášený')
  if (!n) throw new Error('Jméno nesmí být prázdné')
  const { error } = await supabase.from('profiles').update({ display_name: n }).eq('id', uid)
  if (error) throw new Error(`Jméno se nepodařilo uložit: ${error.message}`)
  const p = useAuthStore.getState().profile
  if (p) useAuthStore.setState({ profile: { ...p, display_name: n } })
}

/**
 * Změna e-mailu. Platí až po potvrzení odkazem z pošty — podle nastavení projektu na nové
 * adrese, případně na obou (Supabase „Secure email change"). Do té doby se přihlašuje starým.
 */
export async function changeEmail(newEmail: string): Promise<void> {
  const e = newEmail.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Neplatná e-mailová adresa.')
  const { error } = await supabase.auth.updateUser({ email: e }, { emailRedirectTo: backHere() })
  if (error) throw new Error(czech(error.message))
}

/** Ověří současné heslo novým přihlášením — před změnou hesla a smazáním účtu. */
async function verifyPassword(password: string): Promise<void> {
  const email = useAuthStore.getState().user?.email
  if (!email) throw new Error('Nejsi přihlášený')
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(/invalid login credentials/i.test(error.message) ? 'Současné heslo nesedí.' : czech(error.message))
}

/** Změna hesla — nejdřív se ověří to současné. */
export async function changePassword(current: string, next: string): Promise<void> {
  if (next.length < 6) throw new Error('Nové heslo musí mít alespoň 6 znaků.')
  await verifyPassword(current)
  const { error } = await supabase.auth.updateUser({ password: next })
  if (error) throw new Error(czech(error.message))
}

/** Všechny soubory ve složce uživatele v bucketu (`<uid>/<scéna>/…`), i ty, na které už nic neukazuje. */
async function listOwnFiles(prefix: string, depth = 0): Promise<string[]> {
  const out: string[] = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000, offset })
    if (error) throw new Error(`Soubory se nepodařilo vypsat: ${error.message}`)
    for (const it of data ?? []) {
      const path = `${prefix}/${it.name}`
      if (it.id === null) { if (depth < 3) out.push(...await listOwnFiles(path, depth + 1)) } // složka
      else out.push(path)
    }
    if (!data || data.length < 1000) break
  }
  return out
}

/**
 * Smaže účet i se vším: nahrané soubory (v úložišti i ty uložené jen v tomhle počítači),
 * scény, nastavení a nakonec samotného uživatele. Nevratné — heslo se ověří předem.
 */
export async function deleteMyAccount(password: string, onStep?: (msg: string) => void): Promise<void> {
  const uid = useAuthStore.getState().user?.id
  if (!uid) throw new Error('Nejsi přihlášený')
  await verifyPassword(password)

  onStep?.('Mažu nahrané soubory…')
  // podle záznamů — tak se najdou i soubory uložené jen v tomhle počítači (`local:…`)
  const [{ data: assets }, { data: scenes }] = await Promise.all([
    supabase.from('geo_assets').select('file_path, sidecar_path').eq('owner', uid),
    supabase.from('geo_scenes').select('thumb_path').eq('owner', uid),
  ])
  await removeFiles([
    ...(assets ?? []).flatMap(a => [a.file_path as string, a.sidecar_path as string | null]),
    ...(scenes ?? []).map(s => s.thumb_path as string | null),
  ])
  // a cokoliv dalšího v jeho složce (staré náhledy, nedokončená nahrání)
  const rest = await listOwnFiles(uid)
  for (let i = 0; i < rest.length; i += 100) await removeFiles(rest.slice(i, i + 100))

  onStep?.('Mažu účet…')
  const { error } = await supabase.rpc('delete_my_account')
  if (error) {
    throw new Error(/function .*delete_my_account|could not find the function/i.test(error.message)
      ? 'V databázi chybí funkce delete_my_account — spusť v Supabase sql/002_account.sql.'
      : `Účet se nepodařilo smazat: ${error.message}`)
  }
  // místní data appky v tomhle prohlížeči (cache dlaždic a souborů) a odhlášení
  await cacheClear().catch(() => {})
  await supabase.auth.signOut().catch(() => {})
  useAuthStore.setState({ user: null, profile: null, recovery: false })
}
