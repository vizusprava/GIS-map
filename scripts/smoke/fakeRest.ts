/**
 * Podvržené REST API Supabase pro kouřový test — okno sdílení scény se tak dá projít celé,
 * aniž by test sáhl na skutečnou databázi (ani kdyby build měl v .env ostrou adresu).
 *
 * MUSÍ se importovat jako první: klient Supabase si `fetch` bere při vytvoření, tedy hned
 * při načtení modulu lib/supabase.ts.
 *
 * Drží jednu sdílenou scénu: členku Janu (editor) a čekající pozvánku. Volání si zapisuje
 * do `window.__rest`, ať test vidí, co appka poslala.
 */
type Row = Record<string, unknown>
const db = {
  members: [{ scene_id: 'smoke', user_id: 'u-jana', role: 'editor', created_at: '2026-01-01T00:00:00Z' }] as Row[],
  invites: [{ scene_id: 'smoke', email: 'novy@example.cz', role: 'viewer', created_at: '2026-01-02T00:00:00Z' }] as Row[],
  profiles: [{ id: 'u-jana', display_name: 'Jana', email: 'jana@example.cz' }] as Row[],
}
const calls: { method: string; path: string; body: unknown }[] = []
Object.assign(window, { __rest: calls })

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

/** `?user_id=eq.u-jana&email=eq.x` → [['user_id','u-jana'], …] */
const filters = (q: URLSearchParams) => [...q.entries()].filter(([, v]) => v.startsWith('eq.')).map(([k, v]) => [k, v.slice(3)] as const)
const matches = (r: Row, f: ReturnType<typeof filters>) => f.every(([k, v]) => String(r[k]) === v)

const real = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (!url.pathname.startsWith('/rest/v1/')) {
    // Auth a Storage Supabase v testu nemají co dělat; mapové služby jdou dál na síť
    if (url.pathname.startsWith('/auth/v1/') || url.pathname.startsWith('/storage/v1/')) return json({ message: 'v kouřovém testu není' }, 400)
    return real(input, init)
  }
  const method = (init?.method ?? 'GET').toUpperCase()
  const path = url.pathname.slice('/rest/v1/'.length)
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  calls.push({ method, path, body })
  const f = filters(url.searchParams)

  if (path === 'rpc/share_scene') {
    const { p_email, p_role } = body as { p_email: string; p_role: string }
    db.invites = db.invites.filter(i => i.email !== p_email)
    db.invites.push({ scene_id: 'smoke', email: p_email, role: p_role, created_at: new Date().toISOString() })
    return json('invited')
  }
  const table = path === 'geo_scene_members' ? 'members' : path === 'geo_scene_invites' ? 'invites' : path === 'profiles' ? 'profiles' : null
  if (!table) return json([])
  if (method === 'GET') {
    // profiles?id=in.(u-jana,…)
    const inIds = url.searchParams.get('id')?.match(/^in\.\((.*)\)$/)?.[1]?.split(',')
    return json(db[table].filter(r => matches(r, f) && (!inIds || inIds.includes(String(r.id)))))
  }
  if (method === 'PATCH') {
    const hit = db[table].filter(r => matches(r, f))
    for (const r of hit) Object.assign(r, body)
    return json(hit)
  }
  if (method === 'DELETE') {
    const hit = db[table].filter(r => matches(r, f))
    db[table] = db[table].filter(r => !hit.includes(r))
    return json(hit)
  }
  return json([])
}

export {}
