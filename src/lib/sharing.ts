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

/** Moje role ve scéně. Nejasný případ (výpadek, chybějící migrace) = jen prohlížení. */
export async function sceneAccess(scene: { id: string; owner: string }): Promise<SceneRole> {
  const uid = me()
  if (uid && scene.owner === uid) return 'owner'
  if (!uid) return 'viewer'
  const { data, error } = await supabase.from('geo_scene_members').select('role').eq('scene_id', scene.id).eq('user_id', uid).maybeSingle()
  if (error || !data) return 'viewer'
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

/**
 * Přehled scén: u mých scén kolik lidí je v nich nasdílených (i čekající pozvánky), u cizích
 * jméno vlastníka. Bez migrace 003 prázdné.
 */
export async function sharingOverview(scenes: { id: string; owner: string }[]): Promise<{
  counts: Record<string, number>
  owners: Record<string, string>
}> {
  const uid = me()
  const own = scenes.filter(s => s.owner === uid).map(s => s.id)
  const foreign = scenes.filter(s => s.owner !== uid).map(s => s.owner)
  const counts: Record<string, number> = {}
  if (own.length) {
    const [m, i] = await Promise.all([
      supabase.from('geo_scene_members').select('scene_id').in('scene_id', own),
      supabase.from('geo_scene_invites').select('scene_id').in('scene_id', own),
    ])
    for (const r of [...(m.data ?? []), ...(i.data ?? [])] as { scene_id: string }[]) counts[r.scene_id] = (counts[r.scene_id] ?? 0) + 1
  }
  const names = await profileNames(foreign)
  const owners: Record<string, string> = {}
  for (const [id, p] of Object.entries(names)) owners[id] = p.name
  return { counts, owners }
}
