/**
 * Kontrola geometrie řezu (`src/viewer-core/sectionCut.ts`) na tvarech, u kterých se rozměry
 * dají spočítat na papíře — kvádr, koule, dutina, šikmá rovina, otevřená plocha.
 *
 * Spustit: `npm run test:section` (Node 24 čte .ts přímo, žádný build není potřeba).
 */
import * as THREE from 'three'
import { sliceObject, sliceSlab, buildSectionDxf, polySegments, polysFromSegments, filterResult, planeBasis } from '../src/viewer-core/sectionCut.ts'
import { sectionSheet, sheetInfo, penScreen, PENS, SCALES } from '../src/viewer-core/sectionSheet.ts'
import { meshEdges, isSilhouette, viewDirLocal, mergeSegments } from '../src/viewer-core/meshEdges.ts'
import { meshBvh, trianglesNearPlane, planeToLocal } from '../src/viewer-core/triBvh.ts'
import { placeLabels } from '../src/viewer-core/labels.ts'
import { edgeRuns, clipToBox, isOccluded, projectSlabEdges } from '../src/viewer-core/sectionView.ts'

let fails = 0
const near = (a, b, tol, what) => {
  const ok = Math.abs(a - b) <= tol
  if (!ok) fails++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}: ${a.toFixed(4)} (čekáno ${b.toFixed(4)} ±${tol})`)
}
const eq = (a, b, what) => {
  const ok = a === b
  if (!ok) fails++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${what}: ${a} (čekáno ${b})`)
}

function meshOf(geo, pos = [0, 0, 0]) {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
  m.position.set(...pos)
  return m
}

// ── kvádr 2 × 4 × 6, svislý řez rovinou x = 0 ───────────────────────────────────
{
  console.log('\n— kvádr 2×4×6, rovina x=0 —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.loops, 1, 'uzavřených obrysů')
  eq(r.opens, 0, 'otevřených čar')
  near(r.width, 6, 1e-4, 'šířka (podél Z)')
  near(r.height, 4, 1e-4, 'výška (podél Y)')
  near(r.area, 24, 1e-3, 'plocha')
  near(r.cutLength, 20, 1e-3, 'obvod')
  eq(r.uLabel, '−Z', 'popisek vodorovné osy')
  eq(r.vLabel, '+Y', 'popisek svislé osy')
}

// ── mimoosý řez posunutého kvádru — kontrola uchycení ──────────────────────────
{
  console.log('\n— kvádr posunutý na x=10, rovina x=10.5 —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6), [10, 0, 0]))
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), new THREE.Vector3(10.5, 0, 0))
  const r = sliceObject(root, plane)
  eq(r.loops, 1, 'uzavřených obrysů')
  near(r.area, 24, 1e-3, 'plocha')
  near(r.origin.x, 10.5, 1e-6, 'počátek roviny leží na x=10.5')
}

// ── díra: krychle 6 s dutinou 2 ────────────────────────────────────────────────
{
  console.log('\n— krychle 6 s vnitřní dutinou 2 —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(6, 6, 6)))
  root.add(meshOf(new THREE.BoxGeometry(2, 2, 2)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.loops, 2, 'uzavřené obrysy (vnější + dutina)')
  eq(r.polys.filter(p => p.hole).length, 1, 'z toho děr')
  near(r.area, 36 - 4, 1e-3, 'plocha po odečtení díry')
}

// ── koule — zaoblený obrys, test svařování a řetězení ──────────────────────────
{
  console.log('\n— koule r=5, vodorovný řez y=0 —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.SphereGeometry(5, 64, 48)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(0, 1, 0), 0))
  eq(r.loops, 1, 'uzavřených obrysů')
  near(r.width, 10, 0.05, 'průměr ve směru u')
  near(r.height, 10, 0.05, 'průměr ve směru v')
  near(r.area, Math.PI * 25, 0.4, 'plocha kruhu')
  near(r.cutLength, 2 * Math.PI * 5, 0.2, 'obvod kruhu')
  eq(r.uLabel, '+X', 'půdorys: vodorovně +X')
  eq(r.vLabel, '−Z', 'půdorys: svisle na sever')
}

// ── otevřená plocha (terén) — řez dá čáru, ne smyčku ───────────────────────────
{
  console.log('\n— rovinná deska 20×20 bez tloušťky, svislý řez —')
  const root = new THREE.Group()
  const geo = new THREE.PlaneGeometry(20, 20, 8, 8)
  geo.rotateX(-Math.PI / 2)
  root.add(meshOf(geo))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.loops, 0, 'uzavřených obrysů')
  eq(r.opens, 1, 'otevřených čar')
  near(r.cutLength, 20, 1e-3, 'délka čáry přes desku')
  near(r.height, 0, 1e-6, 'výška (deska je vodorovná)')
}

// ── šikmá rovina ───────────────────────────────────────────────────────────────
{
  console.log('\n— krychle 10, rovina otočená o 45° kolem Y —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(10, 10, 10)))
  const n = new THREE.Vector3(1, 0, 1).normalize()
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(0, 0, 0))
  const r = sliceObject(root, plane)
  eq(r.loops, 1, 'uzavřených obrysů')
  near(r.width, 10 * Math.SQRT2, 1e-3, 'šířka = úhlopříčka podstavy')
  near(r.height, 10, 1e-3, 'výška')
  near(r.area, 100 * Math.SQRT2, 1e-2, 'plocha šikmého řezu')
}

// ── skrytý objekt se do řezu nepočítá ──────────────────────────────────────────
{
  console.log('\n— skrytý objekt —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6)))
  const hidden = meshOf(new THREE.BoxGeometry(2, 4, 6), [0, 20, 0])
  hidden.visible = false
  root.add(hidden)
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.loops, 1, 'jen viditelný kvádr')
  near(r.area, 24, 1e-3, 'plocha')
}

// ── rovina mimo model ──────────────────────────────────────────────────────────
{
  console.log('\n— rovina mimo model —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 2, 2)))
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(1, 0, 0), new THREE.Vector3(50, 0, 0))
  const r = sliceObject(root, plane)
  eq(r.polys.length, 0, 'žádný obrys')
  near(r.width, 0, 1e-9, 'nulová šířka')
}

// ── DXF ────────────────────────────────────────────────────────────────────────
{
  console.log('\n— DXF —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6)))
  const dxf = buildSectionDxf(sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)))
  eq(dxf.startsWith('0\nSECTION'), true, 'hlavička')
  eq(dxf.trimEnd().endsWith('EOF'), true, 'ukončení')
  eq(dxf.includes('RIZ'), true, 'hladina RIZ')
  eq((dxf.match(/POLYLINE/g) || []).length, 1, 'jedna polylinie')
  eq((dxf.match(/VERTEX/g) || []).length, 4, 'čtyři vrcholy obdélníku')
}

// ── osa „nahoru" = +Z (soustava mapy), svislá rovina ───────────────────────────
{
  console.log('\n— krychle 10, nahoru je +Z (ENU jako v mapě), rovina x=0 —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(10, 10, 10)))
  const up = new THREE.Vector3(0, 0, 1)
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), { up })
  eq(r.uLabel, '+Y', 'vodorovná osa výkresu')
  eq(r.vLabel, '+Z', 'svislá osa výkresu je skutečně nahoru')
  near(r.width, 10, 1e-4, 'šířka')
  near(r.height, 10, 1e-4, 'výška')
  near(r.area, 100, 1e-3, 'plocha')
}

