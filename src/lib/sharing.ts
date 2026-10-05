/**
 * Sdílení scén s kolegy — kdo ve scéně je, s jakou rolí, pozvánky a odchod ze scény.
 *
 * Pravidla hlídá databáze (sql/003_sharing.sql): scénu sdílí jen vlastník, `viewer` ji vidí,
 * `editor` ji smí i měnit. Tady je jen volání — a vlídná hláška, když migrace ještě neběžela
 * (appka pak funguje dál jako dřív, jen bez sdílení).
 *
 * Appka sama e-maily neposílá: pozvaný se o scéně dozví od toho, kdo ho pozval (odkaz
 * `sceneLink`). Kdo ještě nemá účet, dostane přístup hned po registraci — pozvánka na něj počká.
 */
import { supabase } from './supabase'
import { useAuthStore } from '../stores/authStore'
import type { MemberRole, SceneRole } from './types'

export type Member = { userId: string; name: string; email: string | null; role: MemberRole }
export type Invite = { email: string; role: MemberRole }

export const ROLE_LABEL: Record<SceneRole, string> = {
  owner: 'vlastník',
  editor: 'může upravovat',
  viewer: 'jen prohlížet',
}

export const SHARING_SQL_HINT = 'V databázi chybí sdílení — spusť v Supabase sql/003_sharing.sql.'

/** Chybí tabulka nebo funkce sdílení (migrace 003 ještě neběžela)? */
export function isSharingMissing(e: unknown): boolean {
  const m = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e)
  return /geo_scene_members|geo_scene_invites|share_scene|schema cache|does not exist|could not find/i.test(m)
}

function fail(what: string, e: { message: string }): never {
  throw new Error(isSharingMissing(e) ? SHARING_SQL_HINT : `${what}: ${e.message}`)
}

const me = () => useAuthStore.getState().user?.id

/** Odkaz na scénu — otevře ji jen tomu, s kým je nasdílená (ostatní uvidí „nemáš přístup"). */
export function sceneLink(sceneId: string): string {
  return `${window.location.origin}${window.location.pathname}#/scene/${sceneId}`
}

/**
 * Moje členství ve sdílených scénách: role a kdy jsem scénu naposledy otevřel.
 * Bez migrace 003 prázdné — sdílené scény pak ani neexistují.
 */
export async function myMemberships(): Promise<Map<string, { role: MemberRole; openedAt: string | null }>> {
  const uid = me()
  const out = new Map<string, { role: MemberRole; openedAt: string | null }>()
  if (!uid) return out
  const { data, error } = await supabase.from('geo_scene_members').select('scene_id, role, opened_at').eq('user_id', uid)
  if (error) return out
  for (const r of (data ?? []) as { scene_id: string; role: MemberRole; opened_at: string | null }[]) {
    out.set(r.scene_id, { role: r.role, openedAt: r.opened_at })
  }
  return out
}

/**
 * Moje role ve scéně. Kdo scénu vidí, ale členem není, přišel přes odkaz pro prohlížení —
 * `guest` (i když je přihlášený a scénu si otevřel jako `#/scene/…`). Nejasný případ
 * (výpadek, chybějící migrace) dopadne stejně: radši míň než víc.
 */
export async function sceneAccess(scene: { id: string; owner: string }): Promise<SceneRole | 'guest'> {
  const uid = me()
  if (uid && scene.owner === uid) return 'owner'
  if (!uid) return 'guest'
  const { data, error } = await supabase.from('geo_scene_members').select('role').eq('scene_id', scene.id).eq('user_id', uid).maybeSingle()
  if (error || !data) return 'guest'
  return (data as { role: MemberRole }).role === 'editor' ? 'editor' : 'viewer'
}

/** Jména lidí, se kterými sdílím scénu (jméno z profilu, jinak e-mail). */
export async function profileNames(ids: string[]): Promise<Record<string, { name: string; email: string | null }>> {
  const uniq = [...new Set(ids)].filter(Boolean)
  if (!uniq.length) return {}
  const { data, error } = await supabase.from('profiles').select('id, display_name, email').in('id', uniq)
  if (error) return {}
  const out: Record<string, { name: string; email: string | null }> = {}
  for (const p of (data ?? []) as { id: string; display_name: string | null; email: string | null }[]) {
    out[p.id] = { name: p.display_name || p.email || 'kolega', email: p.email }
  }
  return out
}

