/**
 * Odložené ukládání po klíčích — sdílené pro stav scény i nastavení souborů.
 *
 * Hlídá tři věci, které by si jinak musel ohlídat každý volající zvlášť:
 *  - rychlé změny za sebou se slijí do jednoho zápisu s NEJNOVĚJŠÍ hodnotou (debounce),
 *  - zápisy téhož klíče jdou PO JEDNOM — pomalý starší request by jinak mohl doběhnout až po
 *    novějším a přepsat ho starou hodnotou,
 *  - neúspěšný zápis se zkusí znovu sám, s odstupem. Dřív čekal na další změnu, takže kdo se
 *    po výpadku sítě už ničeho nedotkl, o rozdělanou práci přišel.
 */

/** Odstupy opakování po chybě; poslední se pak drží, dokud zápis neprojde. */
const RETRY_MS = [3_000, 10_000, 30_000]

export type SaveQueue<T> = {
  /** Naplánuje uložení (rychlé změny za sebou se sloučí). */
  save: (key: string, value: T) => void
  /** Dopíše hned, co čeká — jeden klíč, nebo bez argumentu všechny. */
  flush: (key?: string) => Promise<void>
  /** Zahodí naplánované uložení (záznam se maže, není kam psát). */
  cancel: (key: string) => void
  /** Čeká něco na zápis nebo se zrovna zapisuje? */
  hasPending: (key?: string) => boolean
}

export function createSaveQueue<T>(opts: {
  debounceMs: number
  /** do konzole při chybě, ať je poznat, co se neuložilo */
  label: string
  send: (key: string, value: T) => Promise<void>
  /** odstupy opakování po chybě (ms); jinak `RETRY_MS` — vlastní hodnoty jsou hlavně pro test */
  retryMs?: number[]
}): SaveQueue<T> {
  const retry = opts.retryMs?.length ? opts.retryMs : RETRY_MS
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, T>()
  const running = new Map<string, Promise<void>>()
  const failures = new Map<string, number>()

  function arm(key: string, ms: number) {
    const t = timers.get(key)
    if (t) clearTimeout(t)
    timers.set(key, setTimeout(() => { timers.delete(key); void push(key) }, ms))
  }

  function disarm(key: string) {
    const t = timers.get(key)
    if (t) { clearTimeout(t); timers.delete(key) }
  }

  /** Pošle poslední známou hodnotu. Nikdy nehází — chyba se jen naplánuje znovu. */
  async function sendLatest(key: string): Promise<void> {
    if (!pending.has(key)) return
    const value = pending.get(key) as T
    pending.delete(key)
    try {
      await opts.send(key, value)
      failures.delete(key)
    } catch (e) {
      // Novější změna, která mezitím přišla, má přednost — starou hodnotu nevracet.
      if (!pending.has(key)) pending.set(key, value)
      const n = (failures.get(key) ?? 0) + 1
      failures.set(key, n)
      console.error(`${opts.label} selhalo (pokus ${n}), zkusím to znovu:`, e)
      if (!timers.has(key)) arm(key, retry[Math.min(n, retry.length) - 1])
    }
  }

  /** Zařadí zápis ZA ten, který pro stejný klíč právě běží. */
  function push(key: string): Promise<void> {
    const p = (running.get(key) ?? Promise.resolve()).then(() => sendLatest(key))
    running.set(key, p)
    void p.finally(() => { if (running.get(key) === p) running.delete(key) })
    return p
  }

  return {
    save(key, value) {
      pending.set(key, value)
      arm(key, opts.debounceMs)
    },
    async flush(key) {
      const keys = key ? [key] : [...new Set([...pending.keys(), ...running.keys()])]
      for (const k of keys) disarm(k)
      await Promise.all(keys.map(push))
    },
    cancel(key) {
      disarm(key)
      pending.delete(key)
      failures.delete(key)
    },
    hasPending(key) {
      if (key) return pending.has(key) || running.has(key)
      return pending.size > 0 || running.size > 0
    },
  }
}