// ── vodorovný řez při +Z nahoru → půdorys východ/sever ─────────────────────────
{
  console.log('\n— krychle 10, nahoru +Z, vodorovná rovina z=0 —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(10, 10, 10)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), { up: new THREE.Vector3(0, 0, 1) })
  eq(r.uLabel, '+X', 'půdorys: vodorovně východ')
  eq(r.vLabel, '+Y', 'půdorys: svisle sever')
  near(r.area, 100, 1e-3, 'plocha')
}

// ── omezení rozsahu řezu ───────────────────────────────────────────────────────
{
  console.log('\n— krychle 10, rozsah omezený na 4 m délky a 6 m výšky —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(10, 10, 10)))
  const up = new THREE.Vector3(0, 0, 1)
  const center = new THREE.Vector3(0, 0, 0)
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)

  const onlyU = sliceObject(root, plane, { up, clip: { center, halfU: 2 } })
  near(onlyU.width, 4, 1e-3, 'šířka po omezení délky')
  near(onlyU.height, 10, 1e-3, 'výška zůstává celá')

  const both = sliceObject(root, plane, { up, clip: { center, halfU: 2, halfV: 3 } })
  near(both.width, 4, 1e-3, 'šířka')
  near(both.height, 6, 1e-3, 'výška')
  near(both.area, 24, 1e-3, 'plocha oříznutého okna')

  const off = sliceObject(root, plane, { up, clip: { center: new THREE.Vector3(0, 40, 0), halfU: 2 } })
  eq(off.polys.length, 0, 'okno mimo model nedá nic')
}

// ── tloušťka řezu: chytí i to, co rovina mine ──────────────────────────────────
{
  console.log('\n— tenká rovina mine sloupek, tlustý řez ho chytí —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(10, 10, 10)))            // hlavní těleso přes rovinu x=0
  root.add(meshOf(new THREE.BoxGeometry(0.4, 2, 2), [1.2, 0, 8])) // „zábradlí" 1,2 m vedle roviny
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)

  const thin = sliceObject(root, plane)
  eq(thin.polys.filter(p => p.depth !== 0).length, 0, 'tenký řez nemá kontext')
  eq(thin.loops, 1, 'tenký řez vidí jen hlavní těleso')

  const thick = sliceSlab(root, 3, plane)
  eq(thick.loops, 1, 'vlastní řez zůstal jeden obrys')
  near(thick.area, 100, 1e-3, 'plocha se z kontextu nepočítá')
  near(thick.cutLength, 40, 1e-3, 'délka čar se z kontextu nepočítá')
  eq(thick.polys.filter(p => p.depth !== 0).length > 0, true, 'kontext zachytil sloupek')
  eq(thick.width > thin.width, true, 'obálka výkresu se roztáhla přes sloupek')
}

{
  console.log('\n— nulová tloušťka se chová jako obyčejný řez —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6)))
  const a = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  const b = sliceSlab(root, 0, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(b.polys.length, a.polys.length, 'stejný počet obrysů')
  near(b.area, a.area, 1e-9, 'stejná plocha')
  near(b.width, a.width, 1e-9, 'stejná šířka')
}

// ── rozlišení podle materiálu a objektu ────────────────────────────────────────
{
  console.log('\n— dva kvádry, každý s jiným materiálem —')
  const root = new THREE.Group()
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 4), new THREE.MeshBasicMaterial({ name: 'beton' }))
  a.name = 'opera'
  a.position.set(0, 0, -4)
  const b = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 4), new THREE.MeshBasicMaterial({ name: 'asfalt' }))
  b.name = 'vozovka'
  b.position.set(0, 0, 4)
  root.add(a, b)

  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.loops, 2, 'dva samostatné obrysy')
  const mats = [...new Set(r.polys.map(p => p.group))].sort()
  const objs = [...new Set(r.polys.map(p => p.object))].sort()
  eq(mats.join(','), 'asfalt,beton', 'obrysy nesou jméno materiálu')
  eq(objs.join(','), 'opera,vozovka', 'obrysy nesou jméno objektu')
  const beton = r.polys.find(p => p.group === 'beton')
  near(beton.width, 4, 1e-3, 'šířka obrysu z betonu')
  near(beton.height, 4, 1e-3, 'výška obrysu z betonu')
  eq(buildSectionDxf(r).includes('RIZ_BETON'), true, 'DXF má hladinu podle materiálu')
}

{
  console.log('\n— mesh bez jména materiálu spadne na jméno objektu —')
  const root = new THREE.Group()
  const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  m.name = 'sloup'
  root.add(m)
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.polys[0].group, 'sloup', 'skupina podle objektu')
  eq(r.polys[0].object, 'sloup', 'jméno objektu')
}

// ── délky a sklony úseků ───────────────────────────────────────────────────────
{
  console.log('\n— úseky obrysu: délka a sklon —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  const segs = polySegments(r.polys[0])
  eq(segs.length, 4, 'obdélník má čtyři úseky')
  const angs = segs.map(s => Math.abs(Math.round(s.angle))).sort((x, y) => x - y)
  eq(angs.join(','), '0,0,90,90', 'dva vodorovné a dva svislé úseky')
  const lens = segs.map(s => Math.round(s.length)).sort((x, y) => x - y)
  eq(lens.join(','), '4,4,6,6', 'délky stran')
}

{
  console.log('\n— šikmý úsek má správný sklon —')
  // Trojúhelník PŘES rovinu x=0; průsečík je úsečka z (u,v)=(0,0) do (1; 0,5),
  // tedy svah 1:2 → 26,565°. (Kdyby ležel v rovině, řez by nevznikl vůbec.)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, 0, 0, 1, 1, -2, 1, 0, 0,
  ]), 3))
  const root = new THREE.Group()
  root.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ name: 'svah' })))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.polys.length > 0, true, 'řez svah potkal')
  eq(r.polys[0].group, 'svah', 'úsek nese jméno materiálu')
  const steep = polySegments(r.polys[0]).sort((a, b) => b.length - a.length)[0]
  near(Math.abs(steep.angle), 26.565, 0.2, 'sklon 1:2 je 26,6°')
  near(steep.length, Math.hypot(1, 0.5), 1e-3, 'délka šikmého úseku')
}

// ── přibrání objektů z okolí (sloupky zábradlí mezi řezy) ──────────────────────
{
  console.log('\n— sloupek 0,8 m vedle roviny —')
  const root = new THREE.Group()
  const deska = new THREE.Mesh(new THREE.BoxGeometry(10, 1, 6), new THREE.MeshBasicMaterial({ name: 'mostovka' }))
  root.add(deska)
  // sloupek zábradlí: rovinu x=0 vůbec nepotká, střed má na x = 0,8
  const sloupek = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), new THREE.MeshBasicMaterial({ name: 'zabradli' }))
  sloupek.position.set(0.8, 1, 2)
  root.add(sloupek)
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)

  const bez = sliceObject(root, plane)
  eq(bez.nearbyCount, 0, 'bez přibrání se sloupek nechytí')
  eq(bez.polys.some(p => p.group === 'zabradli'), false, 'zábradlí ve výkrese není')
  near(bez.area, 6, 1e-3, 'plocha jen mostovky')

  const s = sliceObject(root, plane, { nearby: { radius: 1 } })
  eq(s.nearbyCount, 1, 'sloupek přibrán')
  eq(s.polys.some(p => p.group === 'zabradli' && p.nearby), true, 'zábradlí je ve výkrese a je označené jako z okolí')
  near(s.area, 6, 1e-3, 'plocha hlavního řezu zůstala bez sloupku')
  near(s.cutLength, bez.cutLength, 1e-6, 'délka čar hlavního řezu se nezměnila')
  eq(s.loops, bez.loops, 'počet obrysů hlavního řezu se nezměnil')
  const post = s.polys.find(p => p.group === 'zabradli')
  near(post.width, 0.2, 1e-3, 'sloupek je 0,2 m široký — tedy skutečný průřez, ne odřený kraj')
  near(post.height, 1, 1e-3, 'a 1 m vysoký')
  eq(buildSectionDxf(s).includes('RIZ_ZABRADLI_OKOLI'), true, 'okolí má vlastní hladinu v DXF')
}

{
  console.log('\n— dlouhý objekt se středem daleko, ale okrajem blízko —')
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(10, 1, 6), new THREE.MeshBasicMaterial({ name: 'mostovka' })))
  // svodidlo 40 m dlouhé: střed má 21 m od roviny x=0, ale sahá k ní na 1 m
  const svodidlo = new THREE.Mesh(new THREE.BoxGeometry(40, 0.5, 0.3), new THREE.MeshBasicMaterial({ name: 'svodidlo' }))
  svodidlo.position.set(21, 1, 2)
  root.add(svodidlo)
  const s = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), { nearby: { radius: 2 } })
  eq(s.nearbyCount, 1, 'rozhoduje mezera k okraji, ne vzdálenost středu')
  const p = s.polys.find(x => x.group === 'svodidlo')
  near(p.height, 0.5, 1e-3, 'a je to skutečný průřez svodidla')
}

{
  console.log('\n— objekt za hranicí okolí se nepřibere —')
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(10, 1, 6), new THREE.MeshBasicMaterial({ name: 'mostovka' })))
  const daleko = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), new THREE.MeshBasicMaterial({ name: 'zabradli' }))
  daleko.position.set(3, 1, 2)
  root.add(daleko)
  const s = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), { nearby: { radius: 1 } })
  eq(s.nearbyCount, 0, 'tři metry daleko už ne')
}

