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

console.log(fails ? `\n${fails} SELHÁNÍ` : '\nVŠE PROŠLO')
process.exit(fails ? 1 : 0)