/** Kdo ve scéně je (bez vlastníka) a kdo na přístup čeká, než se zaregistruje. */
export async function listMembers(sceneId: string): Promise<{ members: Member[]; invites: Invite[] }> {
  const [m, i] = await Promise.all([
    supabase.from('geo_scene_members').select('user_id, role, created_at').eq('scene_id', sceneId).order('created_at'),
    supabase.from('geo_scene_invites').select('email, role, created_at').eq('scene_id', sceneId).order('created_at'),
  ])
  if (m.error) fail('Seznam lidí se nepodařilo načíst', m.error)
  if (i.error) fail('Pozvánky se nepodařilo načíst', i.error)
  const rows = (m.data ?? []) as { user_id: string; role: MemberRole }[]
  const names = await profileNames(rows.map(r => r.user_id))
  return {
    members: rows.map(r => ({ userId: r.user_id, role: r.role, name: names[r.user_id]?.name ?? 'kolega', email: names[r.user_id]?.email ?? null })),
    invites: ((i.data ?? []) as { email: string; role: MemberRole }[]).map(r => ({ email: r.email, role: r.role })),
  }
}

/**
 * Nasdílí scénu na e-mail. 'added' = člověk má účet a přístup má hned; 'invited' = účet zatím
 * nemá, přístup dostane po registraci. Opakované nasdílení jen změní roli.
 */
export async function shareScene(sceneId: string, email: string, role: MemberRole): Promise<'added' | 'invited'> {
  const e = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Neplatná e-mailová adresa.')
  if (e === useAuthStore.getState().user?.email?.toLowerCase()) throw new Error('To jsi ty — scéna už je tvoje.')
  const { data, error } = await supabase.rpc('share_scene', { p_scene: sceneId, p_email: e, p_role: role })
  if (error) fail('Nasdílení se nepovedlo', error)
  return data === 'added' ? 'added' : 'invited'
}

/** Změnou s RLS, která nic nezměnila (cizí scéna), se nic nestane a ani nezahlásí chybu. */
function noRows(data: unknown[] | null): boolean {
  return !data || data.length === 0
}

export async function setMemberRole(sceneId: string, userId: string, role: MemberRole): Promise<void> {
  const { data, error } = await supabase.from('geo_scene_members').update({ role }).eq('scene_id', sceneId).eq('user_id', userId).select('user_id')
  if (error) fail('Roli se nepodařilo změnit', error)
  if (noRows(data)) throw new Error('Roli může měnit jen vlastník scény.')
}

export async function removeMember(sceneId: string, userId: string): Promise<void> {
  const { data, error } = await supabase.from('geo_scene_members').delete().eq('scene_id', sceneId).eq('user_id', userId).select('user_id')
  if (error) fail('Odebrání se nepovedlo', error)
  if (noRows(data)) throw new Error('Odebírat lidi může jen vlastník scény.')
}

export async function setInviteRole(sceneId: string, email: string, role: MemberRole): Promise<void> {
  const { data, error } = await supabase.from('geo_scene_invites').update({ role }).eq('scene_id', sceneId).eq('email', email).select('email')
  if (error) fail('Roli se nepodařilo změnit', error)
  if (noRows(data)) throw new Error('Pozvánky spravuje jen vlastník scény.')
}

export async function revokeInvite(sceneId: string, email: string): Promise<void> {
  const { data, error } = await supabase.from('geo_scene_invites').delete().eq('scene_id', sceneId).eq('email', email).select('email')
  if (error) fail('Pozvánku se nepodařilo zrušit', error)
  if (noRows(data)) throw new Error('Pozvánky spravuje jen vlastník scény.')
}

/** Odejde ze sdílené scény — zmizí mi z přehledu, vlastníkovi i ostatním zůstane. */
export async function leaveScene(sceneId: string): Promise<void> {
  const uid = me()
  if (!uid) throw new Error('Nejsi přihlášený')
  const { error } = await supabase.from('geo_scene_members').delete().eq('scene_id', sceneId).eq('user_id', uid)
  if (error) fail('Odchod ze scény se nepovedl', error)
}

// ── Odkaz jen pro prohlížení (sql/004_view_links.sql) ──────────────────────────────
// Kdo odkaz zná, otevře scénu bez registrace: na pozadí se přihlásí jako anonymní uživatel
// a databáze ho pustí ke scéně jako hosta — jen číst, a jen dokud odkaz platí.

export const LINKS_SQL_HINT = 'V databázi chybí odkazy pro prohlížení — spusť v Supabase sql/004_view_links.sql.'

const isLinksMissing = (e: { code?: string; message: string }) =>
  e.code === 'PGRST202' || /geo_scene_links|scene_link_|open_scene_link|schema cache|does not exist|could not find/i.test(e.message)