// ── tenkostěnný profil ve velkém modelu (svodidlo na dlouhém mostě) ────────────
{
  console.log('\n— 2mm plech uvnitř 200m modelu —')
  const root = new THREE.Group()
  // plech 2 m dlouhý, 2 mm silný — profil svodidla nebo zábradlí
  root.add(meshOf(new THREE.BoxGeometry(4, 2, 0.002)))
  // vzdálený drobek, aby úhlopříčka modelu byla ~200 m jako u skutečného mostu
  root.add(meshOf(new THREE.BoxGeometry(0.5, 0.5, 0.5), [100, 0, 0]))

  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.loops, 1, 'plech dal jeden uzavřený obrys')
  const p = r.polys.find(x => x.closed)
  eq(p.pts.length, 5, 'obdélník má čtyři rohy (pátý bod uzavírá)')
  near(p.width, 0.002, 1e-5, 'tloušťka plechu zůstala')
  near(p.height, 2, 1e-4, 'výška plechu')
  near(r.area, 2 * 0.002, 1e-6, 'plocha průřezu = výška × tloušťka')
}

{
  console.log('\n— hrubé zjednodušení tenký profil rozsype (proto se nepoužívá) —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(4, 2, 0.002)))
  const hrube = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), { simplifyTol: 0.01 })
  eq(hrube.area < 2 * 0.002 * 0.75, true, 'při toleranci 1 cm se plocha propadne — přesně to se dělo')
}

// ── instancované objekty (sloupky zábradlí jednou geometrií a maticemi) ────────
{
  console.log('\n— InstancedMesh: pět sloupků po 5 m —')
  const root = new THREE.Group()
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.2, 1, 0.2),
    new THREE.MeshBasicMaterial({ name: 'zabradli' }),
    5,
  )
  const m = new THREE.Matrix4()
  for (let i = 0; i < 5; i++) {
    m.makeTranslation(i * 5 - 10, 0, 0)     // sloupky na x = −10, −5, 0, 5, 10
    inst.setMatrixAt(i, m)
  }
  inst.instanceMatrix.needsUpdate = true
  root.add(inst)

  // rovina x=0 prochází prostředním sloupkem
  const stred = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(stred.loops, 1, 'prostřední instance se řízla')
  near(stred.area, 1 * 0.2, 1e-3, 'průřez sloupku 0,2 × 1 m')

  // rovina x=2,5 je mezi sloupky — bez okolí nic, s okolím se přiberou sousedi
  const mezi = sliceObject(root, new THREE.Plane().setFromNormalAndCoplanarPoint(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(2.5, 0, 0)))
  eq(mezi.polys.length, 0, 'mezi sloupky rovina nic nepotká')

  const sOkolim = sliceObject(root, new THREE.Plane().setFromNormalAndCoplanarPoint(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(2.5, 0, 0)), { nearby: { radius: 3 } })
  eq(sOkolim.nearbyCount, 2, 'oba sousední sloupky se přibraly — instance se berou po jedné')
}

// ── hlášení chybějících objektů ────────────────────────────────────────────────
{
  console.log('\n— seznam nevykreslených objektů —')
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(10, 1, 6), new THREE.MeshBasicMaterial({ name: 'mostovka' })))
  const blizko = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), new THREE.MeshBasicMaterial({ name: 'zabradli' }))
  blizko.name = 'sloupek_A'
  blizko.position.set(2, 1, 2)
  root.add(blizko)
  const daleko = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), new THREE.MeshBasicMaterial({ name: 'zabradli' }))
  daleko.name = 'sloupek_B'
  daleko.position.set(6, 1, 2)
  root.add(daleko)

  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), { nearby: { radius: 1 } })
  eq(r.nearbyCount, 0, 'ani jeden se nevešel do okolí 1 m')
  eq(r.missed.length, 2, 'oba jsou v seznamu chybějících')
  eq(r.missed[0].object, 'sloupek_A', 'nejbližší je první')
  near(r.missed[0].gap, 1.9, 1e-3, 'a hlásí skutečnou mezeru k rovině')
  eq(r.missed[0].reason.includes('okolí'), true, 's důvodem')

  const r2 = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), { nearby: { radius: 2 } })
  eq(r2.nearbyCount, 1, 'po zvednutí okolí na 2 m se bližší přibere')
  eq(r2.missed.some(m => m.object === 'sloupek_A'), false, 'a ze seznamu chybějících zmizí')
  eq(r2.missed.some(m => m.object === 'sloupek_B'), true, 'vzdálenější tam zůstane')
}

// ── pás mezi dvěma řezy (znaménkový rozsah okolí) ──────────────────────────────
{
  console.log('\n— pás od roviny k druhému řezu 3 m za ní —')
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(10, 1, 6), new THREE.MeshBasicMaterial({ name: 'mostovka' })))
  const mk = (name, x) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), new THREE.MeshBasicMaterial({ name: 'zabradli' }))
    m.name = name
    m.position.set(x, 1, 2)
    root.add(m)
  }
  mk('uvnitr', 1.5)      // v pásu 0…3
  mk('zaBpasem', 4.5)    // za druhým řezem
  mk('naOpacne', -1.5)   // na opačnou stranu od pásu

  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)
  const s = sliceObject(root, plane, { nearby: { from: 0, to: 3 } })
  const jmena = s.polys.filter(p => p.nearby).map(p => p.object).sort()
  eq(jmena.join(','), 'uvnitr', 'v pásu je jen sloupek mezi řezy')
  eq(s.nearbyCount, 1, 'jeden přibraný objekt')

  const soum = sliceObject(root, plane, { nearby: { radius: 3 } })
  const jmena2 = soum.polys.filter(p => p.nearby).map(p => p.object).sort()
  eq(jmena2.join(','), 'naOpacne,uvnitr', 'souměrné okolí naopak vezme i druhou stranu')
}

{
  console.log('\n— objekt přesahující konec pásu se řízne uvnitř pásu —')
  const root = new THREE.Group()
  // dlouhý nosník od x=1 do x=9; pás je 0…3, takže musí být říznutý uvnitř něj
  const nosnik = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 0.4), new THREE.MeshBasicMaterial({ name: 'nosnik' }))
  nosnik.position.set(5, 0, 0)
  root.add(nosnik)
  const s = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), { nearby: { from: 0, to: 3 } })
  eq(s.nearbyCount, 1, 'nosník se přibral')
  const p = s.polys.find(x => x.nearby)
  eq(p.depth >= 0 && p.depth <= 3, true, 'a rovina jeho řezu leží uvnitř pásu')
  near(p.height, 0.6, 1e-3, 'průřez nosníku sedí')
}

// ── jednostranný výřez se proloží celý, ne jen souměrně kolem roviny ───────────
{
  console.log('\n— výřez 0…4 m: pohled ze strany —')
  const root = new THREE.Group()
  // pět příčníků po 1 m; rovina x=0 protne jen ten první
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 4), new THREE.MeshBasicMaterial({ name: 'pricnik' }))
    m.name = 'pricnik_' + i
    m.position.set(i * 1, 0, 0)
    root.add(m)
  }
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)

  const jen = sliceSlab(root, 0, plane)
  eq(jen.polys.length, 1, 'bez výřezu je ve výkrese jediný příčník')

  const vyrez = sliceSlab(root, { from: 0, to: 4 }, plane)
  eq(vyrez.polys.length > 4, true, 'výřez 0…4 m ukáže i ostatní příčníky')
  eq(vyrez.polys.every(p => p.depth >= -1e-9 && p.depth <= 4 + 1e-9), true, 'a nic mimo výřez')

  const opacne = sliceSlab(root, { from: -4, to: 0 }, plane)
  eq(opacne.polys.length, 1, 'výřez na opačnou stranu je prázdný — příčníky jsou vpravo')
}

