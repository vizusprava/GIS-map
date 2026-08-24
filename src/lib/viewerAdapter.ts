/**
 * Persistence 3D vieweru přes Supabase — implementace `ViewerAdapter` z jádra.
 *
 * Jádro vieweru o úložišti nic neví; dostane tenhle objekt propem a jen volá metody.
 * `modelId` je tady id řádku v `geo_assets` (nahraný model ve scéně), takže anotace,
 * vegetace, barvy i pohledy kamery přežijí i přenahrání souboru.
 *
 * Knihovna materiálů je OSOBNÍ (ne per scéna): materiál si nahraješ jednou a použiješ ho
 * kdekoliv. Textury leží v bucketu pod `{owner}/textures/{materialId}/`.
 */
import type { ViewerAdapter, MaterialDef, ObjectColorRecord, SavedView, SceneOrg, VegGroup, ViewerAnnotation } from '@core'
import { supabase, BUCKET } from './supabase'
import { signedUrl } from './storage'
import { useAuthStore } from '../stores/authStore'

/** Id přihlášeného uživatele — bez něj by RLS zápis odmítla, takže radši rovnou chyba. */
function ownerId(): string {
  const id = useAuthStore.getState().user?.id
  if (!id) throw new Error('Nejsi přihlášený — data se nedají uložit.')
  return id
}

