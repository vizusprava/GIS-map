import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import cesium from 'vite-plugin-cesium'
import path from 'path'

export default defineConfig(({ command }) => ({
  // RELATIVNÍ base pro build, ne '/GIS-map/'. Důvod je Cesium: vite-plugin-cesium kopíruje
  // svoje podklady do `outDir + CESIUM_BASE_URL`, takže absolutní base by je zahrabala do
  // dist/GIS-map/cesium/ — jinam, než na ně odkazuje index.html (= 404 na celé Cesium).
  // S './' vyjde CESIUM_BASE_URL na 'cesium/', kopie sedí, a build je navíc přenositelný:
  // funguje v kořeni domény i v libovolné podcestě (GitHub Pages /GIS-map/) bez překládání.
  // V dev serveru musí zůstat '/' — relativní base tam Vite stejně ignoruje.
  base: command === 'build' ? './' : '/',
  plugins: [react(), tailwindcss(), cesium()],
  resolve: {
    alias: {
      // jádro vieweru žije uvnitř projektu (vendorované z react-app/viewer-core) — žádné ../
      '@core': path.resolve(import.meta.dirname, 'src/viewer-core'),
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
}))
