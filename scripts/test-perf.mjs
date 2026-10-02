/**
 * Kontrola rozpoznání grafiky (`src/gpu.ts`).
 *
 * Podle toho „auto" vybírá úsporný nebo kvalitní profil. Chyba se v appce neprojeví hláškou —
 * jen tím, že slabý notebook dostane plnou kvalitu a sotva se hýbe, nebo silná karta zbytečně
 * kreslí rozmazaně. Řetězce níž jsou skutečné výstupy WebGL z Chrome na Windows.
 *
 * Spustit: `npm run test:perf`
 */
import { parseGpu } from '../src/gpu.ts'

let fails = 0
const ok = (cond, what) => {
  if (!cond) fails++
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${what}`)
}

const cases = [
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Intel(R) UHD Graphics 620', true],
  ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Intel(R) Iris(R) Xe Graphics', true],
  ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Intel(R) Arc(TM) A770 Graphics', false],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'NVIDIA GeForce RTX 3060', false],
  ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'AMD Radeon(TM) Graphics', true],
  ['ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'AMD Radeon RX 6700 XT', false],
  ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', null, true],
  ['ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Microsoft Basic Render Driver', true],
  ['Apple GPU', 'Apple GPU', false],
  ['Mali-G78', 'Mali-G78', true],
]

console.log('\n── slabá × silná grafika a jméno do panelu ──')
for (const [raw, name, weak] of cases) {
  const g = parseGpu(raw)
  ok(g.weak === weak, `${weak ? 'slabá' : 'silná'}: ${raw.slice(0, 70)}${raw.length > 70 ? '…' : ''} (vyšlo ${g.weak ? 'slabá' : 'silná'})`)
  if (name) ok(g.name === name, `jméno „${g.name}" (čekáno „${name}")`)
  else ok(g.name.length > 0 && !g.name.includes('0x'), `jméno bez interních id („${g.name}")`)
}

console.log(fails ? `\n${fails} SELHÁNÍ` : '\nVŠE PROŠLO')
process.exit(fails ? 1 : 0)
