/**
 * Kouřový test v prohlížeči: `npm run smoke` (+ `-- --full` pro kontroly, které potřebují ČÚZK).
 *
 * Unit testy (`npm test`) hlídají výpočty; tohle hlídá, že se appka v prohlížeči vůbec rozjede
 * a jde ovládat — chyby typu „černá obrazovka po přepnutí nástroje", které se typově přeloží.
 * Postaví mapu s podvrženou scénou (scripts/smoke/), spustí headless Chrome přes DevTools
 * protokol a projde nástroje, klávesové zkratky, soustředění panelu, panely Kamera a Prezentace
 * v liště a detail ortofota.
 * Kdykoliv se v appce objeví výjimka nebo odmítnutý slib, test spadne.
 *
 *   --full         navíc: vyhledání parcely podle čísla a její 2D export (potřebuje síť k ČÚZK)
 *   --swiftshader  softwarová grafika jako v CI (jinak se lokálně bere skutečná grafika)
 *   --keep         nechat build a profil prohlížeče v dočasné složce (pro ladění)
 *   --shots        uložit snímky obrazovky v klíčových chvílích (do dočasné složky, jako --keep)
 *
 * Chrome se hledá v CHROME_PATH, pak na obvyklých místech (Chrome, Edge, Chromium).
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, statSync, createReadStream, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

const args = new Set(process.argv.slice(2))
const FULL = args.has('--full')
const SOFT = args.has('--swiftshader') || !!process.env.CI
const SHOTS = args.has('--shots')
const KEEP = args.has('--keep') || SHOTS
const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'geo-smoke-'))
const dist = join(work, 'dist'), profile = join(work, 'profil'), downloads = join(work, 'stazene')
mkdirSync(downloads)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
let chrome = null, server = null, page = null, browser = null

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const win = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  for (const p of process.platform === 'win32' ? win : mac) if (existsSync(p)) return p
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

/** Jedna kontrola: vypíše ✓/✗ a pokračuje dál, ať jedna chyba nezakryje ostatní. */
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  ✗ ${name} — ${e?.message ?? e}`)
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg) }

// ── DevTools protokol ──
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map(), listeners = []
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      if (m.method) for (const l of listeners) l(m)
    }
    ws.onerror = rej
    ws.onopen = () => res({
      send: (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) }),
      on: fn => listeners.push(fn),
      close: () => ws.close(),
    })
  })
}
const ev = async expr => {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(`v prohlížeči: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`)
  return r.result?.result?.value
}
async function waitFor(expr, ms, what) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await ev(expr)) return; await sleep(250) }
  throw new Error(`nedočkal jsem se: ${what}`)
}
const KEYS = { Escape: ['Escape', 27], '?': ['Slash', 191] }
async function press(key, shift = false) {
  const [code, vk] = KEYS[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)]
  const text = key.length === 1 ? (shift ? key.toUpperCase() : key) : undefined
  const k = key.length === 1 && shift ? key.toUpperCase() : key
  const modifiers = shift || key === '?' ? 8 : 0
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, text, windowsVirtualKeyCode: vk, modifiers })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
  await sleep(350)
}
/** Snímek obrazovky — jen s `--shots`. */
async function shot(name) {
  if (!SHOTS) return
  mkdirSync(join(work, 'snimky'), { recursive: true })
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(work, 'snimky', `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
const COLORS = 'emerald|orange|cyan|violet|amber|blue|sky|rose|lime|fuchsia|teal'
/** Popisek a barva tlačítka skupiny v liště (0 podklad, 1 výběr, 2 nástroje, 3 pohled, 4 kamera, 5 prezentace). */
const group = i => ev(`(() => { const b = document.querySelectorAll('button[aria-haspopup="menu"]')[${i}]; const m = b.className.match(/bg-(${COLORS})-600/); return { label: b.innerText.trim(), color: m ? m[1] : null } })()`)
/** Sekce panelu: existuje? rozbalená? obarvená? */
const section = id => ev(`(() => { const d = document.querySelector('[data-sec="${id}"]'); if (!d) return null; const m = d.className.match(/border-(${COLORS})-500/); return { open: d.children.length > 1, color: m ? m[1] : null, title: d.querySelector('button')?.innerText.trim() } })()`)
const clickText = (scope, text) => ev(`(() => { const bs = [...(${scope}).querySelectorAll('button')]; const b = bs.find(b => b.innerText.trim() === ${JSON.stringify(text)}) ?? bs.find(b => b.innerText.includes(${JSON.stringify(text)})); b?.click(); return !!b })()`)

/**
 * GLB jako z 3ds Maxu: mřížka n×n vrcholů po 0,4 m v S-JTSK u Kladna (kladné souřadnice, výška
 * = osa Y) a textura t×t px — ať příprava ve workeru projde i dekódováním a exportem obrázku.
 */
function sjtskGlb(n, t) {
  const crcT = new Uint32Array(256).map((_, k) => { let c = k; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, d) => { const h = Buffer.alloc(8); h.writeUInt32BE(d.length); h.write(type, 4); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([h.subarray(4), d]))); return Buffer.concat([h, d, c]) }
  const raw = Buffer.alloc((t * 3 + 1) * t)
  for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) raw.set([x * 4, y * 4, 128], y * (t * 3 + 1) + 1 + x * 3)
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(t, 0); ihdr.writeUInt32BE(t, 4); ihdr[8] = 8; ihdr[9] = 2
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), idx = new Uint32Array((n - 1) * (n - 1) * 6)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i
    pos.set([768000 + i * 0.4, 280 + Math.sin(i / 5), 1033000 + j * 0.4], k * 3); uv.set([i / (n - 1), j / (n - 1)], k * 2)
  }
  let q = 0
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], q); q += 6 }
  const pad = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  const parts = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(idx.buffer), png].map(pad)
  const offs = parts.map((_, i) => parts.slice(0, i).reduce((s, p) => s + p.length, 0))
  const bin = Buffer.concat(parts)
  const min = [0, 1, 2].map(a => Math.min(...pos.filter((_, i) => i % 3 === a))), max = [0, 1, 2].map(a => Math.max(...pos.filter((_, i) => i % 3 === a)))
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Teren' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n * n, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: n * n, type: 'VEC2' },
      { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offs[i], byteLength: [pos.byteLength, uv.byteLength, idx.byteLength, png.length][i] })),
    buffers: [{ byteLength: bin.length }],
  }))
  const js = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + js.length + bin.length, 8)
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(bin.length, 0x004e4942), bin])
}

/** PNG z exportu: rozměr, jestli má alfu, a podíl průhledných / plných pixelů (filtr 0 jako náš zapisovač). */
function pngStats(buf) {
  let p = 8, W = 0, H = 0, type = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), t = buf.toString('latin1', p + 4, p + 8)
    if (t === 'IHDR') { W = buf.readUInt32BE(p + 8); H = buf.readUInt32BE(p + 12); type = buf[p + 17] }
    if (t === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = 1 + W * (type === 6 ? 4 : 3)
  let clear = 0, solid = 0
  if (type === 6) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = raw[y * stride + 1 + x * 4 + 3]; if (a === 0) clear++; else if (a === 255) solid++ }
  return { W, H, alpha: type === 6, clear: clear / (W * H), solid: solid / (W * H) }
}

