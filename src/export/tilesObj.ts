/**
 * Export vybraných dlaždic jako zip: teren.obj + teren.mtl + JPEG na dlaždici.
 *
 * Každá dlaždice = vlastní objekt s vlastním materiálem, souřadnice v rovině S-JTSK. Bez posunu
 * jdou ven reálné souřadnice, ať to v Maxu lícuje s ostatními daty; se zadaným posunem se model
 * rovnou usadí k počátku. 3ds Max importuje OBJ nativně i s texturami.
 *
 * Zip se skládá STREAMOVANĚ, po dlaždicích. Celý OBJ jako jeden řetězec nejde: u ~50 dlaždic
 * přeteče strop V8 na délku stringu (~512 MB) a join spadne na „Invalid string length". Takhle
 * se v paměti nikdy nedrží víc než jedna dlaždice a zkomprimovaný výstup.
 */
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'
import {
  type Tile, type Offset, type TileSize, type MeshStep, type TexSize,
  tileName, tilesBounds, pool, fetchTileHeights, fetchTileOrtho, buildTileObj, buildMtl, buildMaxScript,
  medianHeight, stepOf, concatBytes,
} from '../tiles'
import { BUILDING_MTL } from '../buildings'
import { isAbortError } from '../config'
import { download, buildingsObjChunk } from '../exportUtils'
import { fetchKatastrDxf } from './katastrDxf'
import { throwIfAborted, type ExportCtx } from './ctx'
import type { CoordPoint } from '../lib/types'

export type TilesObjOpts = {
  tileSize: TileSize; meshStep: MeshStep; texSize: TexSize
  /** přibalit budovy ČÚZK jako samostatný objekt „budovy" */
  buildings: boolean
  /** přibalit hranice parcel jako katastr.dxf v témže S-JTSK rámci */
  katastr: boolean
  /**
   * Posun modelu — tatáž hodnota, jaká je v panelu Souřadnice.
   *
   * POZOR na znaménko: `buildTileObj` offset ODEČÍTÁ (`x - off.x`), kdežto panel ho PŘIČÍTÁ
   * (`bod.x + posun`). Aby vrcholy vyšly tam, kam ukazují odečtené body, musí se sem předat
   * posun obrácený. Děje se to na jednom místě níž, ne u volajícího.
   */
  shift?: [number, number, number]
  /** odečtené body — přibalí se jako helpery pro 3ds Max a jako textový seznam */
  points?: CoordPoint[]
}

/**
 * Skript, který ve 3ds Maxu vyrobí z odečtených bodů Point helpery.
 *
 * Body jdou ven ve STEJNÉ soustavě jako terén, tedy včetně posunu — jinak by se objevily
 * stovky kilometrů od modelu. Souřadnice se sem proto předávají už posunuté.
 */
function buildPointsScript(pts: CoordPoint[], shift: [number, number, number]): string {
  const [sx, sy, sz] = shift
  const lines = pts.map((p, i) =>
    `  Point pos:[${(p.x + sx).toFixed(3)}, ${(p.y + sy).toFixed(3)}, ${(p.z + sz).toFixed(3)}] ` +
    `name:"bod_${i + 1}" size:20 cross:on axistripod:off box:off wirecolor:(color 0 255 255)`)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return [
    '/*', `  Odectene body z GIS Map -- ${pts.length} ks. Vygenerovano: ${stamp} UTC`, '',
    '  Spust: Scripting > Run Script. Vyrobi Point helpery na mistech, ktera jsi odecetl',
    '  v mape. Souradnice uz jsou ve stejne soustave jako teren.obj vcetne posunu,',
    '  takze sednou na model bez dalsiho srovnavani.',
    '*/',
    '(',
    '  local grp = #()',
    ...lines.map(l => l.replace(/^ {2}Point/, '  append grp (Point')).map(l => l + ')'),
    '  if grp.count > 0 do ( select grp )',
    `  format "GIS Map: vytvoreno % bodu\\n" grp.count`,
    ')',
  ].join('\n')
}

