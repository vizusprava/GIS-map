/**
 * Podvržené API Supabase pro kouřový test — okno sdílení scény i veřejný prohlížeč (odkaz
 * `#/view/…` s anonymním přihlášením) se tak dají projít celé, aniž by test sáhl na skutečnou
 * databázi (ani kdyby build měl v .env ostrou adresu).
 *
 * MUSÍ se importovat jako první: klient Supabase si `fetch` bere při vytvoření, tedy hned
 * při načtení modulu lib/supabase.ts.
 *
 * Drží jednu sdílenou scénu (členka Jana, čekající pozvánka), jednu scénu s odkazem pro
 * prohlížení a pár scén pro přehled (`?page=scenes`). Volání si zapisuje do `window.__rest`,
 * ať test vidí, co appka poslala.
 */
type Row = Record<string, unknown>
/** kód odkazu, který v podvržené databázi platí (test ho otevírá jako `#/view/tok-ukazka`) */
const VIEW_TOKEN = 'tok-ukazka'
const db = {
  members: [
    { scene_id: 'smoke', user_id: 'u-jana', role: 'editor', created_at: '2026-01-01T00:00:00Z' },
    // přehled scén (?page=scenes): do Janiny scény mě pozvala jako editora, já jí nasdílel Kladno
    { scene_id: 'p-jana', user_id: 'u-smoke', role: 'editor', created_at: '2026-01-01T00:00:00Z', opened_at: null },
    { scene_id: 'p-kladno', user_id: 'u-jana', role: 'viewer', created_at: '2026-01-01T00:00:00Z' },
  ] as Row[],
  invites: [{ scene_id: 'smoke', email: 'novy@example.cz', role: 'viewer', created_at: '2026-01-02T00:00:00Z' }] as Row[],
  profiles: [{ id: 'u-jana', display_name: 'Jana', email: 'jana@example.cz' }] as Row[],
  links: [{ scene_id: 'p-most', token: 'tok-most' }] as Row[],
  scenes: [{
    id: 'smoke-view', owner: 'u-jana', name: 'Ukázka pro klienta', note: null, thumb_path: null, state: {},
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', opened_at: null,
  },
  // přehled scén: tři moje (Kladno sdílené s Janou, Most s odkazem) a jedna Janina
  ...([
    ['p-kladno', 'u-smoke', 'Kladno – průtah', '2026-03-01', 0],
    ['p-most', 'u-smoke', 'Most přes Vltavu', '2026-05-01', 1],
    ['p-cb', 'u-smoke', 'České Budějovice – sever', '2026-04-01', 2],
    ['p-jana', 'u-jana', 'Janina zakázka', '2026-02-01', null],
  ] as const).map(([id, owner, name, created, opened]) => ({
    id, owner, name, note: null, thumb_path: null, state: {},
    created_at: `${created}T08:00:00Z`, updated_at: `${created}T08:00:00Z`,
    // otevřeno před 0 / 1 / 2 dny — „naposledy otevřené" tak řadí jinak než název i datum vzniku
    opened_at: opened === null ? null : new Date(Date.now() - opened * 86_400_000).toISOString(),
  }))] as Row[],
  assets: [
    { id: 'a1', scene_id: 'p-kladno', kind: 'drawing' }, { id: 'a2', scene_id: 'p-kladno', kind: 'model' },
    { id: 'a3', scene_id: 'p-most', kind: 'drawing' },
  ] as Row[],
}
const calls: { method: string; path: string; body: unknown }[] = []
Object.assign(window, { __rest: calls })

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

/** `?user_id=eq.u-jana&scene_id=in.(a,b)` → [['user_id',['u-jana']], ['scene_id',['a','b']]] */
type Filter = [column: string, values: string[]]
const filters = (q: URLSearchParams) => [...q.entries()].flatMap(([k, v]): Filter[] => {
  if (v.startsWith('eq.')) return [[k, [v.slice(3)]]]
  const list = v.match(/^in\.\((.*)\)$/)?.[1]
  return list === undefined ? [] : [[k, list.split(',').map(x => x.replace(/^"|"$/g, ''))]]
})
const matches = (r: Row, f: Filter[]) => f.every(([k, vs]) => vs.includes(String(r[k])))

/** Anonymní přihlášení: session jako od GoTrue (token je tvarem JWT, podpis nikdo nekontroluje). */
function anonSession() {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const exp = Math.floor(Date.now() / 1000) + 3600
  const user = {
    id: 'u-host', aud: 'authenticated', role: 'authenticated', email: '', is_anonymous: true,
    app_metadata: { provider: 'anonymous', providers: ['anonymous'] }, user_metadata: {}, identities: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: 'authenticated', is_anonymous: true, exp, aud: 'authenticated' })}.podpis`
  return { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'obnova', user }
}

const real = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  if (url.pathname.startsWith('/auth/v1/')) {
    const path = url.pathname.slice('/auth/v1/'.length)
    calls.push({ method, path: `auth/${path}`, body })
    if (path === 'signup' && method === 'POST' && !body?.email) return json(anonSession())
    return json({ message: 'v kouřovém testu není' }, 400)
  }
  if (!url.pathname.startsWith('/rest/v1/')) {
    // Storage Supabase v testu nemá co dělat; mapové služby jdou dál na síť
    if (url.pathname.startsWith('/storage/v1/')) return json({ message: 'v kouřovém testu není' }, 400)
    return real(input, init)
  }
  const path = url.pathname.slice('/rest/v1/'.length)
  calls.push({ method, path, body })
  const f = filters(url.searchParams)

  if (path === 'rpc/share_scene') {
    const { p_email, p_role } = body as { p_email: string; p_role: string }
    db.invites = db.invites.filter(i => i.email !== p_email)
    db.invites.push({ scene_id: 'smoke', email: p_email, role: p_role, created_at: new Date().toISOString() })
    return json('invited')
  }
  if (path === 'rpc/scene_link_enable') {
    const { p_scene, p_renew } = body as { p_scene: string; p_renew: boolean }
    let l = db.links.find(x => x.scene_id === p_scene)
    if (!l) { l = { scene_id: p_scene, token: 'tok-1' }; db.links.push(l) } else if (p_renew) l.token = `tok-${Date.now()}`
    return json(l.token)
  }
  if (path === 'rpc/scene_link_disable') {
    db.links = db.links.filter(x => x.scene_id !== (body as { p_scene: string }).p_scene)
    return json(null)
  }
  if (path === 'rpc/open_scene_link') {
    if ((body as { p_token: string }).p_token !== VIEW_TOKEN) {
      return json({ code: 'P0001', message: 'Odkaz neplatí — vlastník ho mohl vypnout nebo vyměnit za nový', details: null, hint: null }, 400)
    }
    return json({ scene_id: 'smoke-view', owner_name: 'Jana', ion_token: 'klic-vlastnika' })
  }
  const table = ({
    geo_scene_members: 'members', geo_scene_invites: 'invites', profiles: 'profiles',
    geo_scene_links: 'links', geo_scenes: 'scenes', geo_assets: 'assets',
  } as const)[path] ?? null
  if (!table) return json([])
  if (method === 'GET') return json(db[table].filter(r => matches(r, f)))
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