async function main() {
  const exe = findChrome()
  if (!exe) throw new Error('Nenašel jsem Chrome ani Edge — nastav CHROME_PATH')

  console.log('▸ build mapy pro test…')
  const vite = spawnSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '-c', 'scripts/smoke/vite.config.ts', '--outDir', dist, '--emptyOutDir'], { cwd: root, encoding: 'utf8' })
  if (vite.status !== 0) throw new Error(`build selhal:\n${vite.stdout}\n${vite.stderr}`)

  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }
  server = createServer((req, res) => {
    const file = join(dist, decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const http = `http://127.0.0.1:${server.address().port}`

  console.log(`▸ prohlížeč (${SOFT ? 'softwarová grafika' : 'grafická karta'})…`)
  const gpu = SOFT ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []
  // Ubuntu na runnerech GitHubu nepustí sandbox Chromu (omezené user namespaces); stránka je
  // naše vlastní z localhostu, takže v CI (a pod rootem) jede bez něj.
  const sandbox = process.env.CI || process.getuid?.() === 0 ? ['--no-sandbox'] : []
  chrome = spawn(exe, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--window-size=1400,900', '--remote-debugging-port=0', ...gpu, ...sandbox, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  // port DevTools Chrome napíše do stderr a do souboru v profilu
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 150 && !existsSync(portFile); i++) await sleep(200)
  expect(existsSync(portFile), 'Chrome nenastartoval (chybí DevToolsActivePort)')
  const [port] = readFileSync(portFile, 'utf8').split('\n')
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  browser = await connect(version.webSocketDebuggerUrl)
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page')
  page = await connect(target.webSocketDebuggerUrl)
  const dialogs = []
  page.on(m => {
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); page.send('Page.handleJavaScriptDialog', { accept: true }) }
  })
  await page.send('Page.enable'); await page.send('Runtime.enable')
  await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html` })

  console.log('▸ kontroly')
  await check('mapa se rozjede a kreslí', async () => {
    await waitFor(`!!window.__scene && document.querySelectorAll('button[aria-haspopup="menu"]').length === 6`, SOFT ? 120_000 : 60_000, 'scéna Cesia a lišta nástrojů')
    const c = await ev(`(() => { const c = window.__scene.canvas; return [c.width, c.height] })()`)
    expect(c[0] > 0 && c[1] > 0, `plátno má nulovou velikost ${c}`)
    return `plátno ${c[0]}×${c[1]}`
  })
  await ev(`document.activeElement?.blur()`)

  // nástroje přes klávesové zkratky: popisek a barva v liště, sekce panelu, Esc vypne
  const tools = [
    { key: 'p', g: 1, label: 'Parcela', color: 'emerald' },
    { key: 'o', g: 1, label: 'Oblast', color: 'orange', sec: 'vyber', title: 'Výběr oblasti' },
    { key: 'd', g: 1, label: 'Dlaždice', color: 'cyan', sec: 'vyber', title: 'Výběr dlaždic' },
    { key: 'u', g: 1, label: 'Území', color: 'violet' },
    { key: 'm', g: 2, label: 'Vzdálenost', color: 'amber', sec: 'mereni' },
    { key: 'm', shift: true, g: 2, label: 'Plocha', color: 'amber', sec: 'mereni' },
    { key: 's', g: 2, label: 'Souřadnice', color: 'blue', sec: 'souradnice' },
  ]
  for (const t of tools) {
    await check(`klávesa ${t.shift ? '⇧' : ''}${t.key.toUpperCase()} → ${t.label}`, async () => {
      await press(t.key, t.shift)
      const g = await group(t.g)
      expect(g.label === t.label, `v liště je „${g.label}"`)
      expect(g.color === t.color, `tlačítko má barvu ${g.color}, čekal jsem ${t.color}`)
      if (t.key === 'o' || t.key === 'm') await shot(`nastroj-${t.key}`)
      if (t.sec) {
        const s = await section(t.sec)
        expect(s, `chybí sekce ${t.sec}`)
        expect(s.open && s.color === t.color, `sekce ${t.sec}: rozbalená ${s.open}, barva ${s.color}`)
        if (t.title) expect(s.title === t.title, `sekce se jmenuje „${s.title}"`)
      }
      await press('Escape')
      const after = await group(t.g)
      expect(!after.color, 'Esc nástroj nevypnul')
    })
  }
  await check('sekce výběru je jen se zapnutým výběrem oblasti / dlaždic', async () => {
    expect(!(await section('vyber')), 'sekce Výběr v mapě visí i bez nástroje')
  })

  // ── měření: klik na první bod ho přichytí, uzavře a dokončí ──
  const mouse = async (type, x, y) => page.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1,
  })
  const clickAt = async (x, y) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); await sleep(250) }
  await check('měření: klik na první bod se přichytí, měření uzavře a dokončí', async () => {
    await press('m')
    const pts = [[620, 330], [820, 330], [820, 520]]
    for (const [x, y] of pts) await clickAt(x, y)
    const mereni = `document.querySelector('[data-sec="mereni"]')?.innerText ?? ''`
    expect((await ev(mereni)).includes('kreslí se'), `po třech bodech se nekreslí: „${await ev(mereni)}"`)
    // kousek vedle prvního bodu: nápověda řekne, že klik měření uzavře
    await mouse('mouseMoved', pts[0][0] + 6, pts[0][1] + 5)
    await waitFor(`document.body.innerText.includes('uzavře do prvního bodu')`, 3_000, 'nápověda k uzavření u prvního bodu')
    await clickAt(pts[0][0] + 6, pts[0][1] + 5)
    const t = await ev(mereni)
    expect(t.includes('uzavřené') && !t.includes('kreslí se'), `měření se neuzavřelo: „${t}"`)
    // délka = obvod trojúhelníku, ne jen dvě strany (uzavírací úsek se počítá); panel píše
    // „595,34 m", nad kilometr „1,539 km" — záleží na měřítku mapy, které se v CI liší
    const m = t.match(/(\d[\d\s ]*(?:,\d+)?)\s*(km|m)\b/)
    const len = m ? Number(m[1].replace(/[\s ]/g, '').replace(',', '.')) * (m[2] === 'km' ? 1000 : 1) : 0
    expect(len > 0, `bez délky: „${t}"`)
    await shot('mereni-uzavrene')
    await press('Escape')
    return `obvod ${len} m`
  })

  await check('přehled zkratek (?) a jeho zavření Esc', async () => {
    await press('?')
    expect(await ev(`document.body.innerText.includes('Klávesové zkratky')`), 'přehled se neotevřel')
    await shot('prehled-zkratek')
    await press('d') // nástroj jde zapnout i s otevřeným přehledem…
    await press('Escape') // …a Esc zavře jen přehled, nástroj zůstane
    expect(!(await ev(`document.body.innerText.includes('Klávesové zkratky')`)), 'přehled se nezavřel')
    expect((await group(1)).label === 'Dlaždice', 'Esc s otevřeným přehledem vypnul i nástroj')
    await press('Escape')
  })

  const openGroup = i => ev(`document.querySelectorAll('button[aria-haspopup="menu"]')[${i}].click()`)
  const panelText = id => ev(`document.querySelector('[data-panel="${id}"]')?.innerText ?? null`)

  await check('levý panel bez sekcí Pohledy, Vzhled kamery a Prezentace (jsou v liště)', async () => {
    for (const id of ['pohledy', 'kamera', 'prezentace']) expect(!(await section(id)), `sekce ${id} je pořád v panelu`)
  })

  await check('skupina Pohled: perspektiva a shora (klávesa T přepíná)', async () => {
    expect((await group(3)).label === 'Perspektiva', `ve skupině je „${(await group(3)).label}"`)
    // shora se přepne až po krátkém doletu kamery kolmo dolů
    const label = `document.querySelectorAll('button[aria-haspopup="menu"]')[3].innerText.trim()`
    await press('t')
    await waitFor(`${label} === 'Shora'`, 5000, 'přepnutí klávesou T na pohled shora')
    await press('t')
    await waitFor(`${label} === 'Perspektiva'`, 5000, 'přepnutí klávesou T zpátky na perspektivu')
  })

  await check('minimapa: zapnutá od startu, směr pohledu, měřítko nezávislé na sklonu, podklad, klik, N', async () => {
    const cam = `(() => { const p = window.__scene.camera.positionWC; return [p.x, p.y, p.z] })()`
    const start = await ev(cam)
    await waitFor(`!!document.querySelector('[data-minimap="orto"] [data-minimap-view]') && !!document.querySelector('[data-minimap] img')`, 10_000, 'minimapa zapnutá od startu')
    // šikmo na východ: kužel musí mířit od kamery na východ (vpravo)
    await ev(`window.__scene.camera.setView({ orientation: { heading: Math.PI / 2, pitch: -0.45, roll: 0 } }); window.__scene.requestRender()`)
    const geo = () => ev(`(() => {
      const pts = document.querySelector('[data-minimap-view]').getAttribute('points').trim().split(/\\s+/).map(p => p.split(',').map(Number))
      const t = document.querySelector('[data-minimap-cam]').getAttribute('transform').match(/translate\\(([-\\d.]+) ([-\\d.]+)\\) rotate\\(([-\\d.]+)\\)/)
      const m = document.querySelector('[data-minimap]')
      return { pts, cam: [Number(t[1]), Number(t[2])], rot: Number(t[3]), zoom: m.dataset.zoom, img: m.querySelector('img').src,
        height: document.querySelector('[data-minimap-height]')?.innerText ?? '' }
    })()`)
    await waitFor(`Math.abs(Number(document.querySelector('[data-minimap-cam]').getAttribute('transform').match(/rotate\\(([-\\d.]+)\\)/)[1]) - 90) < 1`, 5_000, 'otočení kamery na minimapě')
    const g = await geo()
    const cx = g.pts.reduce((s, p) => s + p[0], 0) / g.pts.length, cy = g.pts.reduce((s, p) => s + p[1], 0) / g.pts.length
    expect(cx - g.cam[0] > 15 && Math.abs(cy - g.cam[1]) < 3, `kužel nemíří na východ: kamera ${g.cam}, těžiště ${cx.toFixed(0)},${cy.toFixed(0)}`)
    expect(g.img.includes('ORTOFOTO_WM'), `dlaždice ortofota: ${g.img}`)
    expect(/↑ [\d,]+ (m|km) nad terénem/.test(g.height) && /\d m n\. m\./.test(g.height), `výška kamery: „${g.height}"`)
    await shot('minimapa')
    // naklonění na místě měřítko nemění (dřív se mapa podle sklonu přibližovala a oddalovala)
    await ev(`window.__scene.camera.setView({ orientation: { heading: Math.PI / 2, pitch: -1.2, roll: 0 } }); window.__scene.requestRender()`)
    await sleep(400)
    const g2 = await geo()
    expect(g2.zoom === g.zoom, `naklonění změnilo měřítko minimapy: ${g.zoom} → ${g2.zoom}`)
    // podklad Topo
    await clickText(`document.querySelector('[data-minimap]')`, 'Topo')
    await waitFor(`!!document.querySelector('[data-minimap="ztm"]') && document.querySelector('[data-minimap] img').src.includes('ZTM_WM')`, 5_000, 'minimapa s topografickou mapou')
    // klik kus vedle kamery při ŠIKMÉM pohledu → kamera (ne bod, na který se dívá) skončí
    // přesně tam, kam se kliklo
    const merc = `const s = Math.sin(c.latitude); return [(c.longitude * 180 / Math.PI + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]`
    const before = await ev(cam)
    const world = await ev(`256 * 2 ** Number(document.querySelector('[data-minimap]').dataset.zoom)`)
    const [ax, ay] = await ev(`(() => { const c = window.__scene.camera.positionCartographic; ${merc} })()`)
    await ev(`(() => { const el = document.querySelector('[data-minimap] [title^="Minimapa"]'); const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2 + 40, clientY: r.top + r.height / 2 + 30 })) })()`)
    await waitFor(`(() => { const p = window.__scene.camera.positionWC, b = ${JSON.stringify(before)}; return Math.hypot(p.x - b[0], p.y - b[1], p.z - b[2]) > 20 })()`, 5_000, 'posun kamery po kliku do minimapy')
    await sleep(1200) // dolet
    const [gx, gy] = await ev(`(() => { const c = window.__scene.camera.positionCartographic; ${merc} })()`)
    const miss = Math.hypot(gx - (ax + 40 / world), gy - (ay + 30 / world)) * world
    expect(miss < 3, `kamera skončila ${miss.toFixed(1)} px od místa kliku na minimapě`)
    // N zavře; zavřenou vrátí tlačítko nad kompasem
    await press('n')
    expect(!(await ev(`!!document.querySelector('[data-minimap]')`)), 'N minimapu nezavřela')
    expect(await ev(`localStorage.getItem('geo.minimap')`) === '0' && await ev(`localStorage.getItem('geo.minimapBase')`) === 'ztm', 'stav minimapy se nezapamatoval')
    await ev(`document.querySelector('[data-minimap-open]').click()`)
    await waitFor(`!!document.querySelector('[data-minimap="ztm"]')`, 3_000, 'minimapa zpátky tlačítkem')
    await ev(`localStorage.removeItem('geo.minimapBase')`)
    // zpátky na výchozí pohled, ať další kontroly začínají stejně
    await ev(`window.__scene.camera.setView({ destination: { x: ${start[0]}, y: ${start[1]}, z: ${start[2]} }, orientation: { heading: 0, pitch: -Math.PI / 2 + 0.0017, roll: 0 } }); window.__scene.requestRender()`)
    await sleep(300)
  })

  await check('panel Kamera: uložení pohledu, vzhled bez bloomu, zůstane otevřený', async () => {
    await openGroup(4)
    await waitFor(`!!document.querySelector('[data-panel="kamera"]')`, 5000, 'panel Kamera')
    let t = await panelText('kamera')
    expect(!t.includes('Perspektiva'), 'perspektiva / shora má být ve vlastní skupině, ne v Kameře')
    expect(await clickText(`document.querySelector('[data-panel="kamera"]')`, 'Uložit aktuální pohled'), 'chybí Uložit aktuální pohled')
    await sleep(600)
    await press('Escape') // nový pohled se otevře k přejmenování — Esc zruší jen přejmenování
    t = await panelText('kamera')
    await shot('panel-kamera')
    expect(t && /1\./.test(t), 'uložený pohled není v seznamu (nebo Esc v poli zavřel panel)')
    expect((await group(4)).label.includes('1'), 'na tlačítku Kamera chybí počet pohledů')
    expect(await clickText(`document.querySelector('[data-panel="kamera"]')`, 'Vzhled'), 'chybí záložka Vzhled')
    await sleep(300)
    t = await panelText('kamera')
    expect(t.includes('Zorný úhel') && t.includes('Rozostření'), 'záložka Vzhled je prázdná')
    await shot('panel-kamera-vzhled')
    expect(!/bloom/i.test(t), 'bloom pořád v nabídce')
    // přišpendlený panel nezavře odjetí myší ani najetí na jinou skupinu
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 300, pointerType: 'mouse' })
    const r = await ev(`(() => { const b = document.querySelectorAll('button[aria-haspopup="menu"]')[1].getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2] })()`)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r[0], y: r[1], pointerType: 'mouse' })
    await sleep(500)
    expect(await panelText('kamera'), 'přišpendlený panel se zavřel')
    expect(!(await ev(`!!document.querySelector('[role="menu"]')`)), 'najetí na jinou skupinu otevřelo její nabídku')
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 300, pointerType: 'mouse' })
    await clickText(`document.querySelector('[data-panel="kamera"]')`, 'Pohledy')

    // mazání pohledu: vlastní okno místo systémového; Esc ho zruší a panel pod ním zůstane
    const kam = `document.querySelector('[data-panel="kamera"]')`
    const deleteView = async () => {
      await ev(`${kam}.querySelector('button[title="Další akce"]').click()`)
      await sleep(200)
      expect(await clickText(kam, 'Smazat'), 'v nabídce pohledu chybí Smazat')
      await waitFor(`!!document.querySelector('[data-dialog]')`, 3000, 'potvrzovací okno')
    }
    await deleteView()
    expect(!dialogs.length, `vyskočilo systémové okno: ${dialogs[0]}`)
    expect((await ev(`document.querySelector('[data-dialog]').innerText`)).includes('Smazat pohled'), 'okno se ptá na něco jiného')
    await shot('dialog-smazat-pohled')
    await press('Escape')
    expect(!(await ev(`!!document.querySelector('[data-dialog]')`)), 'Esc okno nezavřel')
    expect(await panelText('kamera'), 'Esc v okně zavřel i panel pod ním')
    expect(/1\./.test(await panelText('kamera')), 'zrušené mazání pohled stejně smazalo')
    await deleteView()
    await ev(`document.querySelector('[data-dialog-ok]').click()`)
    await sleep(300)
    expect(!/1\./.test(await panelText('kamera')), 'potvrzené mazání pohled nesmazalo')
    expect(await panelText('kamera'), 'potvrzení v okně zavřelo i panel pod ním')

    await press('Escape')
    expect(!(await panelText('kamera')), 'Esc panel nezavřel')
  })

  await check('panel Prezentace: vypínač a popisky, bez pulzu parcel', async () => {
    await openGroup(5)
    await waitFor(`!!document.querySelector('[data-panel="prezentace"]')`, 5000, 'panel Prezentace')
    let t = await panelText('prezentace')
    expect(t.includes('Prezentace zapnutá') && t.includes('Přidat popisek'), 'chybí vypínač nebo popisky')
    await shot('panel-prezentace')
    expect(!/pulz/i.test(t), 'pulz parcel pořád v nabídce')
    expect(await clickText(`document.querySelector('[data-panel="prezentace"]')`, 'Prezentace zapnutá'), 'vypínač nejde zmáčknout')
    await sleep(300)
    t = await panelText('prezentace')
    expect(t.includes('Prezentace vypnutá'), 'vypínač nepřepnul')
    await clickText(`document.querySelector('[data-panel="prezentace"]')`, 'Prezentace vypnutá')
    await press('Escape')
    expect(!(await panelText('prezentace')), 'Esc panel nezavřel')
  })

  await check('detail ortofota: maximální a zpátky', async () => {
    const pod = `document.querySelector('[data-sec="podklad"]')`
    expect(await clickText(pod, 'Maximální'), 'chybí volba Maximální v Podkladu')
    await sleep(1500)
    await shot('podklad-detail-max')
    expect(await ev(`localStorage.getItem('geo.ortoDetail') === 'max'`), 'volba se neuložila')
    expect(await clickText(pod, 'Standardní'), 'chybí volba Standardní')
    await sleep(800)
  })

  if (FULL) {
    await check('kolečko „načítám mapu" se ukáže a po dotažení zmizí', async () => {
      // přelet jinam = nové dlaždice z ČÚZK
      await ev(`(() => { const c = window.__scene.camera; c.moveRight(c.positionCartographic.height * 3); window.__scene.requestRender(); return true })()`)
      await waitFor(`!!document.querySelector('[data-map-loading]')`, 15_000, 'kolečko při načítání')
      await waitFor(`!document.querySelector('[data-map-loading]')`, 120_000, 'zmizení kolečka po dotažení mapy')
    })

    await check('hledání parcely podle čísla (99 České Budějovice 1)', async () => {
      await ev(`(() => { const i = document.querySelector('input[placeholder^="Najít obec"]'); i.focus(); return true })()`)
      await page.send('Input.insertText', { text: '99 České Budějovice 1' })
      await ev(`document.querySelector('input[placeholder^="Najít obec"]').form.requestSubmit()`)
      // Jediná nalezená parcela se vybere rovnou; když se k ní najde i území, nabídne se seznam.
      const hit = `[...document.querySelectorAll('button')].find(b => b.innerText.startsWith('99 · České Budějovice 1'))`
      await waitFor(`!!document.querySelector('[data-sec="parcely"]') || !!${hit}`, 45_000, 'parcela ve výsledcích nebo ve výběru')
      await ev(`${hit}?.click()`)
      await waitFor(`!!document.querySelector('[data-sec="parcely"]')`, 20_000, 'sekce Parcely')
      const row = await ev(`document.querySelector('[data-sec="parcely"]').innerText`)
      expect(/99\s*České Budějovice 1/.test(row), 'v seznamu chybí parcela 99 s k.ú.')
      await sleep(2500)
      await shot('parcela-ze-hledani')
      const kn = await ev(`document.querySelector('[data-sec="parcely"] a[href*="nahlizenidokn"]')?.href ?? ''`)
      expect(kn.includes('typ=parcela'), 'chybí odkaz do Nahlížení do KN')
    })

    await check('2D export parcely ve tvaru výběru (PNG s průhledným okolím)', async () => {
      const sec = `document.querySelector('[data-sec="parcely"]')`
      expect(await clickText(sec, 'Export 2D'), 'chybí Export 2D')
      await sleep(400)
      for (const t of ['ortofoto', '20 cm', 'PNG']) expect(await clickText(sec, t), `chybí volba ${t}`)
      await sleep(300)
      expect(await clickText(sec, 'Obrázek výběru (PNG)'), 'chybí tlačítko exportu')
      await waitFor(`!!document.querySelector('[data-dialog]')`, 5000, 'potvrzení exportu')
      await ev(`document.querySelector('[data-dialog-ok]').click()`)
      let f = null
      for (let i = 0; i < 240 && !f; i++) { await sleep(500); f = readdirSync(downloads).find(n => n.endsWith('.png')) }
      expect(f, 'PNG se nestáhl')
      await sleep(500)
      const s = pngStats(readFileSync(join(downloads, f)))
      expect(s.alpha && s.clear > 0.05 && s.solid > 0.05, `PNG ${s.W}×${s.H}: alfa ${s.alpha}, průhledné ${(s.clear * 100).toFixed(0)} %`)
      return `${s.W}×${s.H} px, ${(s.clear * 100).toFixed(0)} % průhledné`
    })
  }

  await check('okno Klíč Cesium ion: stav klíče, návod a zavření Esc', async () => {
    // Google 3D se v testu schválně nenačítá — čerpalo by kvótu sdíleného klíče
    await ev('window.__openIonKey()')
    await waitFor(`!!document.querySelector('[data-ion-dialog]')`, 3000, 'okno klíče')
    const t = await ev(`document.querySelector('[data-ion-dialog]').innerText`)
    expect(/sdílený zkušební klíč|nemá žádný sdílený/.test(t), 'okno neříká, jaký klíč se používá')
    expect(t.includes('ion.cesium.com') && t.includes('Access Tokens'), 'chybí návod, jak klíč získat')
    expect(t.includes('nejdřív se přihlas'), 'bez přihlášení má okno říct, že se klíč ukládá k účtu')
    await shot('klic-cesium-ion')
    await press('Escape')
    expect(!(await ev(`!!document.querySelector('[data-ion-dialog]')`)), 'Esc okno nezavřel')
    expect(!(await group(1)).color, 'Esc v okně vypnul / zapnul nástroj pod ním')
  })

  await check('náhled scény při odchodu: malý JPEG, ne černý', async () => {
    expect(await clickText('document', 'Scény'), 'chybí tlačítko Scény')
    await waitFor('!!window.__thumb', 10_000, 'náhled scény')
    const t = await ev('window.__thumb')
    expect(t.type === 'image/jpeg' && t.w <= 960 && t.size > 1000, `náhled ${t.type} ${t.w}×${t.h}, ${t.size} B`)
    // bez sítě (CI) může být mapa ještě tmavá; s ČÚZK musí být na náhledu ortofoto
    if (FULL) expect(t.mean > 20, `náhled je skoro černý (průměrný jas ${t.mean.toFixed(0)})`)
    return `${t.w}×${t.h} px, ${Math.round(t.size / 1024)} kB, jas ${t.mean.toFixed(0)}`
  })

  await check('žádné chyby v appce ani systémová okna', async () => {
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
    // appka se ptá vlastním oknem (dialog.tsx); systémové confirm/alert/prompt už nemá vyskočit
    expect(!dialogs.length, `systémové okno: ${dialogs.join(' | ')}`)
  })

  // ── soubor, který se nevešel do úložiště: je „jen v jiném počítači" → najít → příště sám ──
  // (nová stránka se stejným profilem: IndexedDB zůstává, chyby se počítají znovu)
  const mapReady = `!!window.__scene && document.querySelectorAll('button[aria-haspopup="menu"]').length === 6`
  await check('soubor jen v jiném počítači: nabídne se k dohledání, načte se a příště sám', async () => {
    // malý výkres v S-JTSK u centra Českých Budějovic
    const L = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES']
    for (let i = 0; i < 10; i++) L.push('0', 'LINE', '8', 'KRESBA', '10', String(-755900 + i * 20), '20', '-1166250', '11', String(-755900 + i * 20), '21', '-1166050')
    L.push('0', 'ENDSEC', '0', 'EOF')
    const dxfPath = join(work, 'mimo-uloziste.dxf')
    writeFileSync(dxfPath, L.join('\r\n') + '\r\n')
    const url = `${http}/scripts/smoke/index.html?localdxf=${statSync(dxfPath).size}`
    await page.send('Page.navigate', { url })
    await waitFor(mapReady, SOFT ? 120_000 : 60_000, 'mapa po znovunačtení')
    await waitFor(`!!document.querySelector('[data-sec="chybi"]')`, 20_000, 'sekce Chybějící soubory')
    expect((await ev(`document.querySelector('[data-sec="chybi"]').innerText`)).includes('Výkres jen v počítači'), 'v sekci chybí výkres')
    await shot('chybejici-soubory')
    // „Najít soubor…" — vybrat soubor na disku (stejný název i velikost → bez ptaní)
    await page.send('DOM.enable')
    const { result } = await page.send('Runtime.evaluate', { expression: `document.querySelector('[data-relink-input="smoke-local-1"]')` })
    await page.send('DOM.setFileInputFiles', { files: [dxfPath], objectId: result.result.objectId })
    await waitFor(`!document.querySelector('[data-sec="chybi"]')`, 20_000, 'zmizení sekce po dohledání')
    await waitFor(`(document.querySelector('[data-sec="scena"]')?.innerText ?? '').includes('mimo-uloziste')`, 20_000, 'výkres ve scéně')
    // příště už se neptá: znovu otevřít scénu
    await page.send('Page.navigate', { url })
    await waitFor(mapReady, SOFT ? 120_000 : 60_000, 'mapa po druhém otevření')
    await waitFor(`(document.querySelector('[data-sec="scena"]')?.innerText ?? '').includes('mimo-uloziste')`, 20_000, 'výkres z tohohle počítače')
    expect(!(await ev(`!!document.querySelector('[data-sec="chybi"]')`)), 'podruhé se znovu ptá, kde soubor je')
  })

  // ── kam se ukládají soubory: přepínač ve scéně a přesun stávajících ──
  await check('soubory: přepínač cloud / tento počítač, přesun stávajících i jednoho souboru', async () => {
    const dxfSize = statSync(join(work, 'mimo-uloziste.dxf')).size
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?localdxf=${dxfSize}` })
    await waitFor(mapReady, SOFT ? 120_000 : 60_000, 'mapa se souborem v počítači')
    await waitFor(`!!document.querySelector('[data-sec="scena"] [data-file-at="local"]')`, 20_000, 'výkres se štítkem „jen v tomto počítači"')
    // sekce Import → přepínač (výchozí cloud)
    await ev(`document.querySelector('[data-sec="import"] button').click()`)
    await waitFor(`!!document.querySelector('[data-file-storage="cloud"]')`, 5_000, 'přepínač ukládání (cloud)')
    // na „tento počítač": jediný soubor už tam je → nic se nepřesouvá, nic se neptá
    await clickText(`document.querySelector('[data-file-storage]')`, 'Tento počítač')
    await waitFor(`!!document.querySelector('[data-file-storage="local"]')`, 5_000, 'přepnutí na tento počítač')
    expect(!(await ev(`!!document.querySelector('[data-dialog]')`)), 'ptá se na přesun, i když není co přesouvat')
    expect((await ev('window.__patches')).some(p => p.fileStorage === 'local'), 'volba se neuložila do scény')
    // zpátky na cloud: soubor je jinde → zeptá se a po potvrzení ho přesune
    await clickText(`document.querySelector('[data-file-storage]')`, 'Cloud')
    await waitFor(`(document.querySelector('[data-dialog]')?.innerText ?? '').includes('Přesunout i stávající soubory (1)')`, 5_000, 'dotaz na přesun stávajícího souboru')
    await ev(`document.querySelector('[data-dialog-ok]').click()`)
    await waitFor(`!!document.querySelector('[data-sec="scena"] [data-file-at="cloud"]') && !document.querySelector('[data-sec="scena"] [data-file-at="local"]')`, 10_000, 'soubor přesunutý do cloudu')
    // jeden soubor zpátky do počítače kliknutím na jeho štítek
    await ev(`document.querySelector('[data-sec="scena"] [data-file-at="cloud"]').click()`)
    await waitFor(`!!document.querySelector('[data-dialog-ok]')`, 5_000, 'potvrzení přesunu souboru')
    await ev(`document.querySelector('[data-dialog-ok]').click()`)
    await waitFor(`!!document.querySelector('[data-sec="scena"] [data-file-at="local"]')`, 10_000, 'soubor zpátky v počítači')
    const moves = await ev('window.__moves')
    expect(JSON.stringify(moves) === JSON.stringify([['smoke-local-1', 'cloud'], ['smoke-local-1', 'local']]), `přesuny: ${JSON.stringify(moves)}`)
    await shot('soubory-uloziste')
  })

  // ── model z Maxu s S-JTSK v geometrii: georeference ve workeru (modelWorker.ts) ──
  await check('model s S-JTSK souřadnicemi: příprava ve workeru, usazení u Kladna', async () => {
    const glbPath = join(work, 'model-sjtsk.glb')
    writeFileSync(glbPath, sjtskGlb(40, 64))
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html` })
    await waitFor(mapReady, SOFT ? 120_000 : 60_000, 'mapa pro import modelu')
    await page.send('DOM.enable')
    const { result } = await page.send('Runtime.evaluate', { expression: `document.querySelector('input[type=file][accept=".glb,.gltf,.obj"]')` })
    await page.send('DOM.setFileInputFiles', { files: [glbPath], objectId: result.result.objectId })
    // boundingSphere nenačteného modelu hází DeveloperError — hledat podle readyEvent
    const model = `window.__scene.primitives._primitives.find(p => p.constructor.name.includes('Model') && 'readyEvent' in p)`
    await waitFor(`!!${model}?.ready`, 60_000, 'načtený model')
    const at = await ev(`(() => { const c = ${model}.boundingSphere.center
      return [Math.atan2(c.y, c.x) * 180 / Math.PI, Math.atan2(c.z, Math.hypot(c.x, c.y) * (1 - 0.00669438)) * 180 / Math.PI] })()`)
    expect(Math.abs(at[0] - 14.05) < 0.01 && Math.abs(at[1] - 50.142) < 0.01, `model mimo Kladno: ${at.map(v => v.toFixed(4))}`)
    expect((await ev(`document.body.innerText`)).includes('Model usazen podle S-JTSK'), 'chybí hláška o usazení podle S-JTSK')
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
    return `${at[0].toFixed(4)}°, ${at[1].toFixed(4)}°`
  })

  // ── Nastavení účtu s podvrženým uživatelem (bez Supabase — jen formuláře a jejich kontroly) ──
  await check('nastavení účtu: bloky, kontrola hesel, pojistka mazání', async () => {
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?page=account` })
    await waitFor(`!!document.querySelector('[data-account-card="Smazat účet"]')`, 30_000, 'stránka Nastavení účtu')
    for (const t of ['Jméno', 'E-mail', 'Heslo', 'Klíč Cesium ion', 'Smazat účet']) {
      expect(await ev(`!!document.querySelector('[data-account-card="${t}"]')`), `chybí blok ${t}`)
    }
    // React si hodnotu pole bere z události input — nastavit přes nativní setter
    const fill = (card, i, v) => ev(`(() => {
      const el = document.querySelectorAll('[data-account-card="${card}"] input')[${i}]
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await fill('Heslo', 0, 'stare-heslo'); await fill('Heslo', 1, 'nove-heslo'); await fill('Heslo', 2, 'nove-hesl0')
    await ev(`document.querySelector('[data-account-card="Heslo"] form').requestSubmit()`)
    await sleep(300)
    expect((await ev(`document.querySelector('[data-account-card="Heslo"]').innerText`)).includes('neshodují'), 'neshodná hesla prošla bez upozornění')
    const delBtn = `[...document.querySelectorAll('[data-account-card="Smazat účet"] button')].pop()`
    expect(await ev(`${delBtn}.disabled`), 'mazání jde spustit bez potvrzení')
    await fill('Smazat účet', 0, 'heslo'); await sleep(100)
    expect(await ev(`${delBtn}.disabled`), 'mazání jde spustit jen s heslem, bez napsaného SMAZAT')
    await fill('Smazat účet', 1, 'smazat'); await sleep(100)
    expect(!(await ev(`${delBtn}.disabled`)), 'po hesle a SMAZAT se tlačítko neodemklo')
    await shot('nastaveni-uctu')
  })

  // React si hodnotu pole bere z události input — nastavit přes nativní setter
  const setInput = (sel, v) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  // ── přehled scén nad podvrženou databází (smoke/fakeRest.ts): popisky, hledání, řazení, nabídky ──
  await check('přehled scén: popsaná hlavička, karty, hledání, řazení, nabídky', async () => {
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?page=scenes` })
    await waitFor(`document.querySelectorAll('[data-scene-card]').length === 4`, 30_000, 'čtyři karty scén')
      .catch(async e => { throw new Error(`${e.message}; stránka: „${await ev(`document.body.innerText.slice(0, 300)`)}"`) })
    const head = await ev(`document.querySelector('header').innerText`)
    for (const t of ['Nová scéna', '3D dlaždice · klíč Cesium', 'sdílený', 'Účet']) expect(head.includes(t), `hlavička bez „${t}": ${head}`)
    // scéna viditelná jen přes odkaz pro prohlížení do přehledu nepatří
    expect(!(await ev(`!!document.querySelector('[data-scene-id="smoke-view"]')`)), 'v přehledu je scéna, kam mám jen odkaz')
    const own = `[...document.querySelectorAll('[data-scene-card="owner"]')].map(c => c.dataset.sceneId).join(',')`
    expect(await ev(own) === 'p-kladno,p-most,p-cb', `pořadí „naposledy otevřené": ${await ev(own)}`)
    const card = id => ev(`document.querySelector('[data-scene-id="${id}"]').innerText`)
    const kladno = await card('p-kladno'), most = await card('p-most'), cb = await card('p-cb'), jana = await card('p-jana')
    expect(kladno.includes('2 soubory') && kladno.includes('otevřeno dnes') && kladno.includes('Sdíleno · 1 člověk'), `karta Kladna: ${kladno}`)
    expect(most.includes('1 soubor') && most.includes('otevřeno včera') && most.includes('Veřejný odkaz') && !most.includes('Sdíleno'), `karta Mostu: ${most}`)
    expect(cb.includes('0 souborů') && !cb.includes('Veřejný odkaz'), `karta Budějovic: ${cb}`)
    expect(jana.includes('Sdílí Jana · může upravovat') && jana.includes('upraveno'), `cizí karta: ${jana}`)
    await shot('prehled-scen')

    // hledání bez diakritiky a velikosti písmen
    await setInput('#scene-search', 'BUDEJOVICE')
    await waitFor(`document.querySelectorAll('[data-scene-card]').length === 1`, 3_000, 'jedna nalezená scéna')
    const found = await ev(`document.body.innerText`)
    expect(found.includes('(1 z 3)') && found.includes('Žádná sdílená scéna neodpovídá'), 'počty a hláška při hledání')
    await setInput('#scene-search', '')
    await waitFor(`document.querySelectorAll('[data-scene-card]').length === 4`, 3_000, 'všechny scény po smazání hledání')

    // řazení (select bere událost change)
    const sortBy = v => ev(`(() => {
      const el = document.querySelector('#scene-sort')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(v)})
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await sortBy('name'); await sleep(150)
    expect(await ev(own) === 'p-cb,p-kladno,p-most', `podle názvu: ${await ev(own)}`)
    await sortBy('created'); await sleep(150)
    expect(await ev(own) === 'p-most,p-cb,p-kladno', `nejnovější: ${await ev(own)}`)
    expect(await ev(`localStorage.getItem('geo.scenesSort')`) === 'created', 'řazení se nezapamatovalo')
    await sortBy('opened'); await sleep(150)

    // nabídka ⋯: u mé scény Sdílet i Smazat, u cizí jen Odejít; Esc ji zavře
    const items = async id => {
      await ev(`document.querySelector('[data-scene-id="${id}"] button[aria-haspopup="menu"]').click()`)
      await waitFor(`!!document.querySelector('[role="menu"]')`, 3_000, `nabídka scény ${id}`)
      const t = await ev(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => b.innerText.trim()).join(' | ')`)
      return t
    }
    const mine = await items('p-kladno')
    expect(mine === 'Otevřít | Sdílet… | Přejmenovat | Smazat scénu…', `nabídka mé scény: ${mine}`)
    await shot('prehled-scen-nabidka')
    await press('Escape')
    expect(!(await ev(`!!document.querySelector('[role="menu"]')`)), 'Esc nezavřel nabídku')
    const theirs = await items('p-jana')
    expect(theirs === 'Otevřít | Přejmenovat | Odejít ze scény…', `nabídka cizí scény: ${theirs}`)

    // přejmenování z nabídky → PATCH a nový název na kartě
    await press('Escape')
    await items('p-cb')
    await clickText(`document.querySelector('[role="menu"]')`, 'Přejmenovat')
    await waitFor(`!!document.querySelector('[data-scene-id="p-cb"] form input')`, 3_000, 'pole pro nový název')
    await setInput('[data-scene-id="p-cb"] form input', 'ČB – sever, 2. etapa')
    await ev(`document.querySelector('[data-scene-id="p-cb"] form').requestSubmit()`)
    await waitFor(`(document.querySelector('[data-scene-id="p-cb"]')?.innerText ?? '').includes('ČB – sever, 2. etapa')`, 5_000, 'nový název na kartě')
    const patch = (await ev('window.__rest')).find(c => c.method === 'PATCH' && c.path === 'geo_scenes')
    expect(patch?.body?.name === 'ČB – sever, 2. etapa', `přejmenování poslalo ${JSON.stringify(patch?.body)}`)

    // účet: nabídka s e-mailem, nastavení a odhlášením
    await ev(`document.querySelector('header button[aria-label="Účet"]').click()`)
    await waitFor(`!!document.querySelector('[role="menu"]')`, 3_000, 'nabídka účtu')
    const acc = await ev(`document.querySelector('[role="menu"]').innerText`)
    for (const t of ['test@example.cz', 'Nastavení účtu', 'Odhlásit se']) expect(acc.includes(t), `nabídka účtu bez „${t}": ${acc}`)
    await shot('prehled-scen-ucet')
    await clickText(`document.querySelector('[role="menu"]')`, 'Nastavení účtu')
    await waitFor(`document.querySelector('#navigated')?.innerText === '/account'`, 3_000, 'přechod na nastavení účtu')

    // úzký telefon: hlavička i ovládání se zalomí, nic nepřeteče do strany
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 1, mobile: true })
      await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?page=scenes` })
      await waitFor(`document.querySelectorAll('[data-scene-card]').length === 4`, 30_000, 'karty na telefonu')
      const sw = await ev(`document.documentElement.scrollWidth`)
      expect(sw <= 400, `přehled přetéká na telefonu: ${sw} px`)
      await shot('prehled-scen-telefon')
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride')
    }
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
  })

  // ── sdílení scény: okno s lidmi a pozvánkami (podvržené REST API, viz smoke/fakeRest.ts) ──
  await check('sdílení: lidé, pozvánka, odebrání s potvrzením, Esc po vrstvách', async () => {
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html` })
    await waitFor(mapReady, SOFT ? 120_000 : 60_000, 'mapa vlastní scény')
    expect(!(await ev(`!!document.querySelector('[data-access]')`)), 'vlastní scéna má štítek cizí scény')
    await ev(`document.querySelector('[data-share-open]').click()`)
    await waitFor(`!!document.querySelector('[data-share-member="jana@example.cz"]') && !!document.querySelector('[data-share-invite="novy@example.cz"]')`, 10_000, 'členka a pozvánka v okně')
      .catch(async e => { throw new Error(`${e.message}; okno: „${await ev(`document.querySelector('[data-share-dialog]')?.innerText.slice(0, 300)`)}"; REST: ${JSON.stringify(await ev('window.__rest'))}`) })
    // pozvat nový e-mail (výchozí role „může upravovat")
    await setInput('[data-share-dialog] input[type="email"]', 'Kolega@Example.cz')
    await ev(`document.querySelector('[data-share-dialog] form').requestSubmit()`)
    await waitFor(`!!document.querySelector('[data-share-invite="kolega@example.cz"]')`, 10_000, 'nová pozvánka v seznamu')
    const call = (await ev('window.__rest')).find(c => c.path === 'rpc/share_scene')
    expect(call?.body?.p_email === 'kolega@example.cz' && call.body.p_role === 'editor', `share_scene dostal ${JSON.stringify(call?.body)}`)
    expect((await ev(`document.querySelector('[data-share-dialog]').innerText`)).includes('zatím nemá účet'), 'chybí hláška o čekající pozvánce')
    await shot('sdileni')
    // odebrat Janu → potvrzení; Esc zavře jen potvrzení, okno sdílení zůstane
    await ev(`document.querySelector('[data-share-member="jana@example.cz"] button[title="Odebrat přístup"]').click()`)
    await waitFor(`!!document.querySelector('[data-dialog]')`, 5_000, 'potvrzení odebrání')
    await press('Escape')
    expect(!(await ev(`!!document.querySelector('[data-dialog]')`)), 'Esc nezavřel potvrzení')
    expect(await ev(`!!document.querySelector('[data-share-member="jana@example.cz"]')`), 'zrušené odebrání stejně odebralo nebo zavřelo okno')
    await ev(`document.querySelector('[data-share-member="jana@example.cz"] button[title="Odebrat přístup"]').click()`)
    await waitFor(`!!document.querySelector('[data-dialog-ok]')`, 5_000, 'potvrzení podruhé')
    await ev(`document.querySelector('[data-dialog-ok]').click()`)
    await waitFor(`!document.querySelector('[data-share-member="jana@example.cz"]')`, 10_000, 'odebrání Jany')
    // odkaz jen pro prohlížení: zapnout → adresa #/view/…, vypnout s potvrzením
    const sw = `document.querySelector('[data-view-link] button[role="switch"]')`
    await waitFor(`document.querySelector('[data-view-link]')?.dataset.viewLink === 'off' && !${sw}.disabled`, 5_000, 'vypínač odkazu pro prohlížení')
    await ev(`${sw}.click()`)
    await waitFor(`document.querySelector('[data-view-link]')?.dataset.viewLink === 'on'`, 5_000, 'zapnutý odkaz')
    const link = await ev(`document.querySelector('[data-view-link] input').value`)
    expect(link.endsWith('#/view/tok-1'), `adresa odkazu: ${link}`)
    await ev(`${sw}.click()`)
    await waitFor(`!!document.querySelector('[data-dialog-ok]')`, 5_000, 'potvrzení vypnutí odkazu')
    await ev(`document.querySelector('[data-dialog-ok]').click()`)
    await waitFor(`document.querySelector('[data-view-link]')?.dataset.viewLink === 'off'`, 5_000, 'vypnutý odkaz')
    // Esc s fokusem mimo okno zavře okno — a nic pod ním (nástroj se nezapne, lišta zůstane)
    await ev(`document.activeElement?.blur()`)
    await press('Escape')
    expect(!(await ev(`!!document.querySelector('[data-share-dialog]')`)), 'Esc nezavřel okno sdílení')
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
  })

  await check('sdílená scéna „jen prohlížet": štítek s vlastníkem, bez tlačítka Sdílet', async () => {
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?access=viewer` })
    await waitFor(mapReady, SOFT ? 120_000 : 60_000, 'mapa cizí scény')
    const badge = await ev(`document.querySelector('[data-access="viewer"]')?.innerText ?? ''`)
    expect(badge.includes('Jen prohlížíš') && badge.includes('Jana'), `štítek: „${badge}"`)
    expect(!(await ev(`!!document.querySelector('[data-share-open]')`)), 'kdo jen prohlíží, nemá tlačítko Sdílet')
  })

  // ── veřejný prohlížeč: odkaz bez účtu (anonymní přihlášení proti podvrženému API) ──
  await check('veřejný prohlížeč (#/view/…): bez účtu, klíč vlastníka, jen prohlížení a měření', async () => {
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?page=view#/view/tok-ukazka` })
    await waitFor(`!!window.__scene && document.querySelectorAll('button[aria-haspopup="menu"]').length === 5`, SOFT ? 120_000 : 60_000, 'mapa prohlížeče')
      .catch(async e => { throw new Error(`${e.message}; stránka: „${await ev(`document.body.innerText.slice(0, 300)`)}"`) })
    const rest = await ev('window.__rest')
    expect(rest.some(c => c.path === 'auth/signup'), 'neproběhlo anonymní přihlášení')
    expect(rest.find(c => c.path === 'rpc/open_scene_link')?.body?.p_token === 'tok-ukazka', 'odkaz se neotevřel s kódem z adresy')
    const ion = await ev('window.__ion()')
    expect(ion === 'klic-vlastnika', `3D realita nejede na klíč vlastníka scény (${ion})`)
    const badge = await ev(`document.querySelector('[data-access]')?.innerText ?? ''`)
    expect(badge.includes('Jana') && badge.includes('měřit'), `štítek: „${badge}"`)
    const labels = await ev(`[...document.querySelectorAll('button[aria-haspopup="menu"]')].map(b => b.innerText.trim())`)
    expect(!labels.some(l => l.startsWith('Výběr')), `v liště je výběr: ${labels.join(', ')}`)
    for (const id of ['import', 'souradnice', 'parcely', 'dlazdice', 'uzemi']) expect(!(await section(id)), `prohlížeč má sekci ${id}`)
    expect(await ev(`!document.querySelector('[data-share-open]') && ![...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Scény')`), 'prohlížeč má Sdílet nebo cestu do přehledu')
    // zkratky výběru nic nedělají, měření jde
    await ev(`document.activeElement?.blur()`)
    await press('p')
    expect(!(await ev(`document.body.innerText.includes('Klikni na parcelu')`)), 'klávesa P zapnula výběr parcel')
    await press('m')
    expect((await group(1)).label === 'Vzdálenost', `klávesa M nezapnula měření (${(await group(1)).label})`)
    await press('Escape')
    // kamera a prezentace: přehrát ano, upravovat ne
    await ev(`document.querySelectorAll('button[aria-haspopup="menu"]')[3].click()`)
    await waitFor(`!!document.querySelector('[data-panel="kamera"]')`, 5_000, 'panel Kamera')
    await clickText(`document.querySelector('[data-panel="kamera"]')`, 'Pohledy')
    await sleep(200)
    const cam = await ev(`document.querySelector('[data-panel="kamera"]').innerText`)
    expect(!cam.includes('Uložit aktuální pohled') && cam.includes('nemá uložené pohledy'), `panel Kamera: „${cam.slice(0, 120)}"`)
    await ev(`document.querySelectorAll('button[aria-haspopup="menu"]')[4].click()`)
    await waitFor(`!!document.querySelector('[data-panel="prezentace"]')`, 5_000, 'panel Prezentace')
    const pres = await ev(`document.querySelector('[data-panel="prezentace"]').innerText`)
    expect(pres.includes('Prezentace') && !pres.includes('Přidat popisek'), `panel Prezentace: „${pres.slice(0, 120)}"`)
    await press('Escape')
    await shot('prohlizec')
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
  })

  await check('neplatný odkaz pro prohlížení: hláška místo mapy', async () => {
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?page=view#/view/spatny` })
    await waitFor(`!!document.querySelector('[data-view-error]')`, 20_000, 'hláška o neplatném odkazu')
    const t = await ev(`document.querySelector('[data-view-error]').innerText`)
    expect(t.includes('neplatí'), `hláška: „${t}"`)
  })

  // ── pozadí přihlášení a přehledu scén (textury z workeru, přechod tam a zpátky) ──
  await check('pozadí: krajina z workeru, přechod do přehledu scén a zpátky', async () => {
    await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html?page=backdrop` })
    await waitFor(`!!document.querySelector('.bd-stage.bd-ready')`, 20_000, 'hotové textury pozadí')
    // každá deska má nakreslenou plochu (ne prázdný canvas)
    const painted = await ev(`[...document.querySelectorAll('.bd-face')].map(c => {
      const g = c.getContext('2d'); const d = g.getImageData(c.width / 2 | 0, c.height / 2 | 0, 1, 1).data
      return c.width + ':' + d[3]
    })`)
    expect(painted.length === 4 && painted.every(p => p === '512:255'), `plochy desek: ${painted.join(', ')}`)
    const slices = await ev(`document.querySelectorAll('.bd-slice').length`)
    expect(slices === 14, `vrstevnic modelu: ${slices}`)
    // přehled: mapy zmizí, terén se překreslí v plném rozlišení
    await ev(`window.__backdrop('overview')`)
    await waitFor(`[...document.querySelectorAll('.bd-see > .bd-face')].every(f => getComputedStyle(f).opacity === '0')`, 6_000, 'zmizení map v přehledu')
    await waitFor(`document.querySelector('.bd-plate .bd-face').width === 1024`, 20_000, 'terén v plném rozlišení')
    await shot('pozadi-prehled')
    // zpátky na přihlášení: mapy se vrátí a cyklus skládání jede dál (CSS animace, žádné převzaté)
    await ev(`window.__backdrop('login')`)
    await waitFor(`[...document.querySelectorAll('.bd-see > .bd-face')].every(f => getComputedStyle(f).opacity === '1')
      && [...document.querySelectorAll('.bd-plate')].every(p => p.getAnimations().length && p.getAnimations().every(a => a instanceof CSSAnimation))`, 8_000, 'návrat map a cyklu')
    await shot('pozadi-prihlaseni')
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
  })

  // ── tablet na výšku: nic nesmí přetéct (prohlížeč by jinak celou stránku zmenšil) ──
  await check('tablet na výšku: lišta, vyhledávání a stránka se vejdou', async () => {
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 1, mobile: true })
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await page.send('Page.navigate', { url: `${http}/scripts/smoke/index.html` })
      await waitFor(mapReady, SOFT ? 120_000 : 60_000, 'mapa na tabletu')
      expect(await ev(`!![...document.querySelectorAll('button')].find(b => b.title === 'Zobrazit panel')`), 'panel na úzké obrazovce začíná otevřený')
      await ev(`[...document.querySelectorAll('button')].find(b => b.title === 'Zobrazit panel').click()`)
      // Počkat, až panel opravdu vyjede a lišta s vyhledáváním dojedou vedle něj (posun je
      // animovaný). Pevná pauza nestačila: na pomalém stroji CI se softwarovou grafikou
      // se měřilo dřív, než se panel stihl otevřít.
      await waitFor(`(() => {
        if (!document.querySelector('button[title="Skrýt panel"]')) return false
        const bar = document.querySelector('button[aria-haspopup="menu"]').closest('.relative.flex').getBoundingClientRect()
        const s = document.querySelector('input[placeholder^="Najít"]').closest('form').getBoundingClientRect()
        return bar.left >= 320 && s.left >= 320
      })()`, 15_000, 'otevření panelu a posun lišty vedle něj')
        .catch(async e => { throw new Error(`${e.message}; lišta ${await ev(`(() => { const r = document.querySelector('button[aria-haspopup="menu"]').closest('.relative.flex').getBoundingClientRect(); return Math.round(r.left) + '–' + Math.round(r.right) })()`)}`) })
      await sleep(300)   // dojezd animace
      const m = await ev(`(() => {
        const bar = document.querySelector('button[aria-haspopup="menu"]').closest('.relative.flex').getBoundingClientRect()
        const s = document.querySelector('input[placeholder^="Najít"]').closest('form').getBoundingClientRect()
        const help = [...document.querySelectorAll('button')].find(b => b.title === 'Klávesové zkratky (?)')
        return { vw: innerWidth, sw: document.documentElement.scrollWidth, bar: [Math.round(bar.left), Math.round(bar.right)], search: [Math.round(s.left), Math.round(s.right)], help: help ? getComputedStyle(help).display : 'none' }
      })()`)
      expect(m.vw === 820 && m.sw <= 820, `stránka přetéká: viewport ${m.vw}, obsah ${m.sw}`)
      expect(m.bar[0] >= 320 && m.bar[1] <= 820 - 56, `lišta mimo viditelnou mapu: ${m.bar}`)
      expect(m.search[0] >= 320 && m.search[1] <= 820, `vyhledávání pod panelem: ${m.search}`)
      expect(m.help === 'none', 'na dotyku je vidět tlačítko klávesových zkratek')
      await shot('tablet-na-vysku')
      return `lišta ${m.bar[0]}–${m.bar[1]} px`
    } finally {
      await page.send('Emulation.clearDeviceMetricsOverride')
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    }
  })

  await check('žádné chyby po znovuotevření scén a sdílení', async () => {
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
    expect(!dialogs.length, `systémové okno: ${dialogs.join(' | ')}`)
  })
}

try {
  await main()
} catch (e) {
  results.push({ name: 'příprava', ok: false })
  console.log(`  ✗ ${e?.message ?? e}`)
} finally {
  // zavřít prohlížeč přes protokol — kill samotného procesu nechá na Windows viset jeho podprocesy
  try { await browser?.send('Browser.close') } catch { /* už neběží */ }
  await sleep(500)
  try { chrome?.kill() } catch { /* */ }
  server?.close()
  if (!KEEP) try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows občas drží zámek profilu */ }
  else console.log(`▸ build a profil zůstaly v ${work}`)
}
const failed = results.filter(r => !r.ok).length
console.log(failed ? `\n${failed} z ${results.length} kontrol selhalo` : `\nVŠE PROŠLO (${results.length} kontrol)`)
process.exit(failed ? 1 : 0)