/** Adresa prohlížeče scény pro daný kód odkazu. */
export function viewLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/view/${token}`
}

/** Kód platného odkazu na scénu, nebo null (odkaz vypnutý). Jen vlastník. */
export async function getSceneLink(sceneId: string): Promise<string | null> {
  const { data, error } = await supabase.from('geo_scene_links').select('token').eq('scene_id', sceneId).maybeSingle()
  if (error) throw new Error(isLinksMissing(error) ? LINKS_SQL_HINT : `Odkaz se nepodařilo načíst: ${error.message}`)
  return (data as { token: string } | null)?.token ?? null
}

/** Zapne odkaz (nebo s `renew` vymění kód — starý přestane platit) a vrátí kód. */
export async function enableSceneLink(sceneId: string, renew = false): Promise<string> {
  const { data, error } = await supabase.rpc('scene_link_enable', { p_scene: sceneId, p_renew: renew })
  if (error) throw new Error(isLinksMissing(error) ? LINKS_SQL_HINT : `Odkaz se nepodařilo zapnout: ${error.message}`)
  return data as string
}

/** Vypne odkaz — kdo scénu přes něj prohlížel, přijde o přístup. */
export async function disableSceneLink(sceneId: string): Promise<void> {
  const { error } = await supabase.rpc('scene_link_disable', { p_scene: sceneId })
  if (error) throw new Error(isLinksMissing(error) ? LINKS_SQL_HINT : `Odkaz se nepodařilo vypnout: ${error.message}`)
}

export type OpenedLink = { sceneId: string; ownerName: string | null; ionToken: string | null }

/**
 * Otevře scénu odkazem. Kdo není přihlášený, přihlásí se anonymně (Supabase „anonymous
 * sign-ins" musí být zapnuté). Přihlášený jde pod svým účtem.
 */
export function openSceneLink(token: string): Promise<OpenedLink> {
  // StrictMode spouští efekty dvakrát — dvě anonymní přihlášení naráz by založila dva účty
  let p = opening.get(token)
  if (!p) {
    p = openOnce(token).finally(() => opening.delete(token))
    opening.set(token, p)
  }
  return p
}
const opening = new Map<string, Promise<OpenedLink>>()

async function openOnce(token: string): Promise<OpenedLink> {
  const attempt = async (): Promise<OpenedLink> => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      const { error } = await supabase.auth.signInAnonymously()
      if (error) {
        throw new Error(/anonymous sign-ins are disabled|anonymous_provider_disabled/i.test(error.message)
          ? 'Prohlížení bez účtu není zapnuté — vlastník appky ho musí povolit v Supabase (Anonymous sign-ins).'
          : `Odkaz se nepodařilo otevřít: ${error.message}`)
      }
    }
    const { data, error } = await supabase.rpc('open_scene_link', { p_token: token })
    if (error) throw Object.assign(new Error(isLinksMissing(error) ? 'Odkazy pro prohlížení v databázi chybí.' : error.message), { db: true })
    const r = data as { scene_id: string; owner_name: string | null; ion_token: string | null }
    return { sceneId: r.scene_id, ownerName: r.owner_name, ionToken: r.ion_token }
  }
  try {
    return await attempt()
  } catch (e) {
    // Anonymní účet mohl mezitím zmizet (úklid starých hostů) a jeho přihlášení ještě visí
    // v prohlížeči — jednou to zkusit s čerstvým. Neplatný odkaz se tím nespraví, ten rovnou.
    const anon = !!useAuthStore.getState().user?.is_anonymous
    if (!anon || !(e as { db?: boolean }).db || /neplatí/.test((e as Error).message)) throw e
    await supabase.auth.signOut().catch(() => {})
    return attempt()
  }
}

/**
 * Přehled scén: u mých scén kolik lidí je v nich nasdílených (i čekající pozvánky) a jestli
 * mají zapnutý odkaz pro prohlížení, u cizích jméno vlastníka. Bez migrací 003/004 prázdné.
 */
export async function sharingOverview(scenes: { id: string; owner: string }[]): Promise<{
  counts: Record<string, number>
  owners: Record<string, string>
  links: Record<string, boolean>
}> {
  const uid = me()
  const own = scenes.filter(s => s.owner === uid).map(s => s.id)
  const foreign = scenes.filter(s => s.owner !== uid).map(s => s.owner)
  const counts: Record<string, number> = {}
  const links: Record<string, boolean> = {}
  if (own.length) {
    const [m, i, l] = await Promise.all([
      supabase.from('geo_scene_members').select('scene_id').in('scene_id', own),
      supabase.from('geo_scene_invites').select('scene_id').in('scene_id', own),
      supabase.from('geo_scene_links').select('scene_id').in('scene_id', own),
    ])
    for (const r of [...(m.data ?? []), ...(i.data ?? [])] as { scene_id: string }[]) counts[r.scene_id] = (counts[r.scene_id] ?? 0) + 1
    for (const r of (l.data ?? []) as { scene_id: string }[]) links[r.scene_id] = true
  }
  const names = await profileNames(foreign)
  const owners: Record<string, string> = {}
  for (const [id, p] of Object.entries(names)) owners[id] = p.name
  return { counts, owners, links }
}
