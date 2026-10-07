/**
 * Vzhled modelu: s texturami (jak přišel), celý šedý (hmotový model), nebo každý objekt
 * vlastní barvou (rozliší se, co je co). Přepíná se okamžitě, bez nového načítání modelu.
 *
 * - šedý: barva modelu v režimu REPLACE — Cesium jen nahradí barvu povrchu, stínování zůstane;
 * - barvy objektů: malý shader, který z materiálu přečte značku objektu (gltfMaterials.ts,
 *   `tagObjects`) a obarví pixel barvou objektu. Barva je ze zlatého řezu na kruhu odstínů —
 *   sousední objekty mají výrazně odlišné barvy a tentýž objekt má vždycky stejnou.
 */
import * as Cesium from 'cesium'
import { OBJECT_TAG_SCALE } from './gltfMaterials'

export type ModelLook = 'textury' | 'seda' | 'barvy'
export const MODEL_LOOKS: { id: ModelLook; label: string; title: string }[] = [
  { id: 'textury', label: 'Textury', title: 'Jak model přišel — s barevnými texturami' },
  { id: 'seda', label: 'Šedý', title: 'Celý model šedý (hmotový model)' },
  { id: 'barvy', label: 'Barvy objektů', title: 'Každý objekt vlastní barvou — v seznamu objektů je stejná' },
]

const GOLDEN = 0.618033988749895
const GREY = Cesium.Color.fromBytes(190, 190, 190, 255)

/** Barva objektu podle jeho id — stejný vzorec jako v shaderu (CSS pro seznam v panelu). */
export function objectColor(id: number): string {
  const h = (id * GOLDEN) % 1
  const k = [0, 4, 2].map(o => Math.min(1, Math.max(0, Math.abs(((h * 6 + o) % 6) - 3) - 1)))
  const rgb = k.map(c => Math.round((1 + (c - 1) * 0.6) * 0.9 * 255))
  return `rgb(${rgb.join(',')})`
}

function colorsShader() {
  return new Cesium.CustomShader({
    fragmentShaderText: `
      vec3 geoObjectHue(float h) {
        vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        return mix(vec3(1.0), k, 0.6) * 0.9;
      }
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        float id = floor(material.emissive.r * ${OBJECT_TAG_SCALE.toFixed(1)} + 0.5);
        material.emissive = vec3(0.0);
        // stejné jako objectColor(): sRGB barva → lineární (Cesium na konci převádí zpátky)
        material.diffuse = czm_srgbToLinear(geoObjectHue(fract(id * ${GOLDEN})));
      }
    `,
  })
}

/** Nastaví modelu vzhled (z textur, šedý, barvy objektů). */
export function applyModelLook(model: Cesium.Model, look: ModelLook) {
  // bez shaderu = undefined (typy Cesia to nepřipouštějí, Model ho tak ale odebere)
  model.customShader = (look === 'barvy' ? colorsShader() : undefined) as Cesium.CustomShader
  if (look === 'seda') {
    model.color = GREY
    model.colorBlendMode = Cesium.ColorBlendMode.REPLACE
  } else {
    // bez barvy modelu (Cesium pak tenhle krok do shaderu vůbec nepřidá)
    model.color = undefined as unknown as Cesium.Color
    model.colorBlendMode = Cesium.ColorBlendMode.HIGHLIGHT
  }
}
