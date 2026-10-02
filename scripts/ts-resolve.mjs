/**
 * Doplní `.ts` k relativním importům, aby testy mohly sáhnout přímo do zdrojáků.
 *
 * Vite si příponu domyslí sám, Node ne — a nutit kvůli testům do celého `src/` importy
 * s příponou by bylo horší než těchhle pár řádků. Node 24 čte TypeScript sám, takže víc
 * než přeložit název souboru není potřeba.
 *
 * Použití: `node --import ./scripts/ts-resolve.mjs <soubor>`
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier) && context.parentURL) {
      const candidate = specifier + '.ts'
      try {
        if (existsSync(fileURLToPath(new URL(candidate, context.parentURL)))) {
          return nextResolve(candidate, context)
        }
      } catch { /* nedá-li se cesta složit, ať to řeší Node po svém */ }
    }
    return nextResolve(specifier, context)
  },
})