// ── výkon ──────────────────────────────────────────────────────────────────────
{
  console.log('\n— výkon —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.SphereGeometry(5, 400, 250)))
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

  // první řez staví strom obalů, další už z něj jen čtou
  const t0 = Date.now()
  const r = sliceObject(root, plane)
  const first = Date.now() - t0
  const t1 = Date.now()
  const r2 = sliceObject(root, new THREE.Plane(new THREE.Vector3(0, 1, 0), -1))
  const again = Date.now() - t1
  console.log(`      trojúhelníků v modelu ${(199200).toLocaleString('cs')}, na rovinu sáhlo ${r.triCount.toLocaleString('cs')}`)
  console.log(`      první řez ${first} ms (i se stavbou stromu), další ${again} ms`)
  eq(r.loops, 1, 'jeden obrys')
  eq(r2.loops, 1, 'a po posunu roviny zase jeden')
  eq(r.triCount < 20000, true, 'strom obalů odřízl většinu trojúhelníků')
  eq(again <= Math.max(first, 5), true, 'druhý řez už strom nestaví, takže není pomalejší')

  // Drobná geometrie strom nedostane — režie by byla větší než úspora.
  eq(meshBvh(new THREE.BoxGeometry(1, 1, 1)), null, 'krychle strom nepotřebuje')
  eq(meshBvh(new THREE.SphereGeometry(1, 200, 120)) !== null, true, 'velká koule ano')
}


// ── obrysy pohledu: promítnuté hrany → kótovatelné čáry ────────────────────────
{
  console.log('\n— obrysy pohledu z promítnutých hran —')
  // Obdélník 6 × 2 rozsypaný na úsečky v přeházeném pořadí a s obrácenými směry —
  // přesně tak, jak hrany padají z EdgesGeometry.
  const segs = [
    3, 1, -3, 1,          // horní, zprava doleva
    -3, -1, 3, -1,        // dolní
    3, -1, 3, 0,          // pravá, na dvakrát (ať se musí navázat)
    3, 0, 3, 1,
    -3, 1, -3, -1,        // levá
  ]
  const polys = polysFromSegments(segs, { scale: 6 })
  eq(polys.length, 1, 'z rozsypaných hran vyjde jeden obrys')
  const p = polys[0]
  eq(p.closed, true, 'obdélník se uzavře')
  eq(p.projected, true, 'je označený jako pohled, ne řez')
  eq(p.area, 0, 'pohled nemá plochu — neleží v rovině')
  near(p.length, 16, 1e-6, 'obvod')
  near(p.width, 6, 1e-6, 'šířka')
  near(p.height, 2, 1e-6, 'výška')
  eq(p.pts.length, 5, 'kolineární dělení pravé hrany se zjednoduší')

  // Šikmá čára musí dát změřitelný sklon — kvůli tomu se to celé dělá.
  const sikma = polysFromSegments([0, 0, 10, 10], { scale: 10 })
  eq(sikma.length, 1, 'otevřená čára')
  eq(sikma[0].closed, false, 'a zůstane otevřená')
  near(polySegments(sikma[0])[0].angle, 45, 1e-6, 'sklon promítnuté čáry')

  // Do DXF jde vlastní vrstvou, ať se dá v CADu zhasnout jedním kliknutím.
  const dxf = buildSectionDxf({ polys, uLabel: 'u', vLabel: 'v' })
  eq(dxf.includes('RIZ_POHLED'), true, 'pohled má v DXF vlastní vrstvu')

  // Zakryté čáry jsou taky pohled, ale musí jít v CADu zhasnout zvlášť.
  const zakryte = polysFromSegments([0, 0, 5, 0], { scale: 5, hidden: true })
  eq(zakryte[0].hidden, true, 'zakrytá čára je označená')
  eq(zakryte[0].projected, true, 'a pořád je to pohled')
  eq(polys[0].hidden, false, 'viditelná čára označená není')
  const dxfH = buildSectionDxf({ polys: zakryte, uLabel: 'u', vLabel: 'v' })
  eq(dxfH.includes('RIZ_POHLED_SKRYTY'), true, 'zakrytý pohled má vlastní vrstvu')
}

// ── list papíru: měřítko, rámeček, razítko ─────────────────────────────────────
{
  console.log('\n— řez vysázený na papír —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))

  const title = {
    stavba: 'Zkušební stavba', objekt: 'SO 201', vykres: 'Příčný řez',
    vypracoval: 'LB', datum: '9. 9. 2026', cislo: 'C.2.1',
  }
  const opts = {
    format: 'A3', landscape: true, scale: 50, title,
    color: () => '#111827', keyOf: () => 'beton',
    dims: false, lines: 'all', hatch: true, measures: [],
  }

  // A3 na šířku = 420 × 297 mm, kreslicí plocha 390 × 232 (rámeček + razítko)
  const info = sheetInfo(r, 'A3', true, 50)
  near(info.widthMm, 420, 1e-9, 'šířka listu A3 na šířku')
  near(info.heightMm, 297, 1e-9, 'výška listu')
  eq(info.fits, true, 'řez 4 × 6 m se do 1:50 vejde')
  eq(sheetInfo(r, 'A3', true, 10).fits, false, 'do 1:10 už ne — 60 cm na 39 cm plochy')
  eq(SCALES.includes(sheetInfo(r, 'A3', true, 0).scale), true, 'auto vybere normované měřítko')
  eq(sheetInfo(r, 'A3', true, 0).fits, true, 'a takové, do kterého se to vejde')

  const sheet = sectionSheet(r, opts)
  eq(sheet.svg.includes('width="420mm"'), true, 'list má rozměr v milimetrech')
  eq(sheet.svg.includes('1 : 50'), true, 'měřítko je v razítku')
  eq(sheet.svg.includes('Zkušební stavba'), true, 'razítko nese stavbu')
  eq(sheet.svg.includes('C.2.1'), true, 'i číslo výkresu')
  eq(sheet.svg.includes('<pattern'), true, 'řezná plocha je šrafovaná')
  eq(sectionSheet(r, { ...opts, hatch: false }).svg.includes('<pattern'), false, 'bez šraf se vzor nepřidává')

  /**
   * To hlavní: metr modelu je na papíře přesně 1000/měřítko mm. Bez toho by se z výtisku
   * nedalo měřit pravítkem a celý papírový režim by neměl smysl.
   */
  const pts = /<polyline points="([^"]+)"/.exec(sheet.svg)
  const xs = pts[1].split(' ').map(s => Number(s.split(',')[0]))
  near(Math.max(...xs) - Math.min(...xs), r.width * (1000 / 50), 0.01, 'šířka obrysu na papíře [mm]')

  // zakrytá čára pohledu musí být čárkovaná, jinak to není pohled ale klubko
  const sHid = sectionSheet(
    { ...r, polys: [...r.polys, ...polysFromSegments([0, 0, 2, 0], { scale: 2, hidden: true })] },
    opts,
  )
  eq(sHid.svg.includes('stroke-dasharray="1.6 1.2"'), true, 'zakrytá hrana je čárkovaná')
  eq(sectionSheet({ ...r, polys: [...r.polys, ...polysFromSegments([0, 0, 2, 0], { scale: 2, hidden: true })] },
    { ...opts, lines: 'visible' }).svg.includes('stroke-dasharray="1.6 1.2"'), false, '„jen viditelné" ji vynechá')
}

// ── hrany a siluety ────────────────────────────────────────────────────────────
{
  console.log('\n— hrany geometrie: okraje, zlomy, siluety —')

  // Krychle: 12 ostrých hran. Úhlopříčky stěn mají obě stěny v jedné rovině, takže se
  // nekreslí nikdy — ani jako zlom, ani jako silueta.
  const cube = new THREE.BoxGeometry(1, 1, 1)
  const ce = meshEdges(cube, 25)
  eq(ce.count, 18, 'krychle má 18 svařených hran (12 ostrých + 6 úhlopříček stěn)')
  eq([...ce.always].filter(Boolean).length, 12, 'z toho 12 se kreslí vždy')
  let cubeSil = 0
  for (let e = 0; e < ce.count; e++) if (!ce.always[e] && isSilhouette(ce, e, 0, 0, -1)) cubeSil++
  eq(cubeSil, 0, 'úhlopříčka stěny nikdy siluetou nebude')

  /**
   * Válec bez podstav: plášť nemá jedinou ostrou hranu, takže `EdgesGeometry` by z něj
   * nakreslila jen okraje. Obrys, který na výkrese vidíš, jsou přitom dvě svislé siluety —
   * a přesně kvůli tomuhle to celé je.
   */
  const cyl = new THREE.CylinderGeometry(1, 1, 2, 32, 1, true)
  const ye = meshEdges(cyl, 25)
  eq([...ye.always].filter(Boolean).length, 64, 'plášť má jen okraje: 2 kružnice po 32 úsečkách')
  const sil = (dx, dy, dz) => {
    let n = 0
    for (let e = 0; e < ye.count; e++) if (!ye.always[e] && isSilhouette(ye, e, dx, dy, dz)) n++
    return n
  }
  eq(sil(1, 0, 0), 2, 'z boku má válec dvě siluety')
  eq(sil(0, 0, 1), 2, 'a z jiného směru zase dvě — jen jinde')
  eq(sil(0, 1, 0), 0, 'shora (podél osy) žádnou — plášť je vidět celý zkraje')

  // Otevřená deska: samé okraje, žádná dvojice stěn.
  const plate = new THREE.PlaneGeometry(2, 1)
  const pe = meshEdges(plate, 25)
  eq([...pe.always].filter(Boolean).length, 4, 'deska má 4 okrajové hrany')
  eq(pe.count, 5, 'a k nim jednu úhlopříčku, kterou nekreslíme')

  // Sousednost se počítá jednou a drží u geometrie.
  eq(meshEdges(cube, 25) === ce, true, 'podruhé se hrany nepočítají znovu')
  eq(meshEdges(cube, 80) === ce, false, 'jiný úhel zlomu je ale jiná sada')

  // Směr pohledu se otáčí do lokálu objektu, ne naopak.
  const m = new THREE.Matrix4().makeRotationY(Math.PI / 2)
  const d = viewDirLocal(m, new THREE.Vector3(0, 0, 1))
  near(d.x, -1, 1e-6, 'otočený objekt: směr pohledu v lokálu (x)')
  near(d.z, 0, 1e-6, 'otočený objekt: směr pohledu v lokálu (z)')
}

