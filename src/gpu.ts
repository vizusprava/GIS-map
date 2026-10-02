/**
 * Rozpoznání grafiky z řetězce, který o ní hlásí WebGL (`UNMASKED_RENDERER_WEBGL`).
 *
 * Samostatně a bez závislostí, ať jde otestovat na skutečných řetězcích (scripts/test-perf.mjs) —
 * podle tohohle se rozhoduje, jestli „auto" vybere úsporný profil (perfProfile.ts).
 */

/**
 * Integrovaná a softwarová grafika. AMD „Radeon(TM) Graphics" a Vega jsou grafiky v procesoru
 * (Ryzen APU), ne samostatné karty; Intel kromě řady Arc taky.
 */
const WEAK_GPU = /intel|radeon\(tm\) graphics|radeon vega|vega \d|mali|adreno|powervr|videocore|vivante|swiftshader|llvmpipe|software|basic render/i
/** Intel Arc je samostatná karta, ne integrovaná grafika. */
const STRONG_GPU = /intel.*\barc\b/i

/**
 * `name` = zkrácené jméno pro panel, `weak` = integrovaná nebo softwarová grafika.
 *
 * Chrome balí jméno do „ANGLE (výrobce, KARTA (0x…) Direct3D11 vs_5_0 ps_5_0, ovladač)". Pro panel
 * stačí ta karta — ale rozhoduje se podle CELÉHO řetězce: softwarový SwiftShader se třeba hlásí
 * jako „Vulkan 1.3.0 (SwiftShader Device…)" a podstatné slovo je až uvnitř.
 */
export function parseGpu(raw: string): { name: string; weak: boolean } {
  const inner = raw.startsWith('ANGLE (') ? raw.slice(7, raw.lastIndexOf(')')) : raw
  const parts = inner.split(', ')
  const name = (parts.length >= 3 ? parts.slice(1, -1).join(', ') : inner)
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+Direct3D.*$/i, '')
    .trim()
  return { name: name || raw, weak: WEAK_GPU.test(raw) && !STRONG_GPU.test(raw) }
}
