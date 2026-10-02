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
import { inflateSync } from 'node:zlib'

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
/** Popisek a barva tlačítka skupiny v liště (0 podklad, 1 výběr, 2 nástroje, 3 kamera, 4 prezentace). */
const group = i => ev(`(() => { const b = document.querySelectorAll('button[aria-haspopup="menu"]')[${i}]; const m = b.className.match(/bg-(${COLORS})-600/); return { label: b.innerText.trim(), color: m ? m[1] : null } })()`)
/** Sekce panelu: existuje? rozbalená? obarvená? */
const section = id => ev(`(() => { const d = document.querySelector('[data-sec="${id}"]'); if (!d) return null; const m = d.className.match(/border-(${COLORS})-500/); return { open: d.children.length > 1, color: m ? m[1] : null, title: d.querySelector('button')?.innerText.trim() } })()`)
const clickText = (scope, text) => ev(`(() => { const bs = [...(${scope}).querySelectorAll('button')]; const b = bs.find(b => b.innerText.trim() === ${JSON.stringify(text)}) ?? bs.find(b => b.innerText.includes(${JSON.stringify(text)})); b?.click(); return !!b })()`)

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
    await waitFor(`!!window.__scene && document.querySelectorAll('button[aria-haspopup="menu"]').length === 5`, SOFT ? 120_000 : 60_000, 'scéna Cesia a lišta nástrojů')
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

  await check('panel Kamera: projekce, uložení pohledu, vzhled bez bloomu, zůstane otevřený', async () => {
    await openGroup(3)
    await waitFor(`!!document.querySelector('[data-panel="kamera"]')`, 5000, 'panel Kamera')
    let t = await panelText('kamera')
    expect(t.includes('Perspektiva') && t.includes('Shora'), 'chybí přepínač projekce')
    expect(await clickText(`document.querySelector('[data-panel="kamera"]')`, 'Uložit aktuální pohled'), 'chybí Uložit aktuální pohled')
    await sleep(600)
    await press('Escape') // nový pohled se otevře k přejmenování — Esc zruší jen přejmenování
    t = await panelText('kamera')
    await shot('panel-kamera')
    expect(t && /1\./.test(t), 'uložený pohled není v seznamu (nebo Esc v poli zavřel panel)')
    expect((await group(3)).label.includes('1') || (await ev(`document.querySelectorAll('button[aria-haspopup="menu"]')[3].innerText`)).includes('1'), 'na tlačítku Kamera chybí počet pohledů')
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
    await press('Escape')
    expect(!(await panelText('kamera')), 'Esc panel nezavřel')
  })

  await check('panel Prezentace: vypínač a popisky, bez pulzu parcel', async () => {
    await openGroup(4)
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
      let f = null
      for (let i = 0; i < 240 && !f; i++) { await sleep(500); f = readdirSync(downloads).find(n => n.endsWith('.png')) }
      expect(f, 'PNG se nestáhl')
      await sleep(500)
      const s = pngStats(readFileSync(join(downloads, f)))
      expect(s.alpha && s.clear > 0.05 && s.solid > 0.05, `PNG ${s.W}×${s.H}: alfa ${s.alpha}, průhledné ${(s.clear * 100).toFixed(0)} %`)
      return `${s.W}×${s.H} px, ${(s.clear * 100).toFixed(0)} % průhledné`
    })
  }

  await check('žádné chyby v appce', async () => {
    const errs = await ev('window.__errors')
    expect(!errs.length, `${errs.length}× chyba:\n    ${errs.slice(0, 5).join('\n    ')}`)
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