// ── slučování promítnutých čar ─────────────────────────────────────────────────
{
  console.log('\n— slučování duplicitních čar —')
  const M = { tol: 0.002, depthTol: 0.05 }
  const segCount = a => a.length / 6

  // Instancované zábradlí: táž hrana stokrát na témže místě → jedna čára.
  const dup = []
  for (let i = 0; i < 100; i++) dup.push(0, 0, 3, 0, 2, 3)
  eq(segCount(mergeSegments(dup, M)), 1, 'sto totožných čar se slije v jednu')

  // Táž čára pozpátku je pořád táž čára.
  eq(segCount(mergeSegments([0, 0, 3, 2, 0, 3, 2, 0, 3, 0, 0, 3], M)), 1, 'čára a táž čára pozpátku')

  // Navazující kousky na jedné přímce → jedna dlouhá čára (a v DXF jedna entita).
  const chain = mergeSegments([0, 0, 3, 1, 0, 3, 1, 0, 3, 2, 0, 3, 2, 0, 3, 3, 0, 3], M)
  eq(segCount(chain), 1, 'tři navazující kousky dají jednu čáru')
  near(Math.min(chain[0], chain[3]), 0, 1e-6, 'a začíná na začátku')
  near(Math.max(chain[0], chain[3]), 3, 1e-6, 'a končí na konci')

  /**
   * Přední a zadní madlo zábradlí se promítnou na TÚŽ čáru, ale leží každé jinde. Kdyby se
   * slily, přišel by se o ně výpočet zakrytí — jedno je vidět, druhé ne.
   */
  eq(segCount(mergeSegments([0, 0, 3, 2, 0, 3, 0, 0, 8, 2, 0, 8], M)), 2, 'stejná čára v jiné hloubce zůstane zvlášť')

  // Mezera na téže přímce se nepřemostí.
  eq(segCount(mergeSegments([0, 0, 3, 1, 0, 3, 5, 0, 3, 6, 0, 3], M)), 2, 'mezeru na přímce nepřemostí')

  // Různé přímky se nemíchají.
  eq(segCount(mergeSegments([0, 0, 3, 2, 0, 3, 0, 1, 3, 2, 1, 3], M)), 2, 'rovnoběžky vedle sebe zůstanou dvě')
  eq(segCount(mergeSegments([0, 0, 3, 2, 0, 3, 0, 0, 3, 0, 2, 3], M)), 2, 'kolmice se neslijí')

  // Reálný přínos: kolik z toho zbude.
  const many = []
  for (let i = 0; i < 40; i++) for (let k = 0; k < 25; k++) many.push(i * 0.5, 0, 2, i * 0.5, 1.1, 2)
  eq(segCount(many), 1000, 'vstup: 40 svislic po 25 kopiích')
  eq(segCount(mergeSegments(many, M)), 40, 'výstup: 40 čar')
}

// ── rozmisťování kót ───────────────────────────────────────────────────────────
{
  console.log('\n— kóty se nepřekrývají —')
  // Deset popisků na jednom místě: projít může jen ten první a pár odsazených.
  const stack = []
  for (let i = 0; i < 10; i++) stack.push({ x: 0, y: 0, w: 20, h: 3, angle: 0, id: i })
  const placed = placeLabels(stack, { pad: 0.5 })
  eq(placed.length <= 5, true, 'z deseti popisků na jednom bodě zbude pár odsazených')
  eq(placed[0].id, 0, 'první v pořadí má přednost')
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j]
      const over = Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2
      eq(over, false, `popisky ${i} a ${j} se nepřekrývají`)
    }
  }
  // Rozházené popisky projdou všechny.
  const spread = []
  for (let i = 0; i < 10; i++) spread.push({ x: i * 50, y: 0, w: 20, h: 3, angle: 0, id: i })
  eq(placeLabels(spread, { pad: 0.5 }).length, 10, 'rozházené popisky projdou všechny')
  eq(placeLabels(spread, { pad: 0.5, max: 4 }).length, 4, 'strop se dodrží')
}

// ── DXF: hladiny, typy čar, šrafy, kóty ────────────────────────────────────────
{
  console.log('\n— DXF —')
  const root = new THREE.Group()
  const m = meshOf(new THREE.BoxGeometry(2, 4, 6))
  m.material.name = 'beton'
  root.add(m)
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))

  const plain = buildSectionDxf(r)
  eq(plain.includes('AC1009'), true, 'hlavička DXF R12')
  eq(plain.includes('LTYPE'), true, 'tabulka typů čar')
  eq(plain.includes('HIDDEN'), true, 'a v ní čárkovaná pro zakrytý pohled')
  eq(plain.includes('RIZ_BETON'), true, 'materiál dostal vlastní hladinu')
  eq(plain.includes('RIZ_SRAFY'), false, 'bez zapnutých šraf se hladina nezakládá')

  const full = buildSectionDxf(r, { hatch: true, dims: true })
  eq(full.includes('RIZ_SRAFY'), true, 'šrafy mají hladinu')
  eq(full.includes('RIZ_KOTY'), true, 'kóty mají hladinu')
  eq(full.split('\nLINE').length > 5, true, 'a šrafy jsou opravdu čáry')
  eq(full.includes('TEXT'), true, 'kóty jsou text')

  // Šrafy nesmí vylézt z obrysu — řez kvádrem je 4 × 6 se středem v počátku.
  const lines = full.split('\n')
  let out = 0
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === '10' || lines[i] === '11') {
      if (Math.abs(Number(lines[i + 1])) > 3.001) out++
    }
  }
  eq(out, 0, 'žádná čára nevyleze z obrysu (|u| ≤ 3)')
}

