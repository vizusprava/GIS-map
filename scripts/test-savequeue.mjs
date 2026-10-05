/**
 * Kontrola fronty odloženého ukládání (`src/lib/saveQueue.ts`).
 *
 * Tahle fronta drží všechno, co se ze scény ukládá na server. Chyba v ní se v appce neprojeví
 * hned — projeví se tím, že po refreshi chybí práce. Proto se tu zkouší přesně ty situace,
 * kvůli kterým fronta vznikla: slučování, pořadí pomalých zápisů a opakování po výpadku.
 *
 * Spustit: `npm run test:savequeue`
 */
import { createSaveQueue } from '../src/lib/saveQueue.ts'
import { createDirtyKeys, pickPatch } from '../src/lib/dirtyKeys.ts'

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
// chyby z fronty jdou do konzole schválně; v testu by jen zaplevelily výstup
const quiet = () => { const e = console.error; console.error = () => {}; return () => { console.error = e } }

console.log('\n── rychlé změny za sebou se slijí do jednoho zápisu ──')
{
  const sent = []
  const q = createSaveQueue({ debounceMs: 30, label: 'test', send: async (k, v) => { sent.push([k, v]) } })
  q.save('a', 1); q.save('a', 2); q.save('a', 3)
  ok(q.hasPending('a'), 'hned po změně něco čeká')
  await sleep(80)
  ok(sent.length === 1, `odešel jeden zápis (odešlo ${sent.length})`)
  ok(sent[0]?.[1] === 3, `s poslední hodnotou (odešla ${sent[0]?.[1]})`)
  ok(!q.hasPending('a'), 'po zápisu už nic nečeká')
}

console.log('\n── flush pošle hned, bez čekání na odklad ──')
{
  const sent = []
  const q = createSaveQueue({ debounceMs: 10_000, label: 'test', send: async (k, v) => { sent.push(v) } })
  q.save('a', 'x')
  await q.flush('a')
  ok(sent.length === 1 && sent[0] === 'x', 'zapsáno před koncem odkladu')
  await q.flush('a')
  ok(sent.length === 1, 'druhý flush bez změny nic neposílá')
}

console.log('\n── pomalý starší zápis nepřepíše novější ──')
{
  // první zápis trvá dlouho; mezitím přijde novější hodnota — na serveru musí skončit ta novější
  let server = null
  const order = []
  const q = createSaveQueue({
    debounceMs: 10, label: 'test',
    send: async (k, v) => {
      order.push(`start ${v}`)
      await sleep(v === 'stará' ? 120 : 5)
      server = v
      order.push(`konec ${v}`)
    },
  })
  q.save('a', 'stará')
  await sleep(30)               // stará už se posílá
  q.save('a', 'nová')
  await sleep(250)
  ok(server === 'nová', `na serveru skončila nová hodnota (je tam „${server}")`)
  ok(order.join(' | ') === 'start stará | konec stará | start nová | konec nová', `zápisy šly po jednom (${order.join(' | ')})`)
}

console.log('\n── po chybě se zápis zopakuje sám ──')
{
  const restore = quiet()
  let attempts = 0, server = null
  const q = createSaveQueue({
    debounceMs: 10, label: 'test', retryMs: [40],
    send: async (k, v) => { attempts++; if (attempts === 1) throw new Error('síť spadla'); server = v },
  })
  q.save('a', 'práce')
  await sleep(25)
  ok(attempts === 1 && server === null, 'první pokus selhal')
  ok(q.hasPending('a'), 'neuložená hodnota pořád čeká (hlásí se před zavřením okna)')
  await sleep(80)
  restore()
  ok(attempts === 2, `zkusilo se znovu bez další změny (pokusů ${attempts})`)
  ok(server === 'práce', 'a podruhé to prošlo')
  ok(!q.hasPending('a'), 'pak už nic nečeká')
}

console.log('\n── novější změna má přednost před tou, co selhala ──')
{
  const restore = quiet()
  let attempts = 0
  const sent = []
  const q = createSaveQueue({
    debounceMs: 10, label: 'test', retryMs: [60],
    send: async (k, v) => {
      attempts++
      if (attempts === 1) { await sleep(20); throw new Error('timeout') }
      sent.push(v)
    },
  })
  q.save('a', 'stará')
  await sleep(15)               // stará se posílá a za chvíli selže
  q.save('a', 'nová')           // mezitím přijde novější
  await sleep(150)
  restore()
  ok(!sent.includes('stará'), 'selhaná stará hodnota se znovu neposlala')
  ok(sent[sent.length - 1] === 'nová', `uložila se nová (${sent.join(', ')})`)
}

