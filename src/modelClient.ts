/**
 * Příprava 3D modelu mimo hlavní vlákno (worker v modelWorker.ts, mechanika ve workerClient.ts).
 * Co ve workeru nejde, doběhne na hlavním vlákně — model se načte vždycky, jen pomaleji.
 */
import { prepareModel, type PreparedModel } from './model3d'
import { workerClient } from './workerClient'

export type ModelRequest = { file: File; georef: boolean }

const run = workerClient<ModelRequest, PreparedModel>({
  create: () => new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module', name: 'modely' }),
  onMain: async ({ file, georef }) => prepareModel(file.name, await file.arrayBuffer(), georef),
  crashMessage: 'Zpracování modelu spadlo — nejspíš na něj nestačila paměť prohlížeče.',
  retryOnMain: true,
})

/**
 * Model připravený pro Cesium: převedený OBJ, georeferencovaný GLB z S-JTSK souřadnic
 * (`georef`) nebo jen změřený nejnižší bod — viz `prepareModel`.
 */
export function prepareModelFile(file: File, georef: boolean): Promise<PreparedModel> {
  return run({ file, georef })
}