// ── skládání viditelných a zakrytých úseků hrany ───────────────────────────────
{
  console.log('\n— úseky hrany podle zakrytí —')
  const R = (arr, total, minRun) => edgeRuns(Uint8Array.from(arr), total, minRun)
  const kinds = r => { const k = []; for (let i = 2; i < r.length; i += 3) k.push(r[i]); return k }
  const covers = r => {
    // úseky musí navazovat a pokrýt celou hranu — jinak by ve výkrese vznikaly díry
    if (r[0] !== 0) return false
    for (let i = 3; i < r.length; i += 3) if (r[i] !== r[i - 2]) return false
    return true
  }

  // Celá hrana viditelná / celá zakrytá → jeden úsek.
  eq(R([0, 0, 0, 0, 0, 0], 10, 1).length, 3, 'jednolitá viditelná hrana je jeden úsek')
  eq(R([1, 1, 1, 1, 1, 1], 10, 1)[2], 1, 'jednolitá zakrytá taky, a je zakrytá')

  /**
   * Šum z hrubosti hloubkové mapy. Přesně tohle dělalo z výkresu změť: každý osamělý vzorek
   * rozsekl čáru na tři kusy.
   */
  const noisy = R([0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 10, 1)
  eq(noisy.length, 3, 'osamělé vzorky se vyhladí, zbude jeden úsek')
  eq(noisy[2], 0, 'a je viditelný — šum nerozhoduje')

  // Skutečný přechod uprostřed se zachová.
  const half = R([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], 10, 1)
  eq(half.length, 6, 'poctivý přechod se zachová')
  eq(kinds(half).join(''), '01', 'nejdřív viditelný, pak zakrytý')
  eq(covers(half), true, 'a úseky na sebe navazují')

  // Krátký úsek se přiklopí k delšímu sousedovi, ne že se vyhodí.
  const tiny = R([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0], 10, 3)
  eq(tiny.length, 3, 'úsek pod mez zmizí ve svém sousedovi')
  eq(covers(tiny), true, 'a hrana zůstane celá')

  // Delší než mez zůstane.
  const keep = R([0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0], 10, 3)
  eq(keep.length, 9, 'úsek nad mez zůstane')
  eq(kinds(keep).join(''), '010', 'viditelný, zakrytý, viditelný')
  eq(covers(keep), true, 'a pořád na sebe navazují')

  /**
   * To hlavní: úseky nikdy nesmí sáhnout mimo svou hranu. Chyba, kvůli které se útržek lepil
   * na PŘEDCHOZÍ, nesouvisející hranu, dělala ve výkrese dlouhé čáry napříč celým modelem.
   */
  for (const pattern of [[1], [0, 1], [1, 0, 1, 0, 1], [0, 0, 1, 1, 0, 1, 0, 0, 1]]) {
    const r = R(pattern, 10, 4)
    eq(r[0], 0, `vzor ${pattern.join('')} začíná na začátku hrany`)
    eq(r[r.length - 2], pattern.length, `vzor ${pattern.join('')} končí na konci hrany`)
    eq(covers(r), true, `vzor ${pattern.join('')} nemá díry ani přesahy`)
  }
}

// ── řetězení v křižovatce ──────────────────────────────────────────────────────
{
  console.log('\n— obrys v uzlu pokračuje rovně —')
  /**
   * Dvě čáry křížem přes společný bod. Dřív se v uzlu brala první volná hrana, takže z toho
   * vyšla dvě „L" — obrys uhnul do sousedního prvku a vrátil se. Ve výkrese to byly ty
   * nesmyslné cikcaky.
   */
  const cross = polysFromSegments(
    [-1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1],
    { scale: 2 },
  )
  eq(cross.length, 2, 'kříž dá dvě čáry')
  for (const p of cross) {
    eq(Math.min(p.width, p.height) < 1e-9, true, `čára ${p.width.toFixed(0)}×${p.height.toFixed(0)} je rovná, ne zalomená`)
    near(Math.max(p.width, p.height), 2, 1e-6, 'a je celá — přes obě poloviny')
  }

  // Písmeno T: rovné rameno má přednost, odbočka zůstane zvlášť.
  const tee = polysFromSegments([-1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], { scale: 2 })
  const straight = tee.filter(p => p.height < 1e-9)
  eq(straight.length, 1, 'v T se rovné rameno nepřeruší')
  near(straight[0].width, 2, 1e-6, 'a jde přes celou délku')
}

// ── siluety na skoro rovné ploše ───────────────────────────────────────────────
{
  console.log('\n— silueta jen tam, kde se plocha zatáčí —')
  /**
   * Mírně zvlněná deska viděná skoro zboku. Normály jsou téměř kolmé na pohled, takže se
   * znaménko skalárního součinu mezi sousedními trojúhelníky převrací náhodně — bez
   * podmínky na skutečný zlom by „siluetou" byla skoro každá vnitřní hrana a výkres by byl
   * drátěný chuchvalec. Přesně tohle dělalo mostovku v podélném pohledu nečitelnou.
   */
  const geo = new THREE.PlaneGeometry(10, 10, 30, 30)
  const pos = geo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, Math.sin(i * 12.9898) * 0.002)      // setrvalé „nerovnosti" pod 1 mm
  }
  geo.computeBoundingBox()
  const set = meshEdges(geo, 35)
  const dir = [0.999, 0.0447, 0]                    // pohled skoro v rovině desky
  let noisy = 0
  let filtered = 0
  for (let e = 0; e < set.count; e++) {
    if (set.always[e]) continue
    if (isSilhouette(set, e, dir[0], dir[1], dir[2], 0)) noisy++
    if (isSilhouette(set, e, dir[0], dir[1], dir[2])) filtered++
  }
  eq(noisy > 100, true, `bez podmínky na zlom by siluet byly stovky (${noisy})`)
  eq(filtered, 0, 'se zlomem 3° nezbude ani jedna — deska siluetu uvnitř sebe nemá')

  // Válec se ale zahodit nesmí: tam je zlom mezi stěnami skutečný.
  const cyl = meshEdges(new THREE.CylinderGeometry(1, 1, 2, 32, 1, true), 35)
  let sil = 0
  for (let e = 0; e < cyl.count; e++) if (!cyl.always[e] && isSilhouette(cyl, e, 1, 0, 0)) sil++
  eq(sil, 2, 'válec má pořád své dvě siluety')
}

// ── ořez promítnutých hran na výřez ────────────────────────────────────────────
{
  console.log('\n— hrana se ořeže, ne zahodí —')
  const lo = [-1, -1, 0]
  const hi = [1, 1, 10]

  eq(clipToBox([0, 0, 5], [0.5, 0.5, 5], lo, hi).join(','), '0,1', 'hrana celá uvnitř zůstane celá')
  eq(clipToBox([5, 5, 5], [6, 6, 5], lo, hi), null, 'hrana celá venku vypadne')

  /**
   * To hlavní: hrana, která do výřezu jen zasahuje, se musí useknout na jeho hranici.
   * Dřív zůstala celá — a ve výkrese pak trčel kus za hranu výřezu do prázdna, zatímco
   * rastr pod ní byl uříznutý přesně. To byly ty čárky, co ve výkrese neseděly.
   */
  const half = clipToBox([0, 0, 5], [4, 0, 5], lo, hi)
  near(half[0], 0, 1e-9, 'začátek uvnitř zůstane')
  near(half[1], 0.25, 1e-9, 'a konec se usekne přesně na hranici')

  const both = clipToBox([-4, 0, 5], [4, 0, 5], lo, hi)
  near(both[0], 0.375, 1e-9, 'hrana skrz naskrz: usekne se zleva')
  near(both[1], 0.625, 1e-9, 'i zprava')

  // Ořez platí i do hloubky — výřez má i přední a zadní mez.
  const deep = clipToBox([0, 0, -5], [0, 0, 5], lo, hi)
  near(deep[0], 0.5, 1e-9, 'co je před výřezem, se usekne')
  eq(clipToBox([0, 0, -5], [0, 0, -1], lo, hi), null, 'a co je celé před ním, vypadne')

  // Rovnoběžná hrana mimo pás nesmí projít.
  eq(clipToBox([-4, 5, 5], [4, 5, 5], lo, hi), null, 'rovnoběžná hrana mimo okno vypadne')
}

// ── filtr vrstev ───────────────────────────────────────────────────────────────
{
  console.log('\n— zhasnutá vrstva mizí i z čísel —')
  const root = new THREE.Group()
  const a = meshOf(new THREE.BoxGeometry(2, 2, 2), [0, 0, 0])
  a.material.name = 'beton'
  const b = meshOf(new THREE.BoxGeometry(1, 1, 1), [0, 3, 0])
  b.material.name = 'ocel'
  root.add(a, b)
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.polys.length, 2, 'dva obrysy, dva materiály')

  const onlyBeton = filterResult(r, p => p.group === 'beton')
  eq(onlyBeton.polys.length, 1, 'filtr nechá jen jeden')
  near(onlyBeton.area, 4, 1e-6, 'a plocha je jen jeho')
  near(onlyBeton.height, 2, 1e-6, 'obálka se přepočítá podle toho, co zbylo')
  eq(onlyBeton.loops, 1, 'i počet obrysů')
  near(r.area, 5, 1e-6, 'původní výsledek zůstane nedotčený')

  const nothing = filterResult(r, () => false)
  eq(nothing.polys.length, 0, 'všechno zhasnuté dá prázdný výkres')
  near(nothing.width, 0, 1e-9, 'a nulovou obálku, ne nekonečnou')
}

// ── výškové body ───────────────────────────────────────────────────────────────
{
  console.log('\n— výšky ve výkrese —')
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 4, 6)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))

  /**
   * Výška bodu se skládá ze SVISLÝCH SLOŽEK OBOU os výkresu, ne jen z „v". U svislého řezu
   * je `u` vodorovná a `v` míří vzhůru, takže rozhoduje jen `v`; u půdorysu je to naopak
   * a jen z `v` by výška vyšla nesmyslně.
   */
  near(r.v.y, 1, 1e-9, 'svislý řez: osa v míří vzhůru')
  near(r.u.y, 0, 1e-9, 'a osa u je vodorovná')
  const elev = (originZ, q) => originZ + q[0] * r.u.y + q[1] * r.v.y
  near(elev(200, [3, 2]), 202, 1e-9, 'bod 2 m nad počátkem je o 2 m výš')
  near(elev(200, [-3, -2]), 198, 1e-9, 'a 2 m pod ním o 2 m níž')

  // Půdorys: „vzhůru" ve výkrese je sever, výška je konstantní.
  const plan = sliceObject(root, new THREE.Plane(new THREE.Vector3(0, 1, 0), -1))
  near(plan.u.y, 0, 1e-9, 'půdorys: osa u nemá svislou složku')
  near(plan.v.y, 0, 1e-9, 'ani osa v — celý výkres leží v jedné výšce')

  // Do papíru i do DXF jde bod jako značka s číslem.
  const levels = [{ p: [0, 1], z: 201.234 }]
  const sheet = sectionSheet(r, {
    format: 'A3', landscape: true, scale: 50,
    title: { stavba: '', objekt: '', vykres: '', vypracoval: '', datum: '', cislo: '' },
    color: () => '#111827', keyOf: () => 'beton',
    dims: false, lines: 'all', hatch: false, measures: [], levels,
  })
  eq(sheet.svg.includes('201.234'), true, 'výška je na papíře')

  const dxf = buildSectionDxf(r, { levels })
  eq(dxf.includes('RIZ_VYSKY'), true, 'a v DXF má vlastní hladinu')
  eq(dxf.includes('201.234'), true, 'i s číslem')
  eq(buildSectionDxf(r).includes('RIZ_VYSKY'), false, 'bez bodů se hladina nezakládá')
}

