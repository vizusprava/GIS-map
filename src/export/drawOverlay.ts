/**
 * Dokreslí načtený výkres (DXF/DWG) do rastru spojené 2D mapy.
 *
 * Export mapy si podklad stahuje rovnou z ČÚZK, takže o tom, co je ve scéně, nic neví — výkres
 * by na výstupu chyběl. Tohle ho tam dokreslí. Kreslí se do TÉHOŽ plátna a proti TÉŽE obálce
 * v S-JTSK jako mapa, takže to lícuje bez jakéhokoli dalšího zarovnávání: stejná soustava,
 * stejný výřez, stejné pixely.
 *
 * Texty jdou obyčejným `fillText`, ne jako geometrie písmen (to dělá `dxfText.ts`, protože ve
 * 3D scéně musí text ležet v rovině výkresu). V půdorysném rastru je text prostě text — stačí
 * přepočítat výšku písma z metrů na pixely a otočit plátno.
 */
import type { DrawPrim } from '../dxf'

export type DrawOverlay = {
  prims: DrawPrim[]
  /** souřadnice výkresu → S-JTSK; výkres v Křováku je identita, lokální se posadí do scény */
  toSjtsk: (x: number, y: number) => [number, number]
  /** hladiny vypnuté v mapě — do rastru taky nepatří */
  hidden: Set<string>
  /** průhlednost celého výkresu, jak je nastavená v panelu */
  alpha: number
}

/**
 * Tloušťka čáry v METRECH.
 *
 * Pixel je tu špatná jednotka: rozlišení výstupu se řídí velikostí vybraného území, takže
 * pevná pixelová šířka by u malého výřezu dala vlásek a u velkého palec. Čtvrt metru zhruba
 * odpovídá tomu, jak kresba vypadá v mapě.
 */
const LINE_M = 0.25
/** Pod tohle ale čára spadnout nesmí, jinak by se v hrubém rastru ztratila úplně. */
const LINE_MIN_PX = 1.2
/** Bod z výkresu jako kolečko o tomhle poloměru (v metrech). */
const DOT_M = 0.35
/** Text menší než tohle je v rastru stejně jen šmouha — radši nic než špína přes mapu. */
const TEXT_MIN_PX = 4

const css = (color: number) => '#' + (color & 0xffffff).toString(16).padStart(6, '0')

/** Obálka plátna v S-JTSK. */
export type MapBox = { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Dokreslení do exportu mapy: exporty skládají obrázek po kusech (pruh, blok, dlaždice) a tohle
 * se volá pro každý kus s jeho vlastní obálkou. Tloušťky jsou v metrech, takže kusy na sebe
 * navazují bez švů.
 */
export type MapOverlay = (g: CanvasRenderingContext2D, W: number, H: number, box: MapBox) => void

/** Dokreslení zadaných výkresů, nebo `undefined`, když není co kreslit (export pak jede beze změny). */
export function mapOverlayFor(items: DrawOverlay[]): MapOverlay | undefined {
  if (!items.length) return undefined
  return (g, W, H, box) => { drawOverlayToCanvas(g, W, H, box, items) }
}

/**
 * Nakreslí výkresy do plátna. `box` je obálka plátna v S-JTSK (stejná, jakou dostaly dlaždice
 * mapy), `W`/`H` jeho rozměr v pixelech. Vrací, kolik prvků se opravdu nakreslilo — volající
 * z toho pozná, že výkres do vybraného území vůbec nezasahuje.
 */
export function drawOverlayToCanvas(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  box: MapBox,
  items: DrawOverlay[],
): number {
  const spanX = box.maxX - box.minX, spanY = box.maxY - box.minY
  if (!(spanX > 0 && spanY > 0)) return 0
  const mPerPx = spanX / W
  const lw = Math.max(LINE_MIN_PX, LINE_M / mPerPx)
  const dot = Math.max(1, DOT_M / mPerPx)
  const px = (x: number) => (x - box.minX) / spanX * W
  const py = (y: number) => (box.maxY - y) / spanY * H
  /** leží prvek vůbec v plátně? (velkorysá rezerva na tloušťku čáry a délku textu) */
  const near = (x: number, y: number, pad: number) => x > -pad && y > -pad && x < W + pad && y < H + pad

  let drawn = 0
  g.save()
  g.lineJoin = 'round'
  g.lineCap = 'round'
  g.lineWidth = lw
  for (const it of items) {
    g.globalAlpha = Math.max(0, Math.min(1, it.alpha))
    for (const p of it.prims) {
      if (it.hidden.has(p.layer)) continue

      if (p.kind === 'poly') {
        if (p.pts.length < 2) continue
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        g.strokeStyle = css(p.color)
        g.beginPath()
        for (let i = 0; i < p.pts.length; i++) {
          const [sx, sy] = it.toSjtsk(p.pts[i][0], p.pts[i][1])
          const X = px(sx), Y = py(sy)
          if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y)
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y
        }
        // Zahodí se jen polylinie, jejíž OBÁLKA s výřezem nemá nic společného. Nestačí hledat
        // vrchol uvnitř: dlouhá čára (silnice, hranice) přes výřez jen projde a export se skládá
        // po pruzích a dlaždicích, takže by v nich byly díry. Co obálkou projde navíc, ořízne plátno.
        const pad = lw * 4
        if (x1 > -pad && y1 > -pad && x0 < W + pad && y0 < H + pad) { g.stroke(); drawn++ }
        continue
      }

      if (p.kind === 'point') {
        const [sx, sy] = it.toSjtsk(p.pt[0], p.pt[1])
        const X = px(sx), Y = py(sy)
        if (!near(X, Y, dot * 2)) continue
        g.fillStyle = css(p.color)
        g.beginPath()
        g.arc(X, Y, dot, 0, Math.PI * 2)
        g.fill()
        drawn++
        continue
      }

      const size = p.height / mPerPx
      if (size < TEXT_MIN_PX || !p.text) continue
      const [sx, sy] = it.toSjtsk(p.pt[0], p.pt[1])
      const X = px(sx), Y = py(sy)
      if (!near(X, Y, size * p.text.length)) continue
      g.save()
      g.translate(X, Y)
      // `rot` je v radiánech proti směru hodin a v matematické ose y; plátno má y dolů,
      // takže se stejný úhel otáčí na druhou stranu.
      if (p.rot) g.rotate(-p.rot)
      g.fillStyle = css(p.color)
      g.font = `${size.toFixed(1)}px sans-serif`
      g.textAlign = p.hAlign === 0 ? 'left' : p.hAlign === 1 ? 'center' : 'right'
      g.textBaseline = p.vAlign === 0 ? 'alphabetic' : p.vAlign === 1 ? 'middle' : 'top'
      g.fillText(p.text, 0, 0)
      g.restore()
      drawn++
    }
  }
  g.restore()
  return drawn
}
