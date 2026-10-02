/**
 * Líné načtení části appky (mapa) s pojistkou na nové nasazení.
 *
 * Po deployi na Pages zmizí staré chunky. Kdo má appku otevřenou ze včerejška, má v paměti
 * starý index se starými jmény souborů — import pak skončí 404 a místo scény by zbyla bílá
 * obrazovka. Jediná rozumná oprava je načíst stránku znovu; příznak v sessionStorage hlídá,
 * aby se to při skutečné chybě (offline, rozbitý build) netočilo dokola.
 */
const FLAG = 'geo.chunk-reload'

export function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  return load().then(
    m => {
      try { sessionStorage.removeItem(FLAG) } catch { /* privátní režim */ }
      return m
    },
    (e: unknown) => {
      let reloaded = false
      try { reloaded = !!sessionStorage.getItem(FLAG) } catch { /* privátní režim */ }
      if (reloaded) throw e
      try { sessionStorage.setItem(FLAG, '1') } catch { /* privátní režim */ }
      window.location.reload()
      return new Promise<T>(() => {}) // stránka se právě načítá znovu
    },
  )
}
