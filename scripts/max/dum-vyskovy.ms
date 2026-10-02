/*------------------------------------------------------------------------------
	VÝŠKOVÁ BUDOVA - parametrický generátor pro 3ds Max
	---------------------------------------------------
	Velkoměstská věž: podnož (podium) s prosklenou vstupní halou, nad ní věž,
	která se po zadaném počtu podlaží ustupuje (setback), pásová okna nebo
	rastr, mezipásy, technologie a stožár na střeše.

	Create > Geometry > kategorie "Budovy" > Výšková budova, pak klik do pohledu.
	Rozměry v metrech. Potřebuje budovy-lib.ms a panelak.ms ve stejné složce.
------------------------------------------------------------------------------*/

(
	local vb_dir = ""
	try ( vb_dir = getFilenamePath (getSourceFileName()) ) catch ( vb_dir = "" )
	local vb_lib = vb_dir + "budovy-lib.ms"
	if vb_dir != "" and (doesFileExist vb_lib) then fileIn vb_lib
	else format "CHYBA: vedle dum-vyskovy.ms musí ležet budovy-lib.ms a panelak.ms\n"
)

global dumVyskovySetParam

plugin simpleObject DumVyskovyGeo
	name:"Výšková budova"
	classID:#(0x51ab33d3, 0x2d7f9113)
	category:"Budovy"
	version:1
