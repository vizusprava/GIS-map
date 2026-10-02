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
