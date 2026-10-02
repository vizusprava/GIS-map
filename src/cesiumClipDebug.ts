/**
 * Diagnostika pádu vykreslování „Cannot read properties of undefined (reading '_target')".
 *
 * Ta hláška znamená, že shaderu došla textura pro nějaký sampler. Nejpodezřelejší je ořez
 * modelu: Cesium si v uniformu drží `clippingPlanes.texture` BEZ pojistky (globus na stejném
 * místě spadne zpátky na `defaultTexture`, model ne).
 *
 * Prototyp Cesia se ZÁMĚRNĚ nepatchuje — `texture` je nekonfigurovatelná property a pokus
 * o její předefinování shodí celou komponentu. Jen se před každým snímkem kouká, jestli
 * některá naše kolekce není zapnutá bez textury; to je přesně stav, na kterém by draw spadl.
 */
import type * as Cesium from 'cesium'

type Coll = Cesium.ClippingPlaneCollection

/**
 * Hlídá kolekce ořezu před každým snímkem. Vrací funkci na odhlášení.
 * Mimo vývoj nedělá nic.
 */
export function watchClipCollections(scene: Cesium.Scene, colls: () => Iterable<Coll>): () => void {
  if (!import.meta.env.DEV) return () => {}
  let warned = 0
  console.info('[clip-debug] hlídám ořezové roviny modelu')
  return scene.preRender.addEventListener(() => {
    if (warned > 8) return
    for (const c of colls()) {
      if (!c.enabled || c.length === 0) continue
      // `texture` v .d.ts není, za běhu existuje
      const tex = (c as unknown as { texture?: unknown }).texture
      if (tex) continue
      warned++
      console.warn('[clip-debug] ořez je ZAPNUTÝ, ale textura rovin chybí — tohle draw neustojí', {
        rovin: c.length,
        vlastník: (c as unknown as { _owner?: { constructor?: { name?: string } } })._owner?.constructor?.name ?? 'žádný',
      })
    }
  })
}
