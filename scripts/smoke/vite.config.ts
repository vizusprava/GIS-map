// Build mapy pro kouřový test (scripts/smoke.mjs): stejná konfigurace jako appka, jen jiný vstup
// a absolutní `base` — stránka leží v podsložce, a s relativní cestou by Cesium hledalo své
// workery a assety vedle ní místo v kořeni buildu.
import { defineConfig, mergeConfig, type UserConfig } from 'vite'
import main from '../../vite.config'

export default defineConfig(env => mergeConfig((main as (e: typeof env) => UserConfig)(env), {
  base: '/',
  logLevel: 'warn',
  build: {
    rollupOptions: { input: 'scripts/smoke/index.html' },
    minify: false,
    chunkSizeWarningLimit: 100_000,
  },
}))
