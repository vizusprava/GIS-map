/**
 * Které klíče stavu scény se změnily a ještě nejsou na serveru.
 *
 * Sdílenou scénu můžou mít otevřenou dva lidi naráz. Kdyby každý posílal celý stav, poslední
 * zápis by smazal, co mezitím uložil ten druhý (on přidá pohled kamery, já změřím vzdálenost
 * a můj zápis jeho pohled zahodí, protože ho ve svém stavu nemám). Posílají se proto jen
 * změněné klíče a databáze je vmíchá do uloženého stavu (`patch_scene_state`).
 *
 * Klíč se smí zapomenout až po ÚSPĚŠNÉM zápisu, a jen když se mezitím nezměnil znovu: každá
 * změna dostane pořadové číslo a `done` maže jen klíče, jejichž číslo se od `take` nepohnulo.
 */
export type DirtyKeys = {
  /** Poznamenej změněné klíče. */
  mark: (scope: string, keys: string[]) => void
  /** Snímek změněných klíčů pro jeden zápis. */
  take: (scope: string) => Map<string, number>
  /** Zápis snímku prošel — zapomeň klíče, které se od té doby znovu nezměnily. */
  done: (scope: string, snap: Map<string, number>) => void
}

export function createDirtyKeys(): DirtyKeys {
  const scopes = new Map<string, Map<string, number>>()
  let gen = 0
  return {
    mark(scope, keys) {
      let m = scopes.get(scope)
      if (!m) scopes.set(scope, (m = new Map()))
      for (const k of keys) m.set(k, ++gen)
    },
    take(scope) {
      return new Map(scopes.get(scope) ?? [])
    },
    done(scope, snap) {
      const m = scopes.get(scope)
      if (!m) return
      for (const [k, g] of snap) if (m.get(k) === g) m.delete(k)
      if (!m.size) scopes.delete(scope)
    },
  }
}

/**
 * Výřez stavu pro zápis. Chybějící hodnota jde jako `null` — jinak by ji JSON vynechal a na
 * serveru by zůstala stará (třeba smazaná poloha kamery).
 */
export function pickPatch(state: object, keys: Iterable<string>): Record<string, unknown> {
  const s = state as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = s[k] ?? null
  return out
}