export const supabaseViewerAdapter: ViewerAdapter = {
  async fetchObjectColors(modelId) {
    const { data, error } = await supabase.from('geo_object_colors').select('object_name, color').eq('asset_id', modelId)
    if (error) throw new Error(error.message)
    return (data ?? []) as ObjectColorRecord[]
  },

  async saveObjectColor(modelId, objectName, color) {
    const { error } = await supabase.from('geo_object_colors').upsert(
      { asset_id: modelId, object_name: objectName, color, owner: ownerId() },
      { onConflict: 'asset_id,object_name' },
    )
    if (error) throw new Error(error.message)
  },

  async fetchVegetation(modelId) {
    const { data, error } = await supabase.from('geo_vegetation').select('data').eq('asset_id', modelId).maybeSingle()
    if (error) throw new Error(error.message)
    return (data?.data ?? null) as VegGroup[] | null
  },

  async saveVegetation(modelId, groups) {
    const { error } = await supabase.from('geo_vegetation').upsert(
      { asset_id: modelId, data: groups, owner: ownerId() },
      { onConflict: 'asset_id' },
    )
    if (error) throw new Error(error.message)
  },

  async fetchAnnotations(modelId) {
    const { data, error } = await supabase.from('geo_annotations').select('*').eq('asset_id', modelId).order('created_at')
    if (error) throw new Error(error.message)
    return (data ?? []).map((r: Record<string, unknown>): ViewerAnnotation => ({
      id: r.id as string,
      x: r.x as number, y: r.y as number, z: r.z as number,
      text: r.text as string,
      object_name: (r.object_name as string | null) ?? null,
      offsetX: (r.offset_x as number | null) ?? 0,
      offsetY: (r.offset_y as number | null) ?? 0,
      extraPoints: (r.extra_points as { x: number; y: number; z: number }[] | null) ?? [],
      color: (r.color as string | null) ?? null,
    }))
  },

  async createAnnotation(modelId, annotation) {
    const { error } = await supabase.from('geo_annotations').insert({
      asset_id: modelId, owner: ownerId(),
      x: annotation.x, y: annotation.y, z: annotation.z,
      text: annotation.text, object_name: annotation.object_name,
    })
    if (error) throw new Error(error.message)
  },

  async deleteAnnotation(_modelId, id) {
    const { error } = await supabase.from('geo_annotations').delete().eq('id', id)
    if (error) throw new Error(error.message)
  },

  async updateAnnotationOffset(_modelId, id, offsetX, offsetY) {
    const { error } = await supabase.from('geo_annotations').update({ offset_x: offsetX, offset_y: offsetY }).eq('id', id)
    if (error) throw new Error(error.message)
  },

  async updateAnnotationPoints(_modelId, id, points) {
    const { error } = await supabase.from('geo_annotations').update({ extra_points: points }).eq('id', id)
    if (error) throw new Error(error.message)
  },

  async updateAnnotationColor(_modelId, id, color) {
    const { error } = await supabase.from('geo_annotations').update({ color }).eq('id', id)
    if (error) throw new Error(error.message)
  },

  async fetchSceneOrg(modelId) {
    const { data, error } = await supabase.from('geo_scene_org').select('data').eq('asset_id', modelId).maybeSingle()
    if (error) throw new Error(error.message)
    return (data?.data ?? null) as SceneOrg | null
  },

  async saveSceneOrg(modelId, org) {
    const { error } = await supabase.from('geo_scene_org').upsert(
      { asset_id: modelId, data: org, owner: ownerId() },
      { onConflict: 'asset_id' },
    )
    if (error) throw new Error(error.message)
  },

  async fetchViews(modelId) {
    const { data, error } = await supabase.from('geo_model_views').select('*').eq('asset_id', modelId)
      .order('sort_order').order('created_at')
    if (error) throw new Error(error.message)
    return (data ?? []).map((r: Record<string, unknown>): SavedView => ({
      id: r.id as string,
      name: r.name as string,
      camera: r.camera as SavedView['camera'],
      annotationIds: (r.annotation_ids as string[] | null) ?? [],
    }))
  },

  async createView(modelId, view) {
    // `sort_order` = čas vzniku → nový pohled jde na konec; reorder ho pak přepíše na 0..n
    const { error } = await supabase.from('geo_model_views').insert({
      id: view.id, asset_id: modelId, owner: ownerId(), name: view.name,
      camera: view.camera, annotation_ids: view.annotationIds ?? [], sort_order: Date.now(),
    })
    if (error) throw new Error(error.message)
  },

  async deleteView(_modelId, viewId) {
    const { error } = await supabase.from('geo_model_views').delete().eq('id', viewId)
    if (error) throw new Error(error.message)
  },

  async renameView(_modelId, viewId, name) {
    const { error } = await supabase.from('geo_model_views').update({ name }).eq('id', viewId)
    if (error) throw new Error(error.message)
  },

  async updateViewCamera(_modelId, viewId, camera) {
    const { error } = await supabase.from('geo_model_views').update({ camera }).eq('id', viewId)
    if (error) throw new Error(error.message)
  },

  async reorderViews(_modelId, orderedIds) {
    const results = await Promise.all(orderedIds.map((id, i) =>
      supabase.from('geo_model_views').update({ sort_order: i }).eq('id', id)))
    const failed = results.find(r => r.error)
    if (failed?.error) throw new Error(failed.error.message)
  },

  async updateViewAnnotations(_modelId, viewId, annotationIds) {
    const { error } = await supabase.from('geo_model_views').update({ annotation_ids: annotationIds }).eq('id', viewId)
    if (error) throw new Error(error.message)
  },

  async fetchMaterials() {
    const { data, error } = await supabase.from('geo_materials').select('id, data').order('updated_at')
    if (error) throw new Error(error.message)
    return (data ?? []).map((r: Record<string, unknown>) => ({ ...(r.data as MaterialDef), id: r.id as string }))
  },

  async saveMaterial(material) {
    const { error } = await supabase.from('geo_materials').upsert(
      { id: material.id, data: material, owner: ownerId() },
      { onConflict: 'id' },
    )
    if (error) throw new Error(error.message)
  },

  async deleteMaterial(materialId) {
    const dir = `${ownerId()}/textures/${materialId}`
    const { data: files } = await supabase.storage.from(BUCKET).list(dir)
    if (files?.length) await supabase.storage.from(BUCKET).remove(files.map(f => `${dir}/${f.name}`))
    const { error } = await supabase.from('geo_materials').delete().eq('id', materialId)
    if (error) throw new Error(error.message)
  },

  async uploadTexture(materialId, mapType, data, ext) {
    // čas v názvu → přepsaná textura dostane novou cestu a nezůstane viset v cache prohlížeče
    const path = `${ownerId()}/textures/${materialId}/${mapType}_${Date.now()}.${ext}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, data, {
      contentType: data.type || 'application/octet-stream',
    })
    if (error) throw new Error(error.message)
    return path
  },

  async getTextureUrl(path) {
    return signedUrl(path)
  },
}
