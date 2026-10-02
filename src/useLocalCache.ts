/**
 * Co leží na disku prohlížeče: cache dlaždic terénu a mapy (IndexedDB) a „lokální mapa"
 * napečeného ortofota. Čistě pro patičku panelu a pro úklid — mapa jede i bez toho.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { cacheStats, bakedAllKeys, bakedClear, bakedDeletePrefix } from './cache'
import { bakedKeys, LEGACY_BAKED_PREFIX } from './imagery'

export type LocalCache = ReturnType<typeof useLocalCache>

export function useLocalCache(deps: {
  /** po smazání napečené mapy se vrstva ortofota postaví znovu, ať se bere ze sítě */
  refreshOrtoLayer: () => void
}) {
  const { refreshOrtoLayer } = deps

  // trvalá cache dlaždic (IndexedDB) — stav pro UI
  const [cacheInfo, setCacheInfo] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 })
  // Stejná čísla se do stavu nezapisují: nový objekt by pokaždé překreslil celý MapView,
  // i když se v patičce nic nezmění.
  const refreshCache = () => {
    cacheStats()
      .then(s => setCacheInfo(p => (p.count === s.count && p.bytes === s.bytes ? p : s)))
      .catch(() => {})
  }

  // Patička s velikostí cache je jen orientační — deset vteřin zpoždění nikomu nevadí.
  useEffect(() => { refreshCache(); const id = setInterval(refreshCache, 10_000); return () => clearInterval(id) }, [])
  // „Lokální mapa" = dlaždicová pyramida napečená do IndexedDB (store BAKED). `bakedInfo` = počet
  // dlaždic (pro UI). Při startu načteme klíče do `bakedKeys`, ať je requestImage bere lokálně.
  const [bakedInfo, setBakedInfo] = useState(0)

  useEffect(() => {
    bakedAllKeys().then(ks => {
      // Lokální mapa napečená dřív přes WMS má jinou mřížku dlaždic, než jakou teď jede zobrazení
      // (cache ORTOFOTO_WM) — přepočítat se nedá, jen by zabírala místo. Uklidí se a řekne se to.
      const legacy = ks.filter(k => k.startsWith(LEGACY_BAKED_PREFIX))
      if (legacy.length) {
        void bakedDeletePrefix(LEGACY_BAKED_PREFIX)
        toast.info(`Lokální mapa ortofota (${legacy.length} dlaždic) byla ve starém formátu a smazala se. Mapa teď jede z rychlejší cache ČÚZK; napéct ji jde znovu tlačítkem „Načíst 2D lokálně".`, { duration: 12000 })
      }
      ks.forEach(k => { if (!k.startsWith(LEGACY_BAKED_PREFIX)) bakedKeys.add(k) })
      setBakedInfo(bakedKeys.size)
    }).catch(() => {})
  }, [])

  // Smaže celou lokální mapu (napečené dlaždice) → zpět na živé ČÚZK.
  function clearBaked() {
    bakedClear().then(() => { bakedKeys.clear(); setBakedInfo(0); refreshOrtoLayer() }).catch(() => {})
  }

  return {
    bakedInfo,
    cacheInfo,
    clearBaked,
    refreshCache,
    setBakedInfo,
  }
}