// ── rozhodnutí o zakrytí ───────────────────────────────────────────────────────
{
  console.log('\n— co je zakryté a co ne —')
  const B = 0.001
  eq(isOccluded(0.5, 0.9995, B), false, 'kde nic nestojí, je hrana vidět')
  eq(isOccluded(0.5, 0.3, B), true, 'za bližší plochou je zakrytá')
  eq(isOccluded(0.5, 0.5, B), false, 'hrana na vlastní ploše je vidět — od toho je tolerance')
  eq(isOccluded(0.5005, 0.5, B), false, 'a drobná odchylka v mezích tolerance taky')
  eq(isOccluded(0.5, 0.6, B), false, 'co je před plochou, je vidět tím spíš')
  /**
   * To hlavní: rozhoduje jediný vzorek. Dřív se okolní pixely braly jako výmluva pro
   * „nechme to viditelné", a všechno za nějakým tělesem tak mělo podél jeho obrysu
   * rozsvícený proužek — ve výkrese kraťoučké čárky rozeseté kolem hran.
   */
  eq(isOccluded(0.5, 0.3 + B, B), true, 'těsně za plochou je pořád zakrytá')
}

// ── čáry výkresu leží na skutečných hranách modelu ─────────────────────────────
{
  console.log('\n— nic se neposouvá —')
  /**
   * Nejtvrdší kontrola celého vykreslovacího řetězce: referenčně se hrubou silou promítnou
   * VŠECHNY hrany všech trojúhelníků a pak se ověří, že každý konec každé vydané čáry leží
   * na některé z nich. Když pipeline čáru posune, otočí nebo vymyslí, tady to spadne.
   *
   * Model je schválně zákeřný: dva skoro rovnoběžné nosníky přes 200 m (liší se o setiny
   * stupně), válec kvůli siluetám a 120 instancovaných sloupků kvůli slévání duplicit.
   */
  const root = new THREE.Group()
  const deck = meshOf(new THREE.BoxGeometry(200, 1.2, 12), [0, 9, 0])
  deck.rotation.z = 0.004
  root.add(deck)
  const beam = meshOf(new THREE.BoxGeometry(200, 0.8, 2), [0, 7.6, 3])
  beam.rotation.z = 0.0055
  root.add(beam)
  root.add(meshOf(new THREE.BoxGeometry(3, 8, 4), [0, 4, 0]))
  root.add(meshOf(new THREE.CylinderGeometry(0.6, 0.6, 7, 24), [60, 4, 0]))
  const post = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), new THREE.MeshBasicMaterial(), 120)
  const im = new THREE.Matrix4()
  for (let i = 0; i < 120; i++) { im.makeTranslation(-99 + i * 1.65, 10.2, 6); post.setMatrixAt(i, im) }
  root.add(post)
  root.updateMatrixWorld(true)

  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  const up = new THREE.Vector3(0, 1, 0)
  const { u, v } = planeBasis(plane.normal, up)
  const bb = new THREE.Box3().setFromObject(root)
  const origin = plane.projectPoint(bb.getCenter(new THREE.Vector3()), new THREE.Vector3())

  const ref = []
  const P = new THREE.Vector3()
  const tmp = new THREE.Matrix4()
  const inst = new THREE.Matrix4()
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return
    const pos = o.geometry.getAttribute('position')
    const idx = o.geometry.getIndex()
    const count = idx ? idx.count : pos.count
    const mats = []
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, inst); mats.push(tmp.multiplyMatrices(o.matrixWorld, inst).clone()) }
    } else mats.push(o.matrixWorld)
    for (const mat of mats) {
      for (let i = 0; i + 2 < count; i += 3) {
        const pts = []
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(i + k) : i + k
          P.fromBufferAttribute(pos, vi).applyMatrix4(mat).sub(origin)
          pts.push([P.dot(u), P.dot(v)])
        }
        for (let k = 0; k < 3; k++) ref.push([pts[k], pts[(k + 1) % 3]])
      }
    }
  })

  const CELL = 2
  const grid = new Map()
  ref.forEach(([a, b], i) => {
    for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
      for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
        const k = x + ':' + y
        const l = grid.get(k)
        if (l) l.push(i); else grid.set(k, [i])
      }
    }
  })
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    if (l2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1])
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])
  }
  const toModel = p => {
    let best = Infinity
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL)
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const i of grid.get(x + ':' + y) ?? []) {
          const d = dist(p, ref[i][0], ref[i][1])
          if (d < best) best = d
        }
      }
    }
    return best
  }

  const out = projectSlabEdges(root, plane, { up }).visible.segs
  eq(out.length > 200, true, `něco se vůbec vykreslilo (${out.length / 4} úseček)`)
  let worst = 0
  for (let i = 0; i < out.length; i += 4) {
    worst = Math.max(worst, toModel([out[i], out[i + 1]]), toModel([out[i + 2], out[i + 3]]))
  }
  near(worst, 0, 0.001, 'největší odchylka konce čáry od hrany modelu [m]')

  // A duplicity se pořád slévají — jinak by „nic se neposouvá" šlo splnit i tím, že se nesleje nic.
  eq(out.length / 4 < 600, true, `120 sloupků se slilo, ne rozmnožilo (${out.length / 4} úseček)`)
}

// ── strom obalů nesmí nic zamlčet ──────────────────────────────────────────────
{
  console.log('\n— řez bere všechno, i se stromem obalů —')
  /**
   * Strom obalů zrychlil řez sedmkrát, ale kdyby prořezal o trojúhelník víc, obrys by měl
   * díru a ve výkrese by prvek chyběl. Proto se porovnává s hrubou silou: každý trojúhelník,
   * který rovinu opravdu protíná, musí strom pustit dál.
   */
  const check = (name, geo, plane) => {
    const mesh = meshOf(geo)
    const root = new THREE.Group()
    root.add(mesh)
    root.updateMatrixWorld(true)
    const bb = new THREE.Box3().setFromObject(root)
    const eps = Math.max(bb.getSize(new THREE.Vector3()).length() * 1e-7, 1e-9)
    const bvh = meshBvh(geo)
    eq(bvh !== null, true, `${name}: strom se postavil`)

    const cand = new Set()
    trianglesNearPlane(bvh, planeToLocal(plane, mesh.matrixWorld), eps, t => cand.add(t))

    const pos = geo.getAttribute('position')
    const idx = geo.getIndex()
    const cnt = idx ? idx.count : pos.count
    const P = new THREE.Vector3()
    let straddling = 0
    let missed = 0
    for (let i = 0, t = 0; i + 2 < cnt; i += 3, t++) {
      const d = []
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k
        P.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld)
        d.push(plane.distanceToPoint(P))
      }
      const straddles = !((d[0] > eps && d[1] > eps && d[2] > eps) || (d[0] < -eps && d[1] < -eps && d[2] < -eps))
      if (!straddles) continue
      straddling++
      if (!cand.has(t)) missed++
    }
    eq(straddling > 100, true, `${name}: rovina opravdu něco protíná (${straddling} trojúhelníků)`)
    eq(missed, 0, `${name}: strom nezamlčel ani jeden`)
  }

  check('koule', new THREE.SphereGeometry(5, 200, 120), new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  check('torus knot', new THREE.TorusKnotGeometry(4, 1.2, 400, 40), new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.37))
  check('šikmá rovina', new THREE.CylinderGeometry(3, 3, 12, 300, 40), new THREE.Plane(new THREE.Vector3(0.6, 0.5, 0.62).normalize(), -0.9))
}