console.log('\n── klíče se navzájem neblokují a cancel zahodí čekající zápis ──')
{
  const sent = []
  const q = createSaveQueue({ debounceMs: 20, label: 'test', send: async (k, v) => { sent.push(`${k}=${v}`) } })
  q.save('a', 1); q.save('b', 2)
  q.cancel('a')
  ok(q.hasPending() && !q.hasPending('a'), 'po cancel čeká jen druhý klíč')
  await sleep(60)
  ok(sent.join(',') === 'b=2', `odešel jen nezrušený klíč (${sent.join(',')})`)
  q.save('c', 3)
  await q.flush()
  ok(sent.includes('c=3'), 'flush bez klíče dopíše všechno')
}

console.log('\n── sdílená scéna: posílají se jen změněné klíče ──')
{
  // dva lidi ve stejné scéně: server vmíchává patch (jako `state || patch` v databázi)
  let server = { camViews: ['jeho pohled'], rulers: [] }
  const dirty = createDirtyKeys()
  const q = createSaveQueue({
    debounceMs: 10, label: 'test',
    send: async (k, state) => {
      const snap = dirty.take(k)
      server = { ...server, ...pickPatch(state, snap.keys()) }
      dirty.done(k, snap)
    },
  })
  // můj stav o jeho pohledu neví — kdyby šel celý, pohled by zmizel
  const mine = { camViews: [], rulers: ['moje měření'] }
  dirty.mark('s', ['rulers']); q.save('s', mine)
  await q.flush('s')
  ok(server.camViews[0] === 'jeho pohled', 'cizí změna jiného klíče zůstala')
  ok(server.rulers[0] === 'moje měření', 'moje změna se uložila')
  ok(dirty.take('s').size === 0, 'po zápisu nic nečeká')
}

console.log('\n── klíč změněný během zápisu se nezapomene ──')
{
  const restore = quiet()
  const dirty = createDirtyKeys()
  const sent = []
  let attempts = 0
  const q = createSaveQueue({
    debounceMs: 10, label: 'test', retryMs: [30],
    send: async (k, state) => {
      const snap = dirty.take(k)
      attempts++
      await sleep(20)
      if (attempts === 1) throw new Error('síť spadla')
      sent.push(pickPatch(state, snap.keys()))
      dirty.done(k, snap)
    },
  })
  dirty.mark('s', ['camera']); q.save('s', { camera: 1 })
  await sleep(15)                           // první zápis běží (a selže)
  dirty.mark('s', ['base']); q.save('s', { camera: 1, base: 'orto' })
  await sleep(150)
  restore()
  const last = sent[sent.length - 1] ?? {}
  ok(last.camera === 1 && last.base === 'orto', `po chybě odešly oba klíče (${JSON.stringify(sent)})`)
  ok(dirty.take('s').size === 0, 'a pak už nic nečeká')

  // během úspěšného zápisu se klíč změní znovu → musí odejít i druhá hodnota
  const d2 = createDirtyKeys()
  const got = []
  const q2 = createSaveQueue({
    debounceMs: 5, label: 'test',
    send: async (k, state) => { const snap = d2.take(k); await sleep(20); got.push(pickPatch(state, snap.keys())); d2.done(k, snap) },
  })
  d2.mark('s', ['rulers']); q2.save('s', { rulers: 1 })
  await sleep(12)
  d2.mark('s', ['rulers']); q2.save('s', { rulers: 2 })
  await sleep(100)
  ok(got.length === 2 && got[1].rulers === 2, `druhá změna téhož klíče odešla zvlášť (${JSON.stringify(got)})`)
  ok(d2.take('s').size === 0, 'nic nezůstalo viset')
}

console.log('\n── chybějící hodnota jde jako null ──')
{
  const p = pickPatch({ a: 1 }, ['a', 'camera'])
  ok(p.a === 1 && p.camera === null && JSON.stringify(p) === '{"a":1,"camera":null}', 'smazaný klíč se na serveru přepíše')
}

console.log(fails ? `\n${fails} SELHÁNÍ` : '\nVŠE PROŠLO')
process.exit(fails ? 1 : 0)