(
	tool create
	(
		on mousePoint click do
		(
			nodeTM.translation = gridPoint
			#stop
		)
	)

	parameters pRozmery rollout:rMain
	(
		delka        type:#float   ui:spDelka    default:26.0
		sirka        type:#float   ui:spSirka    default:22.0
		podlazi      type:#integer ui:spPodlazi  default:24
		vyskaPodlazi type:#float   ui:spVyskaP   default:3.6
		tlSteny      type:#float   ui:spTlSteny  default:0.35
	)

	parameters pPodnoz rollout:rPodnoz
	(
		podnoz       type:#boolean ui:chkPodnoz  default:true
		podnozPatra  type:#integer ui:spPodnozP  default:2
		podnozPresah type:#float   ui:spPodnozR  default:4.0
		halaVyska    type:#float   ui:spHala     default:5.5
	)

	parameters pUstupy rollout:rUstupy
	(
		ustupy      type:#boolean ui:chkUstupy   default:true
		ustupPo     type:#integer ui:spUstupPo   default:8
		ustupHloubka type:#float  ui:spUstupH    default:1.6
	)

	parameters pFasada rollout:rFasada
	(
		typFasady  type:#integer ui:ddlTyp      default:1
		rozponOsy  type:#float   ui:spRozpon    default:1.8
		pasVyska   type:#float   ui:spPasV      default:2.3
		pasParapet type:#float   ui:spPasP      default:0.8
		oknoSirka  type:#float   ui:spOknoS     default:1.4
		sloupky    type:#boolean ui:chkSloupky  default:true
		mezipas    type:#boolean ui:chkMezipas  default:true
		rohSloup   type:#boolean ui:chkRoh      default:true
	)

	parameters pStrecha rollout:rStrecha
	(
		atikaVyska  type:#float   ui:spAtika    default:1.2
		technologie type:#boolean ui:chkTech    default:true
		stozar      type:#boolean ui:chkStozar  default:true
		stozarVyska type:#float   ui:spStozarV  default:12.0
	)

	parameters pMat rollout:rMat
	(
		mapovani   type:#boolean ui:chkMapovani default:true
		uvMeritko  type:#float   ui:spUV        default:1.0
		unitsPerM  type:#float   ui:spJednotky  default:1.0
		trubkaHran type:#integer ui:spHran      default:10
		seed       type:#integer ui:spSeed      default:1
		oknaSviti  type:#float   ui:spSviti     default:0.0
	)

	rollout rMain "Rozměry věže"
	(
		spinner spDelka "Délka (m):" type:#float range:[8,80,26] scale:0.25 fieldwidth:58
		slider  slDelka "" type:#float range:[8,80,26] ticks:0 width:150 offset:[0,-3]
		spinner spSirka "Hloubka (m):" type:#float range:[8,80,22] scale:0.25 fieldwidth:58
		slider  slSirka "" type:#float range:[8,80,22] ticks:0 width:150 offset:[0,-3]
		spinner spPodlazi "Podlaží věže:" type:#integer range:[3,80,24] fieldwidth:58
		slider  slPodlazi "" type:#integer range:[3,80,24] ticks:0 width:150 offset:[0,-3]
		spinner spVyskaP "Výška podlaží (m):" type:#float range:[2.6,6,3.6] scale:0.05 fieldwidth:58
		spinner spTlSteny "Tloušťka stěn (m):" type:#float range:[0.1,1,0.35] scale:0.01 fieldwidth:58

		on slDelka changed val do dumVyskovySetParam #delka val
		on slSirka changed val do dumVyskovySetParam #sirka val
		on slPodlazi changed val do dumVyskovySetParam #podlazi val
		on rMain open do
			try ( slDelka.value = delka; slSirka.value = sirka; slPodlazi.value = podlazi )
			catch ()
	)

	rollout rPodnoz "Podnož"
	(
		checkbox chkPodnoz "Podnož (podium)" checked:true
		spinner spPodnozP "Podlaží podnože:" type:#integer range:[1,6,2] fieldwidth:58
		spinner spPodnozR "Přesah podnože (m):" type:#float range:[0,15,4.0] scale:0.25 fieldwidth:58
		spinner spHala "Výška vstupní haly (m):" type:#float range:[3,12,5.5] scale:0.1 fieldwidth:58
	)

	rollout rUstupy "Ustupující patra"
	(
		checkbox chkUstupy "Věž se ustupuje" checked:true
		spinner spUstupPo "Ustoupit po N podlažích:" type:#integer range:[2,30,8] fieldwidth:58
		spinner spUstupH "Hloubka ustoupení (m):" type:#float range:[0.3,6,1.6] scale:0.1 fieldwidth:58
	)

	rollout rFasada "Fasáda"
	(
		dropdownlist ddlTyp "" width:160 selection:1 items:#("pásová okna", "rastr oken", "celoprosklená")
		spinner spRozpon "Rozteč sloupků (m):" type:#float range:[0.8,6,1.8] scale:0.1 fieldwidth:58
		spinner spPasV "Výška pásu / okna (m):" type:#float range:[0.8,5,2.3] scale:0.05 fieldwidth:58
		spinner spPasP "Parapet (m):" type:#float range:[0,2,0.8] scale:0.05 fieldwidth:58
		spinner spOknoS "Šířka okna v rastru (m):" type:#float range:[0.5,5,1.4] scale:0.05 fieldwidth:58
		checkbox chkSloupky "Svislé sloupky" checked:true
		checkbox chkMezipas "Mezipásy (parapetní panely)" checked:true
		checkbox chkRoh "Zvýrazněné rohové pilíře" checked:true
	)

	rollout rStrecha "Střecha"
	(
		spinner spAtika "Výška atiky (m):" type:#float range:[0,4,1.2] scale:0.1 fieldwidth:58
		checkbox chkTech "Technologie na střeše" checked:true
		checkbox chkStozar "Stožár" checked:true
		spinner spStozarV "Výška stožáru (m):" type:#float range:[2,40,12] scale:0.5 fieldwidth:58
	)

	rollout rMat "Materiál a mapování"
	(
		checkbox chkMapovani "Generovat UV mapování" checked:true
		spinner spUV "Velikost dlaždice UV (m):" type:#float range:[0.05,20,1.0] scale:0.1 fieldwidth:58
		spinner spJednotky "1 m = ... jednotek:" type:#float range:[0.0001,10000,1.0] scale:1 fieldwidth:58
		spinner spHran "Hran trubek:" type:#integer range:[4,16,10] fieldwidth:58
		spinner spSeed "Seed (číslo varianty):" type:#integer range:[0,999,1] fieldwidth:58
		spinner spSviti "Podíl svítících oken:" type:#float range:[0,1,0.0] scale:0.05 fieldwidth:58
		button btnMat "Vytvořit a přiřadit materiál" width:170 height:22 offset:[0,4]
		button btnPoly "Vytvořit Editable Poly (kopii)" width:170 height:22 offset:[0,3]

		on btnMat pressed do panelakMaterial()
		on btnPoly pressed do panelakToPoly()
	)

	on buildMesh do
	(
		local cx = pnl_ctx()
		cx.V = #(); cx.F = #(); cx.M = #(); cx.TV = #(); cx.TF = #(); cx.S = #()
		local U  = amax 0.0001 unitsPerM
		local uv = if mapovani then (amax 0.001 (uvMeritko * U)) else 0.0

		local L  = amax (6.0 * U) (delka * U)
		local W  = amax (6.0 * U) (sirka * U)
		local NF = amax 3 podlazi
		local fh = amax (2.5 * U) (vyskaPodlazi * U)
		local t  = amin (amax (0.1 * U) (tlSteny * U)) (amin (L * 0.15) (W * 0.15))
		local hala = amax (3.0 * U) (halaVyska * U)
		local hr = amax 4 trubkaHran

		local pn = if podnoz then (amax 1 podnozPatra) else 0
		local pres = if podnoz then (amax 0.0 (podnozPresah * U)) else 0.0
		local zPod = if podnoz then (hala + (pn - 1) * fh) else 0.0   -- horní hrana podnože

		/*--- podnož ---*/
		if podnoz do
		(
			local px0 = -L * 0.5 - pres
			local px1 = L * 0.5 + pres
			local py0 = -W * 0.5 - pres
			local py1 = W * 0.5 + pres
			-- prosklená hala: rám nahoře a dole, mezi tím sklo, svislé sloupky
			local band = 0.35 * U
			pnl_addBox cx px0 py0 (-0.3 * U) px1 py1 0 PNL_MAT_SOKL uv
			pnl_addBox cx px0 py0 0 px1 py1 band PNL_MAT_SOKL uv
			pnl_addBox cx px0 py0 (zPod - band) px1 py1 zPod PNL_MAT_STRECHA uv
			-- sklo haly po obvodu
			local gi = 0.12 * U
			pnl_addBox cx (px0 + gi) (py0 + gi) band (px1 - gi) (py0 + gi + 0.06 * U) (zPod - band) PNL_MAT_SKLO uv
			pnl_addBox cx (px0 + gi) (py1 - gi - 0.06 * U) band (px1 - gi) (py1 - gi) (zPod - band) PNL_MAT_SKLO uv
			pnl_addBox cx (px0 + gi) (py0 + gi) band (px0 + gi + 0.06 * U) (py1 - gi) (zPod - band) PNL_MAT_SKLO uv
			pnl_addBox cx (px1 - gi - 0.06 * U) (py0 + gi) band (px1 - gi) (py1 - gi) (zPod - band) PNL_MAT_SKLO uv
			-- sloupky haly
			local kn = amax 2 ((floor ((px1 - px0) / (3.0 * U))) as integer)
			for k = 0 to kn do
			(
				local sxp = px0 + (px1 - px0) * k / kn
				pnl_addPipe2 cx [sxp, py0 + gi, band] [sxp, py0 + gi, zPod - band] (0.09 * U) hr PNL_MAT_KLEMP uv
				pnl_addPipe2 cx [sxp, py1 - gi, band] [sxp, py1 - gi, zPod - band] (0.09 * U) hr PNL_MAT_KLEMP uv
			)
			-- mezipodlaží podnože
			for k = 1 to pn - 1 do
				pnl_addBox cx px0 py0 (hala + (k - 1) * fh - 0.15 * U) px1 py1 (hala + (k - 1) * fh) PNL_MAT_DESKA uv
		)

		/*--- věž po blocích mezi ustoupeními ---*/
		local uPo = if ustupy then (amax 2 ustupPo) else (NF + 1)
		local uH  = if ustupy then (amax 0.0 (ustupHloubka * U)) else 0.0
		local f = 1
		local blok = 0
		local zTop2 = zPod
		local bx0 = -L * 0.5, bx1 = L * 0.5
		local by0 = -W * 0.5, by1 = W * 0.5

		local par = amax 0.0 (pasParapet * U)
		local oh = amax (0.4 * U) (pasVyska * U)
		if par + oh > fh - 0.2 * U do oh = amax (0.3 * U) (fh - 0.2 * U - par)
		local gi2 = amin (0.12 * U) (t * 0.5)

		while f <= NF do
		(
			local doF = amin NF (f + uPo - 1)
			local zA = zPod + (f - 1) * fh
			local zB = zPod + doF * fh
			local sx = bx0 + blok * uH
			local sx2 = bx1 - blok * uH
			local sy = by0 + blok * uH
			local sy2 = by1 - blok * uH
			if sx2 - sx > 3.0 * U and sy2 - sy > 3.0 * U do
			(
				local bl = sx2 - sx
				local bw2 = sy2 - sy
				local nx = amax 1 ((floor (bl / (amax (0.8 * U) (rozponOsy * U)) + 0.5)) as integer)
				local ny = amax 1 ((floor (bw2 / (amax (0.8 * U) (rozponOsy * U)) + 0.5)) as integer)
				local dx = bl / nx
				local dy = bw2 / ny
				local rohS = if rohSloup then (amax (0.3 * U) (dx * 0.5)) else 0.0

				for ff = f to doF do
				(
					local zf = zPod + (ff - 1) * fh
					local zo1 = zf + par
					local zo2 = amin (zf + par + oh) (zf + fh - 0.1 * U)
					if typFasady == 3 do ( zo1 = zf + 0.12 * U; zo2 = zf + fh - 0.12 * U )

					-- parapetní / meziokenní pásy a sklo na všech čtyřech stranách
					-- přední a zadní
					pnl_addBox cx sx sy zf sx2 (sy + t) zo1 PNL_MAT_FASADA uv
					pnl_addBox cx sx (sy2 - t) zf sx2 sy2 zo1 PNL_MAT_FASADA uv
					pnl_addBox cx sx sy zo2 sx2 (sy + t) (zf + fh) PNL_MAT_FASADA uv
					pnl_addBox cx sx (sy2 - t) zo2 sx2 sy2 (zf + fh) PNL_MAT_FASADA uv
					-- boční
					pnl_addBox cx sx (sy + t) zf (sx + t) (sy2 - t) zo1 PNL_MAT_FASADA uv
					pnl_addBox cx (sx2 - t) (sy + t) zf sx2 (sy2 - t) zo1 PNL_MAT_FASADA uv
					pnl_addBox cx sx (sy + t) zo2 (sx + t) (sy2 - t) (zf + fh) PNL_MAT_FASADA uv
					pnl_addBox cx (sx2 - t) (sy + t) zo2 sx2 (sy2 - t) (zf + fh) PNL_MAT_FASADA uv

					local mg = pnl_skloMat [sx, sx2, zo1, zo2] oknaSviti (seed + ff)
					if typFasady == 2 then
					(
						-- rastr jednotlivých oken
						local ows = amin (oknoSirka * U) (dx - 0.3 * U)
						for k = 1 to nx do
						(
							local xc = sx + dx * (k - 0.5)
							pnl_addBox cx (xc - ows * 0.5) (sy + gi2) zo1 (xc + ows * 0.5) (sy + gi2 + 0.05 * U) zo2 mg uv
							pnl_addBox cx (xc - ows * 0.5) (sy2 - gi2 - 0.05 * U) zo1 (xc + ows * 0.5) (sy2 - gi2) zo2 mg uv
						)
						for k = 1 to ny do
						(
							local yc = sy + dy * (k - 0.5)
							pnl_addBox cx (sx + gi2) (yc - ows * 0.5) zo1 (sx + gi2 + 0.05 * U) (yc + ows * 0.5) zo2 mg uv
							pnl_addBox cx (sx2 - gi2 - 0.05 * U) (yc - ows * 0.5) zo1 (sx2 - gi2) (yc + ows * 0.5) zo2 mg uv
						)
						-- zbytek pásu vyplní fasáda
						pnl_addBox cx sx sy zo1 sx2 (sy + t * 0.45) zo2 PNL_MAT_FASADA uv
						pnl_addBox cx sx (sy2 - t * 0.45) zo1 sx2 sy2 zo2 PNL_MAT_FASADA uv
						pnl_addBox cx sx (sy + t * 0.45) zo1 (sx + t * 0.45) (sy2 - t * 0.45) zo2 PNL_MAT_FASADA uv
						pnl_addBox cx (sx2 - t * 0.45) (sy + t * 0.45) zo1 sx2 (sy2 - t * 0.45) zo2 PNL_MAT_FASADA uv
					)
					else
					(
						-- souvislý pás skla po obvodu
						pnl_addBox cx (sx + rohS) (sy + gi2) zo1 (sx2 - rohS) (sy + gi2 + 0.05 * U) zo2 mg uv
						pnl_addBox cx (sx + rohS) (sy2 - gi2 - 0.05 * U) zo1 (sx2 - rohS) (sy2 - gi2) zo2 mg uv
						pnl_addBox cx (sx + gi2) (sy + rohS) zo1 (sx + gi2 + 0.05 * U) (sy2 - rohS) zo2 mg uv
						pnl_addBox cx (sx2 - gi2 - 0.05 * U) (sy + rohS) zo1 (sx2 - gi2) (sy2 - rohS) zo2 mg uv
						if rohSloup do
						(
							pnl_addBox cx sx sy zo1 (sx + rohS) (sy + t) zo2 PNL_MAT_FASADA uv
							pnl_addBox cx (sx2 - rohS) sy zo1 sx2 (sy + t) zo2 PNL_MAT_FASADA uv
							pnl_addBox cx sx (sy2 - t) zo1 (sx + rohS) sy2 zo2 PNL_MAT_FASADA uv
							pnl_addBox cx (sx2 - rohS) (sy2 - t) zo1 sx2 sy2 zo2 PNL_MAT_FASADA uv
							pnl_addBox cx sx (sy + t) zo1 (sx + t) (sy + rohS) zo2 PNL_MAT_FASADA uv
							pnl_addBox cx sx (sy2 - rohS) zo1 (sx + t) (sy2 - t) zo2 PNL_MAT_FASADA uv
							pnl_addBox cx (sx2 - t) (sy + t) zo1 sx2 (sy + rohS) zo2 PNL_MAT_FASADA uv
							pnl_addBox cx (sx2 - t) (sy2 - rohS) zo1 sx2 (sy2 - t) zo2 PNL_MAT_FASADA uv
						)
					)

					-- svislé sloupky přes celé podlaží
					if sloupky do
					(
						local sl = 0.07 * U
						for k = 0 to nx do
						(
							local xc = sx + dx * k
							pnl_addBox cx (xc - sl) (sy - sl) zf (xc + sl) (sy + t) (zf + fh) PNL_MAT_KLEMP uv
							pnl_addBox cx (xc - sl) (sy2 - t) zf (xc + sl) (sy2 + sl) (zf + fh) PNL_MAT_KLEMP uv
						)
						for k = 0 to ny do
						(
							local yc = sy + dy * k
							pnl_addBox cx (sx - sl) (yc - sl) zf (sx + t) (yc + sl) (zf + fh) PNL_MAT_KLEMP uv
							pnl_addBox cx (sx2 - t) (yc - sl) zf (sx2 + sl) (yc + sl) (zf + fh) PNL_MAT_KLEMP uv
						)
					)
					-- mezipás v úrovni stropu
					if mezipas do
					(
						local mp = 0.06 * U
						pnl_addBox cx (sx - mp) (sy - mp) (zf + fh - 0.12 * U) (sx2 + mp) (sy + t) (zf + fh) BUD_MAT_RIMSA uv
						pnl_addBox cx (sx - mp) (sy2 - t) (zf + fh - 0.12 * U) (sx2 + mp) (sy2 + mp) (zf + fh) BUD_MAT_RIMSA uv
						pnl_addBox cx (sx - mp) (sy + t) (zf + fh - 0.12 * U) (sx + t) (sy2 - t) (zf + fh) BUD_MAT_RIMSA uv
						pnl_addBox cx (sx2 - t) (sy + t) (zf + fh - 0.12 * U) (sx2 + mp) (sy2 - t) (zf + fh) BUD_MAT_RIMSA uv
					)
					-- stropní deska
					pnl_addBox cx sx sy (zf + fh - 0.3 * U) sx2 sy2 (zf + fh) PNL_MAT_DESKA uv
				)
				zTop2 = zB
				bx0 = sx; bx1 = sx2; by0 = sy; by1 = sy2
			)
			f = doF + 1
			blok = blok + 1
		)

		/*--- střecha věže ---*/
		local av = amax 0.0 (atikaVyska * U)
		pnl_addBox cx bx0 by0 zTop2 bx1 by1 (zTop2 + 0.3 * U) PNL_MAT_STRECHA uv
		if av > 0.02 * U do
		(
			local zatik = zTop2 + 0.3 * U
			local zc = zatik + av
			local atk = amax (0.15 * U) (t * 0.6)
			pnl_addBox cx bx0 by0 zatik bx1 (by0 + atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx bx0 (by1 - atk) zatik bx1 by1 zc PNL_MAT_STRECHA uv
			pnl_addBox cx bx0 (by0 + atk) zatik (bx0 + atk) (by1 - atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx (bx1 - atk) (by0 + atk) zatik bx1 (by1 - atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx (bx0 - 0.08 * U) (by0 - 0.08 * U) zc (bx1 + 0.08 * U) (by0 + atk + 0.08 * U) (zc + 0.06 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (bx0 - 0.08 * U) (by1 - atk - 0.08 * U) zc (bx1 + 0.08 * U) (by1 + 0.08 * U) (zc + 0.06 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (bx0 - 0.08 * U) (by0 + atk) zc (bx0 + atk + 0.08 * U) (by1 - atk) (zc + 0.06 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (bx1 - atk - 0.08 * U) (by0 + atk) zc (bx1 + 0.08 * U) (by1 - atk) (zc + 0.06 * U) PNL_MAT_KLEMP uv
		)
		local zr4 = zTop2 + 0.3 * U
		if technologie do
		(
			local bl2 = bx1 - bx0
			local bw3 = by1 - by0
			pnl_addBox cx (bx0 + bl2 * 0.12) (by0 + bw3 * 0.15) zr4 (bx0 + bl2 * 0.45) (by0 + bw3 * 0.55) (zr4 + 3.2 * U) PNL_MAT_FASADA uv
			local nt = 4
			for k = 1 to nt do
			(
				local tx = bx0 + bl2 * (0.55 + 0.1 * (k - 1))
				local ty = by0 + bw3 * (0.3 + 0.35 * (pnl_hash (k * 3.7) 1.0 seed))
				local ts = 0.9 * U
				pnl_addBox cx (tx - ts * 0.5) (ty - ts * 0.5) zr4 (tx + ts * 0.5) (ty + ts * 0.5) (zr4 + 1.1 * U) PNL_MAT_KLEMP uv
			)
		)
		if stozar do
		(
			local sv2 = amax (1.0 * U) (stozarVyska * U)
			local mx = (bx0 + bx1) * 0.5
			local my = (by0 + by1) * 0.5
			pnl_addPipe2 cx [mx, my, zr4] [mx, my, zr4 + sv2] (0.1 * U) hr PNL_MAT_KLEMP uv
			pnl_addPipe2 cx [mx - 1.2 * U, my, zr4 + sv2 * 0.55] [mx + 1.2 * U, my, zr4 + sv2 * 0.55] (0.05 * U) hr PNL_MAT_KLEMP uv
			pnl_addPipe2 cx [mx, my - 1.0 * U, zr4 + sv2 * 0.75] [mx, my + 1.0 * U, zr4 + sv2 * 0.75] (0.05 * U) hr PNL_MAT_KLEMP uv
		)

		/*--- sestavení meshe ---*/
		if cx.V.count < 3 do pnl_addBox cx (-L * 0.5) (-W * 0.5) 0 (L * 0.5) (W * 0.5) (1.0 * U) PNL_MAT_FASADA uv
		local vc = cx.V.count
		local fc = cx.F.count
		setMesh mesh numVerts:vc numFaces:fc
		for i = 1 to vc do setVert mesh i cx.V[i]
		for i = 1 to fc do
		(
			setFace mesh i cx.F[i]
			setFaceMatID mesh i cx.M[i]
			setFaceSmoothGroup mesh i (if i <= cx.S.count then cx.S[i] else 0)
			if (mod i 2) > 0.5 then
			(
				setEdgeVis mesh i 1 true
				setEdgeVis mesh i 2 true
				setEdgeVis mesh i 3 false
			)
			else
			(
				setEdgeVis mesh i 1 false
				setEdgeVis mesh i 2 true
				setEdgeVis mesh i 3 true
			)
		)
		if uv > 0 and cx.TF.count == fc do
		(
			setNumTVerts mesh cx.TV.count
			buildTVFaces mesh
			if (getNumTVerts mesh) != cx.TV.count do setNumTVerts mesh cx.TV.count
			for i = 1 to cx.TV.count do setTVert mesh i cx.TV[i]
			for i = 1 to fc do setTVFace mesh i cx.TF[i]
		)
		update mesh
	)
)

fn dumVyskovySetParam pname val =
(
	for o in (selection as array) where (isKindOf o DumVyskovyGeo) do setProperty o pname val
	ok
)

macroScript DumVyskovyCreate
	category:"Budovy"
	buttonText:"Vyskova budova"
	tooltip:"Vytvorit parametrickou vyskovou budovu"
(
	on execute do
	(
		local dnode = DumVyskovyGeo name:(uniquename "VyskovaBudova")
		select dnode
		max modify mode
	)
)

format "\nVýšková budova: plugin načten. Create > Geometry > kategorie \"Budovy\".\n"
