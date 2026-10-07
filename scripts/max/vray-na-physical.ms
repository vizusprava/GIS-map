/*
  V-Ray -> Physical (jen barva a textura) — před exportem do glTF/GLB pro geo-studio.

  Real-Time Exporter v Maxu (File -> Export -> glTF) materiálům V-Ray nerozumí: místo nich
  zapíše černý „fallback Material" a textury vůbec nevyexportuje. Tenhle skript převede
  materiály V-Ray ve scéně na Physical Material, kterému exportér rozumí — s difuzní barvou
  a difuzní texturou. Lesk, odrazy, bump a ostatní kanály se zahodí (geo-studio je stejně
  nepoužívá, model kreslí matně jen s barevnou texturou).

  Postup:
    1. Scripting -> Run Script... -> vyber tenhle soubor (nebo ho přetáhni do viewportu).
    2. Potvrď dotaz — převedou se materiály na všech objektech ve scéně.
    3. Exportuj do .glb jako obvykle.
    4. Ctrl+Z (Edit -> Undo) vrátí materiály V-Ray zpátky. Pro jistotu ale pracuj na kopii
       scény nebo ji předtím ulož.

  Co umí: VRayMtl, VRayLightMtl, obaly s jedním materiálem uvnitř (VRayBlendMtl,
  VRay2SidedMtl, VRayOverrideMtl, VRayMtlWrapper — bere se základní / přední materiál),
  Multi/Sub-Object (převede každý podmateriál). Textura se hledá v difuzním kanálu i uvnitř
  zanořených map (Color Correction, Composite, Mix…) — použije se první nalezený obrázek
  (Bitmap, VRayBitmap/VRayHDRI). Ostatní materiály (Standard, Physical) zůstanou, jak jsou.

  Funkce jsou globální s předponou geoVray_ (rekurze u lokálních funkcí v bloku není spolehlivá).
*/

-- už převedené materiály (sdílené mezi objekty) -> jedna nová instance, ne kopie pro každý objekt
global geoVray_puvodni = #()
global geoVray_nove = #()
global geoVray_pocet = 0

-- jméno třídy jako text: skript tak jde spustit i bez nainstalovaného V-Ray
fn geoVray_trida obj = (classOf obj) as string

-- vlastnost materiálu, nebo náhradní hodnota, když ji tahle verze V-Ray nemá
fn geoVray_vlastnost obj jmeno nahradni = (
  if isProperty obj jmeno then (getProperty obj jmeno) else nahradni
)

-- první obrázek v mapě nebo v jejích podmapách (Bitmap, VRayBitmap, VRayHDRI)
fn geoVray_obrazek mapa = (
  local res = undefined
  if mapa != undefined do (
    local cls = geoVray_trida mapa
    if cls == "Bitmaptexture" then res = mapa
    else if cls == "VRayBitmap" or cls == "VRayHDRI" then (
      local soubor = try (mapa.HDRIMapName) catch undefined
      if soubor != undefined and soubor != "" do res = Bitmaptexture fileName:soubor name:mapa.name
    ) else (
      local pocetPodmap = try (getNumSubTexmaps mapa) catch 0
      local i = 1
      while res == undefined and i <= pocetPodmap do (
        local podmapa = try (getSubTexmap mapa i) catch undefined
        res = geoVray_obrazek podmapa
        i += 1
      )
    )
  )
  res
)

-- nový Physical Material jen s barvou a texturou (matný, ne kov)
fn geoVray_fyzikalni jmeno barva mapa = (
  local p = PhysicalMaterial name:jmeno
  p.base_color = barva
  p.roughness = 1.0
  p.metalness = 0.0
  p.reflectivity = 0.0
  local obr = geoVray_obrazek mapa
  if obr != undefined do (
    p.base_color_map = obr
    p.base_color_map_on = true
    try (showTextureMap p true) catch ()
  )
  geoVray_pocet += 1
  p
)

fn geoVray_prevod mat = (
  local vysledek = mat
  if mat != undefined do (
    local idx = findItem geoVray_puvodni mat
    if idx > 0 then vysledek = geoVray_nove[idx]
    else (
      local cls = geoVray_trida mat
      if cls == "Multimaterial" then (
        for i = 1 to mat.numsubs do mat.materialList[i] = geoVray_prevod mat.materialList[i]
      ) else if cls == "VRayMtl" then (
        local mapaD = if (geoVray_vlastnost mat #texmap_diffuse_on true) then (geoVray_vlastnost mat #texmap_diffuse undefined) else undefined
        vysledek = geoVray_fyzikalni mat.name (geoVray_vlastnost mat #diffuse (color 200 200 200)) mapaD
      ) else if cls == "VRayLightMtl" then (
        local mapaL = if (geoVray_vlastnost mat #texmap_on true) then (geoVray_vlastnost mat #texmap undefined) else undefined
        vysledek = geoVray_fyzikalni mat.name (geoVray_vlastnost mat #color (color 200 200 200)) mapaL
      ) else if cls == "VRayBlendMtl" or cls == "VRayOverrideMtl" or cls == "VRayMtlWrapper" then (
        local zaklad = geoVray_prevod (geoVray_vlastnost mat #baseMtl undefined)
        if zaklad != undefined do vysledek = zaklad
      ) else if cls == "VRay2SidedMtl" then (
        local predni = geoVray_prevod (geoVray_vlastnost mat #frontMtl undefined)
        if predni != undefined do vysledek = predni
      ) else if (matchPattern cls pattern:"VRay*") and (isProperty mat #diffuse) then (
        -- jiný materiál V-Ray s difuzní barvou (CarPaint, FastSSS…) — aspoň barva a textura
        vysledek = geoVray_fyzikalni mat.name mat.diffuse (geoVray_vlastnost mat #texmap_diffuse undefined)
      )
      append geoVray_puvodni mat
      append geoVray_nove vysledek
    )
  )
  vysledek
)

(
  geoVray_puvodni = #()
  geoVray_nove = #()
  geoVray_pocet = 0
  local objekty = for o in objects where o.material != undefined collect o
  if objekty.count == 0 then (
    messageBox "Ve scéně nejsou žádné objekty s materiálem." title:"V-Ray -> Physical"
  ) else (
    local otazka = "Převést materiály V-Ray na " + (objekty.count as string) + " objektech na Physical Material (jen barva a textura)?\n\nCtrl+Z je vrátí zpátky."
    local souhlas = queryBox otazka title:"V-Ray -> Physical"
    if souhlas do (
      undo "V-Ray -> Physical" on (
        for o in objekty do o.material = geoVray_prevod o.material
      )
      local hlaska = "Převedeno " + (geoVray_pocet as string) + " materiálů V-Ray na Physical Material.\n\nTeď exportuj do .glb (File -> Export -> glTF, Export glTF Binary).\nCtrl+Z vrátí materiály V-Ray."
      format "%\n" hlaska
      messageBox hlaska title:"V-Ray -> Physical"
    )
  )
)