// ── zakrytí se posuzuje z obou stran hrany ─────────────────────────────────────
{
  console.log('\n— hrana se posuzuje z obou stran —')
  const B = 0.001
  // rozhoduje VZDÁLENĚJŠÍ z obou stran hrany
  const both = (own, a, b) => isOccluded(own, Math.max(a, b), B)

  /**
   * Silueta kulatého sloupu. Uvnitř je jeho vlastní přední plocha (o poloměr blíž), venku
   * pozadí. Kdyby rozhodoval jen vzorek dovnitř, dostal by sloup jednu hranu čárkovanou
   * a druhou plnou podle toho, kam který okraj zaokrouhlil — přesně to bylo vidět.
   */
  eq(both(0.5, 0.45, 1), false, 'silueta sloupu je vidět, i když je dovnitř vlastní plocha')
  eq(both(0.5, 1, 0.45), false, 'a je jedno, na které straně ta plocha leží')

  // Prvek schovaný za deskou má blíž ležící plochu z OBOU stran → zakrytý.
  eq(both(0.6, 0.3, 0.3), true, 'co je za deskou, zakryté zůstane')

  // Na samém okraji zakrývajícího tělesa zůstane pixel široký proužek viditelný.
  eq(both(0.6, 0.3, 1), false, 'okraj zakrývajícího tělesa nechá pixel široký proužek')

  // Tolerance pořád platí: hrana na vlastní ploše se nezakrývá sama sebou.
  eq(both(0.5, 0.5, 0.5), false, 'hrana na vlastní ploše je vidět')
}

// ── drobty se posuzují až jako hotový obrys ────────────────────────────────────
{
  console.log('\n— malý prvek přežije, smetí ne —')
  /**
   * Lampa v šedesátimetrovém výkrese: hlavice má hrany po 10 cm, ale drží na metrovém
   * ramenu. Filtrovat po ÚSEČKÁCH by jí ty krátké hrany utrhalo a zbyly by cáry — proto se
   * posuzuje až obálka hotového obrysu.
   */
  const minSize = 60 * 6e-4                     // ~3,6 cm, jako u šedesátimetrového výkresu
  const lampa = [
    0, 0, 1.2, 0,                               // rameno, 1,2 m
    1.2, 0, 1.2, 0.1,                           // hlavice: krátké hrany po 10 cm
    1.2, 0.1, 1.1, 0.1,
    1.1, 0.1, 1.1, 0,
  ]
  const p1 = polysFromSegments(lampa, { scale: 60, minSize })
  eq(p1.length, 1, 'lampa zůstane jedním obrysem')
  eq(p1[0].pts.length, 5, 'i s krátkými hranami hlavice')
  near(p1[0].width, 1.2, 1e-6, 'a v plné délce')

  // Osamocený dvoucentimetrový drobek naopak vypadne.
  eq(polysFromSegments([5, 5, 5.02, 5], { scale: 60, minSize }).length, 0, 'dvoucentimetrové smetí vypadne')
  // Bez prahu se nezahazuje nic.
  eq(polysFromSegments([5, 5, 5.02, 5], { scale: 60 }).length, 1, 'bez prahu zůstane i drobek')
  // Krátká, ale samostatně smysluplná čára těsně nad prahem přežije.
  eq(polysFromSegments([5, 5, 5.05, 5], { scale: 60, minSize }).length, 1, 'čára nad prahem přežije')
}

// ── obrys pohledu ví, jak daleko za rovinou leží ───────────────────────────────
{
  console.log('\n— hloubka obrysu pohledu —')
  /**
   * Dvě čáry na TÉMŽE místě výkresu, ale v různé hloubce — přední a zadní hrana sloupku.
   * Bez téhle informace se ve výkrese nedá poznat, jestli je plná a čárkovaná čára přes sebe
   * v pořádku (dva prvky za sebou), nebo chyba (jedna hrana rozseknutá na dva druhy).
   */
  const p = polysFromSegments([0, 0, 0, 2], { scale: 10, depths: [3.5] })
  eq(p.length, 1, 'čára projde')
  near(p[0].viewDepth, 3.5, 1e-9, 'a nese svou vzdálenost od roviny')
  eq(polysFromSegments([0, 0, 0, 2], { scale: 10 })[0].viewDepth, 0, 'bez zadané hloubky je nula')

  // Navázaný obrys zdědí hloubku většiny svých úseků.
  const chain = polysFromSegments([0, 0, 1, 0, 1, 0, 2, 0], { scale: 10, depths: [4, 4] })
  eq(chain.length, 1, 'dva navazující kousky dají jeden obrys')
  near(chain[0].viewDepth, 4, 1e-9, 'a hloubku si nesou dál')

  // Řez sám hloubku pohledu nemá.
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(2, 2, 2)))
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(1, 0, 0), 0))
  eq(r.polys[0].viewDepth, 0, 'obrys řezu má nulu — leží v rovině')
}

// ── na papír se kreslí jen to, co pero unese ───────────────────────────────────
{
  console.log('\n— detail jemnější než pero se nerýsuje —')
  /**
   * Dvousetmetrový most se na A3 vejde nejvýš v 1:1000. Sloupek zábradlí je pak na papíře
   * osm SETIN milimetru široký, ale čára, kterou by se kreslil, má 0,18 mm. Sto takových
   * vedle sebe nedá výkres, ale šedý flek — v PDF pak nešlo nic přečíst.
   */
  const root = new THREE.Group()
  root.add(meshOf(new THREE.BoxGeometry(200, 1.2, 12), [0, 9, 0]))
  root.updateMatrixWorld(true)
  const r = sliceObject(root, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0))
  const cutPolys = r.polys.length

  const segs = []
  const depths = []
  for (let i = 0; i < 120; i++) {
    const x = -99 + i * 1.65
    segs.push(x, 4, x, 5.1); depths.push(6)              // sloupek 1,1 m vysoký
    segs.push(x + 0.08, 4, x + 0.08, 5.1); depths.push(6)
  }
  r.polys.push(...polysFromSegments(segs, { scale: 200, depths }))

  const base = {
    format: 'A3', landscape: true,
    title: { stavba: '', objekt: '', vykres: '', vypracoval: '', datum: '', cislo: '' },
    color: () => '#111827', keyOf: () => 'beton',
    dims: false, lines: 'all', hatch: false, measures: [],
  }
  const lines = svg => (svg.match(/<polyline/g) || []).length
  const pens = svg => [...new Set([...svg.matchAll(/stroke-width="([\d.]+)"/g)].map(m => m[1]))].sort()

  eq(sheetInfo(r, 'A3', true, 0).scale, 1000, 'dvousetmetrový most se na A3 vejde v 1:1000')

  const daleko = sectionSheet(r, { ...base, scale: 1000 })
  eq(lines(daleko.svg), cutPolys, 'v 1:1000 zbude jen řez — zábradlí by byla jen mřížka')

  const blizko = sectionSheet(r, { ...base, scale: 200 })
  eq(lines(blizko.svg) > 200, true, `v 1:200 se zábradlí vrátí (${lines(blizko.svg)} čar)`)

  // Pera jsou z normované řady a vedlejší čáry tenčí než řezné.
  eq(pens(blizko.svg).includes('0.5'), true, 'řezná hrana kreslí půlmilimetrovým perem')
  eq(pens(blizko.svg).includes('0.18'), true, 'pohled tenčím')
  eq(pens(blizko.svg).some(w => Number(w) > 0.7), false, 'nic tlustšího než rámeček')
}

// ── pera: okno a papír z jedné tabulky ─────────────────────────────────────────
{
  console.log('\n— jedno pero pro obrazovku i papír —')
  /**
   * Dřív byly dvě nezávislé tabulky tlouštěk a rozcházely se: na obrazovce byl pohled skoro
   * stejně silný jako řez, na papíře třikrát tenčí. Co jsi viděl, nebylo co jsi vytiskl.
   */
  const order = ['viewHidden', 'view', 'context', 'cutOpen', 'nearby', 'cut']
  for (let i = 1; i < order.length; i++) {
    eq(PENS[order[i]].mm >= PENS[order[i - 1]].mm, true,
      `${order[i]} není tenčí než ${order[i - 1]} (${PENS[order[i]].mm} ≥ ${PENS[order[i - 1]].mm})`)
  }
  eq(PENS.cut.mm > PENS.view.mm, true, 'řez je na papíře silnější než pohled')

  // Obrazovka pořadí zachová…
  const w = k => penScreen(k).width
  eq(w('cut') > w('view'), true, 'a na obrazovce taky')
  eq(w('cut') > w('cutOpen'), true, 'uzavřený řez je silnější než otevřený')
  // …ale nejtenčí pera srovná na čitelné minimum, jinak by na tmavém podkladu zmizela
  eq(w('viewHidden') >= 0.9, true, 'nejtenčí pero je na obrazovce ještě vidět')
  near(w('cut'), 2, 1e-9, 'půlmilimetrové pero = 2 jednotky viewBoxu')

  // Čárkování je taky společné.
  eq(!!PENS.viewHidden.dash, true, 'zakrytý pohled je čárkovaný')
  eq(!!PENS.view.dash, false, 'viditelný ne')
  eq(!!penScreen('viewHidden').dash, true, 'a na obrazovce stejně')
}

console.log(fails === 0 ? '\nVŠE PROŠLO' : `\nSELHALO: ${fails}`)
process.exit(fails === 0 ? 0 : 1)
