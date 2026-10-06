/**
 * Pravý dolní roh mapy: kompas a nad ním minimapa (zavřená = malé tlačítko, kterým se vrátí).
 * Mimo střed s lištou, ať se s ní neperou o místo, když je okno úzké.
 */
import type * as Cesium from 'cesium'
import { LocateFixed } from 'lucide-react'
import { Compass } from './compass'
import { MiniMap, type MinimapPref } from './miniMap'

export function NavCorner({ viewer, mini, size }: {
  /** null, dokud mapa není */
  viewer: Cesium.Viewer | null
  mini: MinimapPref
  /** velikost minimapy v px (na úzké mapě menší) */
  size: number
}) {
  return (
    <>
      {/* Kompas: vlastní pozadí má kruhové v SVG, takže kolem něj není žádný rámeček navíc. */}
      <div className="pointer-events-none absolute bottom-5 right-4 z-20">
        <Compass viewer={viewer} />
      </div>
      {/* Minimapa nad kompasem (kompas končí ~92 px ode dna). Pod lištou (z-10), ať přes ni
          nabídky skupin, které se otvírají nahoru, na úzké mapě nezajedou. */}
      {viewer && (
        <div className="pointer-events-none absolute bottom-[104px] right-4 z-10">
          {mini.on ? (
            <MiniMap viewer={viewer} base={mini.base} onBase={mini.setBase} onClose={mini.toggle} size={size} />
          ) : (
            // zavřená minimapa: malé tlačítko nad kompasem, ať se dá vrátit i bez klávesy N
            <div className="flex w-16 justify-center">
              <button
                onClick={mini.toggle}
                title="Zobrazit minimapu (N)"
                data-minimap-open
                className="pointer-events-auto rounded-lg border border-gray-700 bg-gray-900/90 p-1.5 text-gray-300 shadow-lg hover:text-gray-100 pointer-coarse:p-2.5"
              ><LocateFixed size={16} /></button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
