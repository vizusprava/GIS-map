/*------------------------------------------------------------------------------
	MODERNÍ BYTOVÝ DŮM - parametrický generátor pro 3ds Max
	-------------------------------------------------------
	Novostavba: plochá střecha, velká okna, zapuštěné lodžie nebo vystouplé
	balkony se skleněným zábradlím, volitelný obchodní parter v přízemí
	a ustoupené poslední podlaží s terasou.

	Create > Geometry > kategorie "Budovy" > Moderní bytový dům, klik do pohledu.
	Rozměry v metrech. Potřebuje budovy-lib.ms a panelak.ms ve stejné složce.
------------------------------------------------------------------------------*/

(
	local mb_dir = ""
	try ( mb_dir = getFilenamePath (getSourceFileName()) ) catch ( mb_dir = "" )
	local mb_lib = mb_dir + "budovy-lib.ms"
	if mb_dir != "" and (doesFileExist mb_lib) then fileIn mb_lib
	else format "CHYBA: vedle dum-moderni.ms musí ležet budovy-lib.ms a panelak.ms\n"
)

global dumModerniSetParam

plugin simpleObject DumModerniGeo
	name:"Moderní bytový dům"
	classID:#(0x51ab33d4, 0x2d7f9114)
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
		delka        type:#float   ui:spDelka    default:30.0
		sirka        type:#float   ui:spSirka    default:15.0
		podlazi      type:#integer ui:spPodlazi  default:6
		vyskaPodlazi type:#float   ui:spVyskaP   default:3.0
		tlSteny      type:#float   ui:spTlSteny  default:0.35
	)

	parameters pParter rollout:rParter
	(
		obchodniParter type:#boolean ui:chkParter  default:true
		parterVyska    type:#float   ui:spParterV  default:3.9
		pocetObchodu   type:#integer ui:spObchodu  default:3
		vchodSirka     type:#float   ui:spVchodS   default:2.0
	)

	parameters pLodzie rollout:rLodzie
	(
		typLodzie    type:#integer ui:ddlTyp      default:1
		lodzieKrok   type:#integer ui:spKrok      default:1
		lodzieOd     type:#integer ui:spOd        default:1
		lodzieHloubka type:#float  ui:spHloubka   default:1.8
		lodzieSirka  type:#float   ui:spSirka2    default:4.2
		zabradliVyska type:#float  ui:spZabrV     default:1.1
		skleneneZabradli type:#boolean ui:chkSklo default:true
		deleniPole   type:#boolean ui:chkDeleni   default:true
	)

	parameters pFasada rollout:rFasada
	(
		rozponOsy  type:#float   ui:spRozpon    default:3.4
		oknoSirka  type:#float   ui:spOknoS     default:2.4
		oknoVyska  type:#float   ui:spOknoV     default:2.1
		parapet    type:#float   ui:spParapet   default:0.45
		oknoDeleni type:#integer ui:spDeleni    default:2
		ustupTop   type:#boolean ui:chkUstup    default:true
		ustupHl    type:#float   ui:spUstupH    default:2.2
		atikaVyska type:#float   ui:spAtika     default:0.6
	)

	parameters pMat rollout:rMat
	(
		mapovani   type:#boolean ui:chkMapovani default:true
		uvMeritko  type:#float   ui:spUV        default:1.0
		unitsPerM  type:#float   ui:spJednotky  default:1.0
		trubkaHran type:#integer ui:spHran      default:8
		seed       type:#integer ui:spSeed      default:1
		oknaSviti  type:#float   ui:spSviti     default:0.0
	)

	rollout rMain "Rozměry domu"
	(
		spinner spDelka "Délka (m):" type:#float range:[8,120,30] scale:0.25 fieldwidth:58
		slider  slDelka "" type:#float range:[8,120,30] ticks:0 width:150 offset:[0,-3]
		spinner spSirka "Hloubka (m):" type:#float range:[6,40,15] scale:0.25 fieldwidth:58
		slider  slSirka "" type:#float range:[6,40,15] ticks:0 width:150 offset:[0,-3]
		spinner spPodlazi "Bytových podlaží:" type:#integer range:[1,20,6] fieldwidth:58
		slider  slPodlazi "" type:#integer range:[1,20,6] ticks:0 width:150 offset:[0,-3]
		spinner spVyskaP "Výška podlaží (m):" type:#float range:[2.4,5,3.0] scale:0.05 fieldwidth:58
		spinner spTlSteny "Tloušťka stěn (m):" type:#float range:[0.1,1,0.35] scale:0.01 fieldwidth:58

		on slDelka changed val do dumModerniSetParam #delka val
		on slSirka changed val do dumModerniSetParam #sirka val
		on slPodlazi changed val do dumModerniSetParam #podlazi val
		on rMain open do
			try ( slDelka.value = delka; slSirka.value = sirka; slPodlazi.value = podlazi )
			catch ()
	)

	rollout rParter "Parter"
	(
		checkbox chkParter "Obchodní parter v přízemí" checked:true
		spinner spParterV "Výška parteru (m):" type:#float range:[2.6,7,3.9] scale:0.1 fieldwidth:58
		spinner spObchodu "Počet obchodů:" type:#integer range:[1,10,3] fieldwidth:58
		spinner spVchodS "Šířka vchodu (m):" type:#float range:[1,5,2.0] scale:0.05 fieldwidth:58
		label lbP "Bez parteru začínají byty hned." offset:[0,2]
	)

	rollout rLodzie "Lodžie a balkony"
	(
		dropdownlist ddlTyp "" width:160 selection:1 \
			items:#("zapuštěné lodžie", "vystouplé balkony", "bez lodžií")
		spinner spKrok "Na každé N-té ose:" type:#integer range:[1,6,1] fieldwidth:58
		spinner spOd "Od podlaží č.:" type:#integer range:[1,20,1] fieldwidth:58
		spinner spHloubka "Hloubka (m):" type:#float range:[0.8,4,1.8] scale:0.05 fieldwidth:58
		slider  slHloubka "" type:#float range:[0.8,4,1.8] ticks:0 width:150 offset:[0,-3]
		spinner spSirka2 "Šířka (m):" type:#float range:[1.5,12,4.2] scale:0.1 fieldwidth:58
		spinner spZabrV "Výška zábradlí (m):" type:#float range:[0.8,1.5,1.1] scale:0.05 fieldwidth:58
		checkbox chkSklo "Skleněné zábradlí" checked:true
		checkbox chkDeleni "Dělicí stěny mezi lodžiemi" checked:true

		on slHloubka changed val do dumModerniSetParam #lodzieHloubka val
		on rLodzie open do try (slHloubka.value = lodzieHloubka) catch ()
	)

	rollout rFasada "Fasáda"
	(
		spinner spRozpon "Rozteč os (m):" type:#float range:[1.5,10,3.4] scale:0.1 fieldwidth:58
		spinner spOknoS "Šířka okna (m):" type:#float range:[0.6,6,2.4] scale:0.05 fieldwidth:58
		spinner spOknoV "Výška okna (m):" type:#float range:[0.8,4,2.1] scale:0.05 fieldwidth:58
		spinner spParapet "Parapet (m):" type:#float range:[0,2,0.45] scale:0.05 fieldwidth:58
		spinner spDeleni "Křídel v okně:" type:#integer range:[1,4,2] fieldwidth:58
		checkbox chkUstup "Ustoupené poslední podlaží" checked:true
		spinner spUstupH "Ustoupení (m):" type:#float range:[0.5,6,2.2] scale:0.1 fieldwidth:58
		spinner spAtika "Výška atiky (m):" type:#float range:[0,2,0.6] scale:0.05 fieldwidth:58
	)

	rollout rMat "Materiál a mapování"
	(
		checkbox chkMapovani "Generovat UV mapování" checked:true
		spinner spUV "Velikost dlaždice UV (m):" type:#float range:[0.05,20,1.0] scale:0.1 fieldwidth:58
		spinner spJednotky "1 m = ... jednotek:" type:#float range:[0.0001,10000,1.0] scale:1 fieldwidth:58
		spinner spHran "Hran trubek:" type:#integer range:[4,16,8] fieldwidth:58
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
		local NF = amax 1 podlazi
		local fh = amax (2.2 * U) (vyskaPodlazi * U)
		local t  = amin (amax (0.1 * U) (tlSteny * U)) (amin (L * 0.15) (W * 0.15))
		local hr = amax 4 trubkaHran
		local pv = if obchodniParter then (amax (2.4 * U) (parterVyska * U)) else 0.0

		local x0 = -L * 0.5, x1 = L * 0.5
		local y0 = -W * 0.5, y1 = W * 0.5
		local ze = pv + NF * fh

		local n = amax 1 ((floor (L / (amax (1.2 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepX = L / n
		local AX = for i = 1 to n collect (x0 + stepX * (i - 0.5))
		local oh = amin (amax (0.4 * U) (oknoVyska * U)) (fh - 0.35 * U)
		local ow = amin (amax (0.4 * U) (oknoSirka * U)) (stepX - 0.4 * U)
		local par = amax 0.0 (amin (parapet * U) (fh - oh - 0.2 * U))

		local nY = amax 1 ((floor (W / (amax (1.2 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepY = W / nY
		local AY = for i = 1 to nY collect (y0 + stepY * (i - 0.5))
		local owY = amin ow (stepY - 0.4 * U)

		local fw = 0.06 * U
		local ins = amin (0.1 * U) (t - fw * 1.2)
		if ins < 0.0 do ins = 0.0

		local det = pnl_det()
		det.U = U
		det.ramy = true
		det.ram = fw
		det.zapusteni = ins
		det.deleni = amax 1 oknoDeleni
		det.nadsvetlik = false
		det.nadsvetlikV = 0.4 * U
		det.parapetPlech = true
		det.parapetTl = 0.03 * U
		det.parapetPresah = 0.05 * U
		det.balkonParapet = par
		det.dverKridla = 2
		det.dverNadsvetlik = true
		det.dverNadsvetlikV = 0.6 * U

		-- které osy mají lodžii
		local lkrok = amax 1 lodzieKrok
		local lod = for i = 1 to n where (mod (i - 1) lkrok) < 0.5 collect i
		local lodOd = amax 1 lodzieOd
		local lodD = amax (0.5 * U) (lodzieHloubka * U)
		local lodS = amin (amax (1.0 * U) (lodzieSirka * U)) (stepX - 0.1 * U)
		local zv = amax (0.6 * U) (zabradliVyska * U)
		-- ustoupené poslední podlaží
		local ust = if ustupTop and NF > 1 then (amax 0.0 (ustupHl * U)) else 0.0
		local uy0 = y0 + ust

		/*--- PARTER ---*/
		if obchodniParter do
		(
			local nob = amax 1 pocetObchodu
			local vchS = amin (vchodSirka * U) (L / (nob + 1) - 0.4 * U)
			local xvch = x0 + L / (nob + 1) * 0.5
			local opsP = #()
			local kndP = #()
			if vchS > 0.8 * U do
			(
				append opsP [ xvch - vchS * 0.5, xvch + vchS * 0.5, 0, amin (2.7 * U) (pv - 0.5 * U) ]
				append kndP 3
			)
			local pil = amax (0.35 * U) (L * 0.015)
			for k = 1 to nob do
			(
				local sa = x0 + (L / (nob + 1)) * k
				local sb = if k == nob then x1 else (sa + L / (nob + 1))
				local ga = sa + pil * 0.5
				local gb = sb - pil * 0.5
				if gb - ga > 0.8 * U do
				(
					append opsP [ ga, gb, 0.25 * U, pv - 0.45 * U ]
					append kndP 1
				)
			)
			local PR = pnl_wallRects x0 x1 0 pv opsP
			for r in PR do pnl_addBox cx r.x y0 r.z r.y (y0 + t) r.w PNL_MAT_SOKL uv
			pnl_addBox cx x0 (y1 - t) 0 x1 y1 pv PNL_MAT_SOKL uv
			pnl_addBox cx x0 (y0 + t) 0 (x0 + t) (y1 - t) pv PNL_MAT_SOKL uv
			pnl_addBox cx (x1 - t) (y0 + t) 0 x1 (y1 - t) pv PNL_MAT_SOKL uv
			for j = 1 to opsP.count do
				pnl_fillOpening cx opsP[j] kndP[j] true y0 1.0 det PNL_MAT_SKLO uv
			-- výrazná deska nad parterem
			pnl_addBox cx (x0 - 0.25 * U) (y0 - 0.25 * U) (pv - 0.35 * U) (x1 + 0.25 * U) (y1 + 0.25 * U) pv BUD_MAT_RIMSA uv
		)
		pnl_addBox cx x0 y0 (-0.3 * U) x1 y1 (amax (0.05 * U) pv * 0.0 + 0.0) PNL_MAT_SOKL uv

		/*--- otvory bytových podlaží ---*/
		local opsF = #()
		local kndF = #()
		for f = 1 to NF do
		(
			local zf = pv + (f - 1) * fh
			for i = 1 to n do
			(
				local maLod = (typLodzie != 3) and f >= lodOd and (findItem lod i) > 0
				if maLod then
				(
					append opsF [ AX[i] - ow * 0.5, AX[i] + ow * 0.5, zf + 0.06 * U, zf + par + oh ]
					append kndF 2
				)
				else
				(
					append opsF [ AX[i] - ow * 0.5, AX[i] + ow * 0.5, zf + par, zf + par + oh ]
					append kndF 1
				)
			)
		)
		local opsB = bud_oknaGrid AX ow pv fh 1 NF par oh
		local opsG = bud_oknaGrid AY owY pv fh 1 NF par oh

		/*--- stěny bytových podlaží ---*/
		local zTopL = if ust > 0.01 then (pv + (NF - 1) * fh) else ze
		local R = pnl_wallRects x0 x1 pv zTopL opsF
		for r in R do pnl_addBox cx r.x y0 r.z r.y (y0 + t) r.w PNL_MAT_FASADA uv
		R = pnl_wallRects x0 x1 pv ze opsB
		for r in R do pnl_addBox cx r.x (y1 - t) r.z r.y y1 r.w PNL_MAT_FASADA uv
		R = pnl_wallRects (y0 + t) (y1 - t) pv zTopL opsG
		for r in R do
		(
			pnl_addBox cx x0 r.x r.z (x0 + t) r.y r.w PNL_MAT_FASADA uv
			pnl_addBox cx (x1 - t) r.x r.z x1 r.y r.w PNL_MAT_FASADA uv
		)
		-- ustoupené poslední podlaží: přední stěna posunutá dozadu + terasa
		if ust > 0.01 do
		(
			local zu = pv + (NF - 1) * fh
			local opsU = #()
			for i = 1 to n do append opsU [ AX[i] - ow * 0.5, AX[i] + ow * 0.5, zu + 0.06 * U, zu + par + oh ]
			local RU2 = pnl_wallRects x0 x1 zu ze opsU
			for r in RU2 do pnl_addBox cx r.x uy0 r.z r.y (uy0 + t) r.w PNL_MAT_FASADA uv
			for r in (pnl_wallRects (uy0 + t) (y1 - t) zu ze #()) do
			(
				pnl_addBox cx x0 r.x r.z (x0 + t) r.y r.w PNL_MAT_FASADA uv
				pnl_addBox cx (x1 - t) r.x r.z x1 r.y r.w PNL_MAT_FASADA uv
			)
			for o in opsU do pnl_fillOpening cx o 2 true uy0 1.0 det PNL_MAT_SKLO uv
			-- podlaha terasy a zábradlí
			pnl_addBox cx x0 y0 (zu - 0.25 * U) x1 uy0 zu BUD_MAT_RIMSA uv
			if skleneneZabradli then
				pnl_addBox cx x0 (y0 + 0.05 * U) zu x1 (y0 + 0.1 * U) (zu + zv) PNL_MAT_SKLO uv
			else
				for q = 0 to ((floor (L / (1.2 * U))) as integer) do
				(
					local qx = x0 + 1.2 * U * q
					if qx < x1 do pnl_addPipe2 cx [qx, y0 + 0.08 * U, zu] [qx, y0 + 0.08 * U, zu + zv] (0.025 * U) hr PNL_MAT_ZABRADLI uv
				)
			pnl_addPipe2 cx [x0, y0 + 0.08 * U, zu + zv] [x1, y0 + 0.08 * U, zu + zv] (0.03 * U) hr PNL_MAT_ZABRADLI uv
		)
		pnl_addBox cx x0 (if ust > 0.01 then uy0 else y0) (ze - 0.3 * U) x1 y1 ze PNL_MAT_DESKA uv

		/*--- výplně otvorů ---*/
		for j = 1 to opsF.count do
		(
			local mg = pnl_skloMat opsF[j] oknaSviti seed
			if opsF[j].w <= zTopL + 0.01 do
				pnl_fillOpening cx opsF[j] kndF[j] true y0 1.0 det mg uv
		)
		for o in opsB do pnl_fillOpening cx o 1 true y1 (-1.0) det (pnl_skloMat o oknaSviti (seed + 5)) uv
		for o in opsG do
			if o.w <= zTopL + 0.01 do
			(
				pnl_fillOpening cx o 1 false x0 1.0 det (pnl_skloMat o oknaSviti (seed + 9)) uv
				pnl_fillOpening cx o 1 false x1 (-1.0) det (pnl_skloMat o oknaSviti (seed + 13)) uv
			)

		/*--- lodžie / balkony ---*/
		if typLodzie != 3 do
			for f = lodOd to NF do
			(
				local zf = pv + (f - 1) * fh
				if zf + fh <= zTopL + 0.01 do
					for i in lod do
					(
						local xc = AX[i]
						local la = xc - lodS * 0.5
						local lb = xc + lodS * 0.5
						local ly0 = 0.0
						local ly1 = 0.0
						if typLodzie == 1 then
						(
							-- zapuštěná lodžie: výřez do hmoty, strop a boky
							ly0 = y0
							ly1 = y0 + lodD
							pnl_addBox cx la ly0 (zf - 0.2 * U) lb ly1 zf BUD_MAT_RIMSA uv
							pnl_addBox cx la (ly0 + t) zf (la + t) ly1 (zf + fh) PNL_MAT_FASADA uv
							pnl_addBox cx (lb - t) (ly0 + t) zf lb ly1 (zf + fh) PNL_MAT_FASADA uv
							pnl_addBox cx la ly0 (zf + fh - 0.25 * U) lb ly1 (zf + fh) BUD_MAT_RIMSA uv
						)
						else
						(
							-- vystouplý balkon
							ly0 = y0 - lodD
							ly1 = y0 + 0.1 * U
							pnl_addBox cx la ly0 (zf - 0.22 * U) lb ly1 zf BUD_MAT_RIMSA uv
						)
						-- zábradlí
						local zg = zf + zv
						if skleneneZabradli then
						(
							pnl_addBox cx la (ly0 + 0.04 * U) (zf + 0.05 * U) lb (ly0 + 0.09 * U) zg PNL_MAT_SKLO uv
							if typLodzie == 2 do
							(
								pnl_addBox cx (la + 0.04 * U) ly0 (zf + 0.05 * U) (la + 0.09 * U) ly1 zg PNL_MAT_SKLO uv
								pnl_addBox cx (lb - 0.09 * U) ly0 (zf + 0.05 * U) (lb - 0.04 * U) ly1 zg PNL_MAT_SKLO uv
							)
							pnl_addPipe2 cx [la, ly0 + 0.065 * U, zg] [lb, ly0 + 0.065 * U, zg] (0.028 * U) hr PNL_MAT_ZABRADLI uv
						)
						else
						(
							local nb2 = amax 3 ((floor (lodS / (0.13 * U))) as integer)
							for q = 0 to nb2 do
							(
								local qx = la + lodS * q / nb2
								pnl_addPipe2 cx [qx, ly0 + 0.06 * U, zf] [qx, ly0 + 0.06 * U, zg] (0.015 * U) hr PNL_MAT_ZABRADLI uv
							)
							pnl_addPipe2 cx [la, ly0 + 0.06 * U, zg] [lb, ly0 + 0.06 * U, zg] (0.028 * U) hr PNL_MAT_ZABRADLI uv
						)
						-- dělicí stěna mezi sousedy
						if deleniPole and typLodzie == 2 do
							pnl_addBox cx (lb - 0.06 * U) ly0 zf lb ly1 zg PNL_MAT_FASADA uv
					)
			)

		/*--- atika ---*/
		local av = amax 0.0 (atikaVyska * U)
		local ay0 = if ust > 0.01 then uy0 else y0
		pnl_addBox cx x0 ay0 ze x1 y1 (ze + 0.25 * U) PNL_MAT_STRECHA uv
		if av > 0.02 * U do
		(
			local za = ze + 0.25 * U
			local zc = za + av
			local atk = amax (0.12 * U) (t * 0.5)
			pnl_addBox cx x0 ay0 za x1 (ay0 + atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx x0 (y1 - atk) za x1 y1 zc PNL_MAT_STRECHA uv
			pnl_addBox cx x0 (ay0 + atk) za (x0 + atk) (y1 - atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx (x1 - atk) (ay0 + atk) za x1 (y1 - atk) zc PNL_MAT_STRECHA uv
			pnl_addBox cx (x0 - 0.07 * U) (ay0 - 0.07 * U) zc (x1 + 0.07 * U) (ay0 + atk + 0.07 * U) (zc + 0.05 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (x0 - 0.07 * U) (y1 - atk - 0.07 * U) zc (x1 + 0.07 * U) (y1 + 0.07 * U) (zc + 0.05 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (x0 - 0.07 * U) (ay0 + atk) zc (x0 + atk + 0.07 * U) (y1 - atk) (zc + 0.05 * U) PNL_MAT_KLEMP uv
			pnl_addBox cx (x1 - atk - 0.07 * U) (ay0 + atk) zc (x1 + 0.07 * U) (y1 - atk) (zc + 0.05 * U) PNL_MAT_KLEMP uv
		)

		/*--- sestavení meshe ---*/
		if cx.V.count < 3 do pnl_addBox cx x0 y0 0 x1 y1 (1.0 * U) PNL_MAT_FASADA uv
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

fn dumModerniSetParam pname val =
(
	for o in (selection as array) where (isKindOf o DumModerniGeo) do setProperty o pname val
	ok
)

macroScript DumModerniCreate
	category:"Budovy"
	buttonText:"Moderni bytovy dum"
	tooltip:"Vytvorit parametricky moderni bytovy dum"
(
	on execute do
	(
		local dnode = DumModerniGeo name:(uniquename "ModerniDum")
		select dnode
		max modify mode
	)
)

format "\nModerní bytový dům: plugin načten. Create > Geometry > kategorie \"Budovy\".\n"
