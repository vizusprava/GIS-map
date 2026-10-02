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
  // `rebuildCesium`: Cesium se zabalí do bundlu jako obyčejný modul, místo aby ho plugin vložil
  // do <head> jako blokující <script> (5,8 MB). Tím se dá oddělit do chunku mapy, který se
  // stáhne až při otevření scény — přihlášení ani přehled scén na něj nečekají.
  // Workers/Assets/Widgets plugin kopíruje do `cesium/` dál stejně; CESIUM_BASE_URL nastaví sám.
  plugins: [react(), tailwindcss(), cesium({ rebuildCesium: true })],
  // Worker na výkresy (drawingWorker.ts) si DWG převodník natahuje dynamickým importem —
  // to umí jen modulový worker, výchozí IIFE by ho nerozdělil.
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
}))