/** Prostý seznam souřadnic — do SynthEyes a kamkoliv jinam se to hodí líp než skript. */
function buildPointsTxt(pts: CoordPoint[], shift: [number, number, number]): string {
  const [sx, sy, sz] = shift
  const moved = !!(sx || sy || sz)
  return [
    '# Odectene body z GIS Map',
    '# S-JTSK (EPSG:5514), vyska Bpv',
    moved ? `# Souradnice jsou POSUNUTE o ${sx} ${sy} ${sz} (stejne jako teren.obj)` : '# Skutecne souradnice, bez posunu',
    '# nazev  X  Y  Z',
    ...pts.map((p, i) => `bod_${i + 1}\t${(p.x + sx).toFixed(3)}\t${(p.y + sy).toFixed(3)}\t${(p.z + sz).toFixed(3)}`),
  ].join('\n') + '\n'
}

export async function exportTilesObj(tiles: Tile[], o: TilesObjOpts, ctx: ExportCtx): Promise<string> {
  ctx.report(0, `0/${tiles.length}`)
  let done = 0
  const fetched = await pool(tiles, 3, async tile => {
    const [grid, jpg] = await Promise.all([fetchTileHeights(tile, o.meshStep, ctx.signal), fetchTileOrtho(tile, o.texSize, ctx.signal)])
    done++
    ctx.report(done / tiles.length, `${done}/${tiles.length}`)
    return { tile, grid, jpg }
  })
  ctx.report(-1, 'skládám…')
  await new Promise(r => setTimeout(r, 30)) // ať se stihne překreslit UI před blokující prací

  const fallbackH = medianHeight(fetched.map(f => f.grid))
  const { minX, minY, maxX, maxY } = tilesBounds(tiles)
  // Bez posunu jdou vrcholy ven v reálných S-JTSK souřadnicích (statisíce metrů), což lícuje
  // s ostatními daty v Maxu. Se zadaným posunem se model dá rovnou k počátku, aby se v Maxu
  // nemusel stěhovat ručně. ZNAMÉNKO: buildTileObj offset odečítá, panel Souřadnice ho přičítá,
  // takže se sem předává obrácený — jinak by model a body mířily na opačné strany.
  const shift = o.shift ?? [0, 0, 0]
  const off: Offset = { x: -shift[0], y: -shift[1], z: -shift[2] }

  const chunks: Uint8Array[] = []
  let zipErr: unknown = null
  const zip = new Zip((err, dat) => { if (err) zipErr = err; else if (dat) chunks.push(dat) })
  const check = () => { if (zipErr) throw zipErr instanceof Error ? zipErr : new Error(String(zipErr)) }

  const objF = new ZipDeflate('teren.obj', { level: 1 })
  zip.add(objF)
  objF.push(strToU8('mtllib teren.mtl\n'), false)
  let vBase = 1
  let built = 0
  for (const f of fetched) {
    throwIfAborted(ctx.signal)
    objF.push(strToU8(buildTileObj(f.tile, f.grid, off, fallbackH, vBase) + '\n'), false)
    vBase += f.grid.n * f.grid.n
    check()
    if (++built % 5 === 0 || built === fetched.length) {
      ctx.report(built / fetched.length, `skládám ${built}/${fetched.length}`)
      await new Promise(r => setTimeout(r, 0)) // pustit UI k slovu
    }
  }
  // volitelně: budovy ČÚZK (výška i tvar střechy z DMR5G/DMP1G) jako samostatný objekt „budovy"
  let buildingsLine = 'Budovy: ne'
  let hasBuildings = false
  if (o.buildings) {
    ctx.report(-1, 'budovy…')
    try {
      const bch = await buildingsObjChunk(minX, minY, maxX, maxY, vBase, ctx.signal)
      if (bch.obj) { objF.push(strToU8(bch.obj), false); check(); vBase += bch.vCount; hasBuildings = true }
      buildingsLine = bch.line
    } catch (e) {
      if (isAbortError(e)) throw e
      console.error('Budovy do exportu selhaly:', e); buildingsLine = 'Budovy: stažení selhalo (viz konzole)'
    }
  }
  objF.push(new Uint8Array(0), true)
  check()

  for (const f of fetched) {
    const jf = new ZipPassThrough(`${tileName(f.tile)}.jpg`) // JPEG už komprimovaný je
    zip.add(jf)
    jf.push(f.jpg, true)
    check()
  }

  const addText = (name: string, text: string) => {
    const d = new ZipDeflate(name, { level: 6 })
    zip.add(d)
    d.push(strToU8(text), true)
    check()
  }
  addText('teren.mtl', buildMtl(tiles) + (hasBuildings ? '\n' + BUILDING_MTL : ''))
  addText('vray_material.ms', buildMaxScript(tiles))
  // Body jdou VEDLE materiálového skriptu, ne do něj: kdo chce jen přepnout materiály, nemá
  // důvod si nechat do scény nasypat helpery.
  if (o.points?.length) {
    addText('body.ms', buildPointsScript(o.points, shift))
    addText('body.txt', buildPointsTxt(o.points, shift))
  }

  // volitelně: hranice parcel (katastr) jako DXF křivky v témže S-JTSK rámci
  let katastrLine = 'Katastr: ne'
  if (o.katastr) {
    ctx.report(-1, 'katastr…')
    try {
      const k = await fetchKatastrDxf(minX, minY, maxX, maxY)
      throwIfAborted(ctx.signal)
      if (k) { addText('katastr.dxf', k.dxf); katastrLine = `Katastr: katastr.dxf (${k.count} parcel, hranice jako 3D křivky)` }
      else katastrLine = 'Katastr: v oblasti nenalezeny žádné parcely'
    } catch (e) {
      if (isAbortError(e)) throw e
      console.error('Katastr do exportu selhal:', e); katastrLine = 'Katastr: stažení selhalo (viz konzole)'
    }
  }

  addText('info.txt', [
    'Terén DMR 5G + ortofoto (ČÚZK)',
    '',
    'Souřadnice: S-JTSK / Křovák East North (EPSG:5514), výšky Bpv.',
    (shift[0] || shift[1] || shift[2])
      ? `POSUNUTO o ${shift[0]} ${shift[1]} ${shift[2]} — model je usazený k počátku, v Maxu už s ním hýbat nemusíš.`
      : 'Žádný posun — vrcholy jsou na skutečných souřadnicích, tak jak leží.',
    '',
    'Import do 3ds Max:',
    '  1) File > Import > teren.obj (textury natáhne teren.mtl)',
    '  2) Chceš-li V-Ray: označ dlaždice (nebo neoznač nic — najde si je sám)',
    '     a spusť Scripting > Run Script > vray_material.ms',
    '     → označeným objektům vymění materiál za VRayMtl s ortofotem v diffuse.',
    '     (VRayMtl nejde uložit do .mtl — Wavefront formát renderery nezná.)',
    ...(o.points?.length ? [
      `  3) Odečtené body (${o.points.length}): Scripting > Run Script > body.ms`,
      '     → vyrobí Point helpery přesně tam, kde jsi je odečetl v mapě.',
      '     Totéž jako prostý seznam je v body.txt (pro SynthEyes a podobně).',
    ] : []),
    '  Rozbal celý zip do JEDNÉ složky, MTL i skript hledají JPEGy vedle sebe.',
    '',
    `Rozsah: X ${minX} … ${maxX}, Y ${minY} … ${maxY}`,
    '',
    `Dlaždic: ${tiles.length} × ${o.tileSize} m`,
    `Mřížka terénu: ${stepOf(tiles[0], fetched[0].grid.n).toFixed(3)} m (zdrojový DMR 5G má body po ~2,8 m)`,
    `Textura: ${o.texSize} px na dlaždici = ${(o.tileSize / o.texSize * 100).toFixed(1)} cm/px (ortofoto ČÚZK má nativně 20 cm/px)`,
    katastrLine,
    buildingsLine,
    'Budovy (je-li): objekt „budovy" = půdorysy ČÚZK, výška z DMP1G−DMR5G, střecha',
    'rozpoznaná (plochá/sedlová/valbová) jako čistá low-poly hmota, hnědý materiál bez textury.',
    'Y je mřížkový sever Křováku, ne pravý sever (meridiánová konvergence ~7°).',
    '',
    'katastr.dxf (je-li): hranice parcel jako uzavřené 3D křivky (DXF R12), stejný S-JTSK',
    'rámec i výšky jako terén → v Maxu lícuje. Import: File > Import > katastr.dxf.',
    '',
    `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
  ].join('\n'))

  zip.end()
  check()
  download(concatBytes(chunks), `teren_sjtsk_${Math.round((minX + maxX) / 2)}_${Math.round((minY + maxY) / 2)}.zip`, 'application/zip')
  return `Vyvezeno ${tiles.length}× dlaždice ${o.tileSize} m s ortofotem`
}
