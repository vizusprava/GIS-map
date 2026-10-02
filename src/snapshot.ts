/**
 * Snímky plátna mapy — náhledy uložených pohledů a náhled scény do přehledu.
 */
import * as Cesium from 'cesium'

/**
 * Vykreslí snímek HNED a v témže kroku z něj vezme obraz.
 *
 * Mapa jede bez `preserveDrawingBuffer`, takže je obraz v bufferu jen do konce aktuálního
 * kroku, a kreslí se na vyžádání — samotné `render()` by bez `requestRender()` nic nenakreslilo.
 * `toBlob` / `drawImage` si obraz přečtou synchronně, proto musí jít hned za tímhle.
 */
export function renderNow(v: Cesium.Viewer) {
  v.scene.requestRender()
  v.render()
}

/**
 * Náhled scény do přehledu: zmenšený JPEG aktuálního záběru (nejvýš `maxW` px na šířku).
 *
 * Plátno mapy se přečte synchronně hned po vykreslení do malého 2D plátna; kódování JPEGu pak
 * už na buffer WebGL nečeká. Dřív se nahrával PNG v plném rozlišení (pár MB) — nahrávání pak
 * nestihlo doběhnout, než se načetl přehled, a nová scéna v něm zůstala bez náhledu.
 */
export function captureThumb(v: Cesium.Viewer, maxW = 960): Promise<Blob | null> {
  renderNow(v)
  const src = v.scene.canvas
  const k = Math.min(1, maxW / Math.max(1, src.width))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(src.width * k))
  c.height = Math.max(1, Math.round(src.height * k))
  const g = c.getContext('2d')
  if (!g) return Promise.resolve(null)
  g.drawImage(src, 0, 0, c.width, c.height)
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.82))
}
