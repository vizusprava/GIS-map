/*------------------------------------------------------------------------------
	RODINNÝ DŮM - parametrický generátor pro 3ds Max
	------------------------------------------------
	Klasický dům: 1-3 podlaží, pět typů střechy (plochá, sedlová, valbová,
	pultová, stanová), přesah střechy, komín, vstup se stříškou, volitelná
	garáž jako přístavek a podezdívka.

	Create > Geometry > kategorie "Budovy" > Rodinný dům, pak klik do pohledu.
	Rozměry v metrech (viz "1 m = ... jednotek").

	Potřebuje budovy-lib.ms a panelak.ms ve stejné složce - natáhne si je sám.
------------------------------------------------------------------------------*/

(
	local rd_dir = ""
	try ( rd_dir = getFilenamePath (getSourceFileName()) ) catch ( rd_dir = "" )
	local rd_lib = rd_dir + "budovy-lib.ms"
	if rd_dir != "" and (doesFileExist rd_lib) then fileIn rd_lib
	else format "CHYBA: vedle dum-rodinny.ms musí ležet budovy-lib.ms a panelak.ms\n"
)

global dumRodinnySetParam

plugin simpleObject DumRodinnyGeo
	name:"Rodinný dům"
	classID:#(0x51ab33d1, 0x2d7f9111)
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
		delka        type:#float   ui:spDelka    default:11.0
		sirka        type:#float   ui:spSirka    default:9.0
		podlazi      type:#integer ui:spPodlazi  default:2
		vyskaPodlazi type:#float   ui:spVyskaP   default:2.75
		tlSteny      type:#float   ui:spTlSteny  default:0.4
		podezdivka   type:#float   ui:spPodez    default:0.45
	)

	parameters pStrecha rollout:rStrecha
	(
		typStrechy  type:#integer ui:ddlTyp      default:2
		sklon       type:#float   ui:spSklon     default:35.0
		presah      type:#float   ui:spPresah    default:0.6
		krytinaTl   type:#float   ui:spKrytTl    default:0.25
		atikaVyska  type:#float   ui:spAtika     default:0.4
		komin       type:#boolean ui:chkKomin    default:true
		kominSirka  type:#float   ui:spKominS    default:0.6
	)

	parameters pOkna rollout:rOkna
	(
		oknoSirka  type:#float   ui:spOknoS     default:1.5
		oknoVyska  type:#float   ui:spOknoV     default:1.4
		parapet    type:#float   ui:spParapet   default:0.9
		rozponOsy  type:#float   ui:spRozpon    default:3.0
		oknoDeleni type:#integer ui:spDeleni    default:2
		ramy       type:#boolean ui:chkRamy     default:true
		parapetPlech type:#boolean ui:chkParapet default:true
		sklozap    type:#float   ui:spZapusteni default:0.16
	)

	parameters pVstup rollout:rVstup
	(
		dverSirka    type:#float   ui:spDverS    default:1.1
		dverVyska    type:#float   ui:spDverV    default:2.1
		striska      type:#boolean ui:chkStriska default:true
		garaz        type:#boolean ui:chkGaraz   default:true
		garazStrana  type:#integer ui:ddlStrana  default:1
		garazSirka   type:#float   ui:spGarazS   default:3.6
		garazHloubka type:#float   ui:spGarazH   default:6.0
		garazVyska   type:#float   ui:spGarazV   default:2.9
		garazVrata   type:#integer ui:spVrata    default:1
		vrataSirka   type:#float   ui:spVrataS   default:2.6
		vrataVyska   type:#float   ui:spVrataV   default:2.3
		garazStrecha type:#integer ui:ddlGStrecha default:2
		garazSklon   type:#float   ui:spGSklon   default:12.0
		garazPresah  type:#float   ui:spGPresah  default:0.35
		garazOkno    type:#boolean ui:chkGOkno   default:true
		garazDvere   type:#boolean ui:chkGDvere  default:true
	)

	parameters pMat rollout:rMat
	(
		mapovani  type:#boolean ui:chkMapovani default:true
		uvMeritko type:#float   ui:spUV        default:1.0
		unitsPerM type:#float   ui:spJednotky  default:1.0
		trubkaHran type:#integer ui:spHran     default:8
	)

	rollout rMain "Rozměry domu"
	(
		spinner spDelka "Délka (m):" type:#float range:[3,60,11] scale:0.25 fieldwidth:58
		slider  slDelka "" type:#float range:[3,60,11] ticks:0 width:150 offset:[0,-3]
		spinner spSirka "Hloubka (m):" type:#float range:[3,40,9] scale:0.25 fieldwidth:58
		slider  slSirka "" type:#float range:[3,40,9] ticks:0 width:150 offset:[0,-3]
		spinner spPodlazi "Podlaží:" type:#integer range:[1,4,2] fieldwidth:58
		slider  slPodlazi "" type:#integer range:[1,4,2] ticks:0 width:150 offset:[0,-3]
		spinner spVyskaP "Výška podlaží (m):" type:#float range:[2,5,2.75] scale:0.05 fieldwidth:58
		spinner spTlSteny "Tloušťka stěn (m):" type:#float range:[0.1,1,0.4] scale:0.01 fieldwidth:58
		spinner spPodez "Podezdívka (m):" type:#float range:[0,2,0.45] scale:0.05 fieldwidth:58

		on slDelka changed val do dumRodinnySetParam #delka val
		on slSirka changed val do dumRodinnySetParam #sirka val
		on slPodlazi changed val do dumRodinnySetParam #podlazi val
		on rMain open do
			try ( slDelka.value = delka; slSirka.value = sirka; slPodlazi.value = podlazi )
			catch ()
	)

	rollout rStrecha "Střecha"
	(
		dropdownlist ddlTyp "" width:160 selection:2 \
			items:#("plochá s atikou", "sedlová", "valbová", "pultová", "stanová")
		spinner spSklon "Sklon (°):" type:#float range:[5,60,35] scale:1 fieldwidth:58
		slider  slSklon "" type:#float range:[5,60,35] ticks:0 width:150 offset:[0,-3]
		spinner spPresah "Přesah střechy (m):" type:#float range:[0,2,0.6] scale:0.05 fieldwidth:58
		spinner spKrytTl "Tloušťka krytiny (m):" type:#float range:[0.05,0.8,0.25] scale:0.01 fieldwidth:58
		spinner spAtika "Výška atiky (m):" type:#float range:[0,2,0.4] scale:0.05 fieldwidth:58
		label lbA "(jen u ploché střechy)" offset:[0,0]
		checkbox chkKomin "Komín" checked:true offset:[0,4]
		spinner spKominS "Šířka komína (m):" type:#float range:[0.2,2,0.6] scale:0.05 fieldwidth:58

		on slSklon changed val do dumRodinnySetParam #sklon val
		on rStrecha open do try (slSklon.value = sklon) catch ()
	)

	rollout rOkna "Okna"
	(
		spinner spOknoS "Šířka okna (m):" type:#float range:[0.4,5,1.5] scale:0.05 fieldwidth:58
		spinner spOknoV "Výška okna (m):" type:#float range:[0.4,3,1.4] scale:0.05 fieldwidth:58
		spinner spParapet "Parapet (m):" type:#float range:[0,2,0.9] scale:0.05 fieldwidth:58
		spinner spRozpon "Rozteč oken (m):" type:#float range:[1.2,10,3.0] scale:0.1 fieldwidth:58
		spinner spDeleni "Křídel v okně:" type:#integer range:[1,4,2] fieldwidth:58
		checkbox chkRamy "Rámy" checked:true
		checkbox chkParapet "Parapetní plechy" checked:true
		spinner spZapusteni "Zapuštění okna (m):" type:#float range:[0,0.6,0.16] scale:0.01 fieldwidth:58
	)

	rollout rVstup "Vstup a garáž"
	(
		spinner spDverS "Šířka dveří (m):" type:#float range:[0.7,3,1.1] scale:0.05 fieldwidth:58
		spinner spDverV "Výška dveří (m):" type:#float range:[1.8,3,2.1] scale:0.05 fieldwidth:58
		checkbox chkStriska "Stříška nad vstupem" checked:true
		checkbox chkGaraz "Garáž jako přístavek" checked:true offset:[0,6]
		dropdownlist ddlStrana "Strana:" width:150 selection:1 items:#("vpravo", "vlevo")
		spinner spGarazS "Šířka garáže (m):" type:#float range:[2,14,3.6] scale:0.1 fieldwidth:58
		slider  slGarazS "" type:#float range:[2,14,3.6] ticks:0 width:150 offset:[0,-3]
		spinner spGarazH "Hloubka garáže (m):" type:#float range:[2,14,6.0] scale:0.1 fieldwidth:58
		spinner spGarazV "Výška garáže (m):" type:#float range:[2,5,2.9] scale:0.1 fieldwidth:58

		label lbV "— Vrata —" offset:[0,6]
		spinner spVrata "Počet vrat:" type:#integer range:[1,3,1] fieldwidth:58
		spinner spVrataS "Šířka vrat (m):" type:#float range:[1.8,4,2.6] scale:0.05 fieldwidth:58
		spinner spVrataV "Výška vrat (m):" type:#float range:[1.8,4,2.3] scale:0.05 fieldwidth:58

		label lbG "— Střecha garáže —" offset:[0,6]
		dropdownlist ddlGStrecha "" width:150 selection:2 \
			items:#("plochá", "pultová", "sedlová", "valbová")
		spinner spGSklon "Sklon (°):" type:#float range:[3,50,12] scale:1 fieldwidth:58
		spinner spGPresah "Přesah (m):" type:#float range:[0,1.5,0.35] scale:0.05 fieldwidth:58

		checkbox chkGOkno "Okénko v boční stěně" checked:true offset:[0,6]
		checkbox chkGDvere "Vedlejší dveře" checked:true

		on slGarazS changed val do dumRodinnySetParam #garazSirka val
		on rVstup open do try (slGarazS.value = garazSirka) catch ()
	)

	rollout rMat "Materiál a mapování"
	(
		checkbox chkMapovani "Generovat UV mapování" checked:true
		spinner spUV "Velikost dlaždice UV (m):" type:#float range:[0.05,20,1.0] scale:0.1 fieldwidth:58
		spinner spJednotky "1 m = ... jednotek:" type:#float range:[0.0001,10000,1.0] scale:1 fieldwidth:58
		spinner spHran "Hran trubek:" type:#integer range:[4,16,8] fieldwidth:58
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

		local L  = amax (3.0 * U) (delka * U)
		local W  = amax (3.0 * U) (sirka * U)
		local NF = amax 1 podlazi
		local fh = amax (2.0 * U) (vyskaPodlazi * U)
		local t  = amin (amax (0.1 * U) (tlSteny * U)) (amin (L * 0.2) (W * 0.2))
		local zb = amax 0.0 (podezdivka * U)
		local mrg = 0.25 * U

		local x0 = -L * 0.5, x1 = L * 0.5
		local y0 = -W * 0.5, y1 = W * 0.5
		local ze = zb + NF * fh          -- úroveň okapu / horní hrana stěn

		-- okenní osy
		local n = amax 1 ((floor (L / (amax (1.0 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepX = L / n
		local AX = for i = 1 to n collect (x0 + stepX * (i - 0.5))
		local oh = amin (amax (0.3 * U) (oknoVyska * U)) (fh - 0.4 * U)
		local ow = amin (amax (0.3 * U) (oknoSirka * U)) (stepX - 0.5 * U)
		local par = amax 0.0 (amin (parapet * U) (fh - oh - 0.25 * U))

		-- osy na štítové stěně (podél hloubky)
		local nY = amax 1 ((floor (W / (amax (1.0 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepY = W / nY
		local AY = for i = 1 to nY collect (y0 + stepY * (i - 0.5))
		local owY = amin ow (stepY - 0.5 * U)

		/*--- parametry střechy (počítají se dřív, potřebuje je i garáž) ---*/
		local pres = amax 0.0 (presah * U)
		local ktl = amax (0.03 * U) (krytinaTl * U)
		local sk = amax 3.0 (amin sklon 70.0)
		local tg = tan sk
		local vysS = ((W * 0.5) + pres) * tg          -- sedlová / valbová / stanová
		local vysP = (W + 2 * pres) * tg              -- pultová
		-- výšky líce střechy nad hranami stěn (okap je o "pres" dál, takže
		-- nad stěnou už je střecha vyšší o pres * tg)
		local zOkap = ze + pres * tg
		local zVrchol = ze + vysS
		local zPultB = ze + (W + pres) * tg

		/*--- rozměry garáže ---------------------------------------------------
			Počítají se tady nahoře, protože podle nich se vynechávají okna ve
			štítové stěně, ke které garáž přiléhá.                            */
		local gw = amax (2.0 * U) (garazSirka * U)
		local gd = amax (2.0 * U) (garazHloubka * U)
		-- výška garáže se ořízne tak, aby okap garáže nepřerostl okap domu;
		-- jinak by se přístavek prořízl skrz stěnu do obytného podlaží
		local gh = amin (amax (2.0 * U) (garazVyska * U)) (ze - zb)
		local vpravo = (garazStrana != 2)
		local gx0 = if vpravo then x1 else (x0 - gw)
		local gx1 = gx0 + gw
		local gy0 = y0
		local gy1 = y0 + gd
		local gze = zb + gh
		local gp = amax 0.0 (garazPresah * U)
		local gtg = tan (amax 3.0 (amin garazSklon 60.0))
		local gkt = amax (0.04 * U) (ktl * 0.7)
		local gvS = ((gd * 0.5) + gp) * gtg
		local gvP = (gd + 2 * gp) * gtg
		-- nejvyšší bod garáže včetně střechy: pod ním nesmí být ve štítu okno
		local gMaxZ = gze + gkt
		case garazStrecha of
		(
			2: gMaxZ = gze + gvP + gkt
			3: gMaxZ = gze + gvS + gkt
			4: gMaxZ = gze + gvS + gkt
			default: gMaxZ = gze + gkt + 0.35 * U
		)

		-- vstup uprostřed přední fasády
		local dw = amin (dverSirka * U) (stepX - 0.3 * U)
		local dh = amin (dverVyska * U) (fh - 0.25 * U)
		local xe = if n > 1 then AX[((floor (n / 2)) as integer) + 1] else 0.0

		local fw = amax (0.01 * U) (0.07 * U)
		local ins = amin (amax 0.0 (sklozap * U)) (t - fw * 1.2)
		if ins < 0.0 do ins = 0.0

		local det = pnl_det()
		det.U = U
		det.ramy = ramy
		det.ram = fw
		det.zapusteni = ins
		det.deleni = amax 1 oknoDeleni
		det.nadsvetlik = false
		det.nadsvetlikV = 0.4 * U
		det.parapetPlech = parapetPlech
		det.parapetTl = 0.04 * U
		det.parapetPresah = 0.07 * U
		det.balkonParapet = par
		det.dverKridla = 1
		det.dverNadsvetlik = true
		det.dverNadsvetlikV = 0.35 * U

		/*--- otvory ---*/
		local opsF = bud_oknaGrid AX ow zb fh 1 NF par oh
		local kndF = for q in opsF collect 1
		-- v přízemí zahodíme okno kolidující se vstupem a přidáme dveře
		local o2 = #(), k2 = #()
		for j = 1 to opsF.count do
		(
			local o = opsF[j]
			local drop = (o.z < zb + dh and o.x < xe + dw * 0.5 + mrg and o.y > xe - dw * 0.5 - mrg)
			if not drop do ( append o2 o; append k2 kndF[j] )
		)
		append o2 [ xe - dw * 0.5, xe + dw * 0.5, zb, zb + dh ]
		append k2 3
		opsF = o2
		kndF = k2

		local opsB = bud_oknaGrid AX ow zb fh 1 NF par oh

		/*	Ve štítové stěně, ke které přiléhá garáž, se okna zakrytá garáží
			vynechají - jinak by vedla rovnou do garáže nebo do její střechy.
			Nad garáží okna zůstanou.                                        */
		local opsGall = bud_oknaGrid AY owY zb fh 1 NF par oh
		local opsGL = #()
		local opsGR = #()
		for o in opsGall do
		(
			local zakryto = garaz and (o.x < gy1 + mrg) and (o.y > gy0 - mrg) and (o.z < gMaxZ)
			if not (zakryto and vpravo) do append opsGR o
			if not (zakryto and not vpravo) do append opsGL o
		)

		/*--- podezdívka ---*/
		if zb > 0.02 * U then
			pnl_addBox cx (x0 - 0.05 * U) (y0 - 0.05 * U) 0 (x1 + 0.05 * U) (y1 + 0.05 * U) zb PNL_MAT_SOKL uv
		else
			pnl_addBox cx x0 y0 (-0.25 * U) x1 y1 0 PNL_MAT_SOKL uv

		/*--- obvodové stěny ---*/
		local R = pnl_wallRects x0 x1 zb ze opsF
		for r in R do pnl_addBox cx r.x y0 r.z r.y (y0 + t) r.w PNL_MAT_FASADA uv
		R = pnl_wallRects x0 x1 zb ze opsB
		for r in R do pnl_addBox cx r.x (y1 - t) r.z r.y y1 r.w PNL_MAT_FASADA uv
		R = pnl_wallRects (y0 + t) (y1 - t) zb ze opsGL
		for r in R do pnl_addBox cx x0 r.x r.z (x0 + t) r.y r.w PNL_MAT_FASADA uv
		R = pnl_wallRects (y0 + t) (y1 - t) zb ze opsGR
		for r in R do pnl_addBox cx (x1 - t) r.x r.z x1 r.y r.w PNL_MAT_FASADA uv
		-- strop posledního podlaží
		pnl_addBox cx x0 y0 (ze - 0.25 * U) x1 y1 ze PNL_MAT_DESKA uv

		/*--- výplně otvorů ---*/
		for j = 1 to opsF.count do
			pnl_fillOpening cx opsF[j] kndF[j] true y0 1.0 det PNL_MAT_SKLO uv
		for o in opsB do pnl_fillOpening cx o 1 true y1 (-1.0) det PNL_MAT_SKLO uv
		for o in opsGL do pnl_fillOpening cx o 1 false x0 1.0 det PNL_MAT_SKLO uv
		for o in opsGR do pnl_fillOpening cx o 1 false x1 (-1.0) det PNL_MAT_SKLO uv

		/*--- střecha (parametry jsou spočítané nahoře) ---*/
		case typStrechy of
		(
			1: bud_strechaPlocha cx x0 x1 y0 y1 ze ktl (amax 0.0 (atikaVyska * U)) (amax (0.1 * U) (t * 0.6)) \
					PNL_MAT_STRECHA PNL_MAT_KLEMP uv
			3: bud_strechaValbova cx x0 x1 y0 y1 ze vysS pres ktl BUD_MAT_KRYTINA uv
			4: (
				bud_strechaPultova cx x0 x1 y0 y1 ze vysP pres ktl BUD_MAT_KRYTINA uv
				-- podélné stěny musí vystoupat až pod šikmý líc, jinak tam zůstane díra
				bud_dozdivka cx x0 x1 y0 y1 t ze zOkap zPultB PNL_MAT_FASADA uv
				-- štíty jsou tu lichoběžníkové, bez hřebene
				bud_stit cx x0 (x0 + t) y0 y1 ze zOkap zPultB 0.0 PNL_MAT_FASADA uv
				bud_stit cx (x1 - t) x1 y0 y1 ze zOkap zPultB 0.0 PNL_MAT_FASADA uv
			)
			5: bud_strechaStanova cx x0 x1 y0 y1 ze vysS pres ktl BUD_MAT_KRYTINA uv
			default: (
				bud_strechaSedlova cx x0 x1 y0 y1 ze vysS pres ktl BUD_MAT_KRYTINA uv
				bud_dozdivka cx x0 x1 y0 y1 t ze zOkap zOkap PNL_MAT_FASADA uv
				bud_stit cx x0 (x0 + t) y0 y1 ze zOkap zOkap zVrchol PNL_MAT_FASADA uv
				bud_stit cx (x1 - t) x1 y0 y1 ze zOkap zOkap zVrchol PNL_MAT_FASADA uv
			)
		)

		/*--- komín ---*/
		if komin do
		(
			local ks = amax (0.2 * U) (kominSirka * U)
			local kx = x0 + L * 0.28
			local ky = (y0 + y1) * 0.5 - W * 0.15
			local kz = ze + (if typStrechy == 1 then (0.8 * U) else (vysS + 0.7 * U))
			bud_komin cx kx ky ks (ze - 0.5 * U) kz PNL_MAT_SOKL BUD_MAT_KRYTINA uv
		)

		/*--- stříška nad vstupem ---*/
		if striska do
		(
			local cw = dw + 1.0 * U
			local cd = 1.2 * U
			local zc = zb + dh + 0.15 * U
			pnl_addBox cx (xe - cw * 0.5) (y0 - cd) zc (xe + cw * 0.5) (y0 + t * 0.5) (zc + 0.16 * U) BUD_MAT_RIMSA uv
			local hr = amax 4 trubkaHran
			pnl_addPipe2 cx [xe - cw * 0.5 + 0.1 * U, y0 - cd + 0.1 * U, 0] \
				[xe - cw * 0.5 + 0.1 * U, y0 - cd + 0.1 * U, zc] (0.04 * U) hr PNL_MAT_ZABRADLI uv
			pnl_addPipe2 cx [xe + cw * 0.5 - 0.1 * U, y0 - cd + 0.1 * U, 0] \
				[xe + cw * 0.5 - 0.1 * U, y0 - cd + 0.1 * U, zc] (0.04 * U) hr PNL_MAT_ZABRADLI uv
		)

		/*--- garáž jako přístavek na boku ---*/
		if garaz do
		(
			/*--- čelní stěna s vraty a vedlejšími dveřmi ---*/
			local nvr = amax 1 garazVrata
			local vw = amin (vrataSirka * U) (gw / nvr - 0.5 * U)
			local vh = amin (amax (1.8 * U) (vrataVyska * U)) (gh - 0.3 * U)
			local gops = #()
			local gknd = #()
			if vw > 1.2 * U do
				for k = 1 to nvr do
				(
					local vxc = gx0 + gw * (k - 0.5) / nvr
					append gops [ vxc - vw * 0.5, vxc + vw * 0.5, zb, zb + vh ]
					append gknd 0                        -- 0 = sekční vrata
				)
			-- vedlejší dveře do zbylého místa u kraje od domu
			if garazDvere do
			(
				local ddw = 0.9 * U
				local dvx = if vpravo then (gx1 - ddw * 0.5 - 0.35 * U) else (gx0 + ddw * 0.5 + 0.35 * U)
				local kolize = false
				for o in gops do
					if dvx < o.y + 0.2 * U and dvx > o.x - 0.2 * U do kolize = true
				if not kolize do
				(
					append gops [ dvx - ddw * 0.5, dvx + ddw * 0.5, zb, zb + amin (2.1 * U) (gh - 0.3 * U) ]
					append gknd 3
				)
			)
			local GR = pnl_wallRects gx0 gx1 zb gze gops
			for r in GR do pnl_addBox cx r.x gy0 r.z r.y (gy0 + t) r.w PNL_MAT_FASADA uv

			/*--- zadní a vnější boční stěna, okénko ---*/
			pnl_addBox cx gx0 (gy1 - t) zb gx1 gy1 gze PNL_MAT_FASADA uv
			local gsops = #()
			if garazOkno do
			(
				local goW = amin (1.0 * U) (gd * 0.25)
				local goH = amin (0.7 * U) (gh * 0.3)
				local goY = gy0 + gd * 0.6
				local goZ = gze - goH - 0.55 * U
				if goZ > zb + 0.4 * U and goW > 0.3 * U do
					append gsops [ goY - goW * 0.5, goY + goW * 0.5, goZ, goZ + goH ]
			)
			local sxw = if vpravo then (gx1 - t) else gx0
			local GS = pnl_wallRects gy0 gy1 zb gze gsops
			for r in GS do pnl_addBox cx sxw r.x r.z (sxw + t) r.y r.w PNL_MAT_FASADA uv
			for o in gsops do
				pnl_fillOpening cx o 1 false (if vpravo then gx1 else gx0) (if vpravo then -1.0 else 1.0) \
					det PNL_MAT_SKLO uv

			if zb > 0.02 * U do
				pnl_addBox cx (gx0 - 0.05 * U) (gy0 - 0.05 * U) 0 (gx1 + 0.05 * U) (gy1 + 0.05 * U) zb PNL_MAT_SOKL uv

			/*--- výplně: sekční vrata a vedlejší dveře ---*/
			for j = 1 to gops.count do
			(
				local o = gops[j]
				if gknd[j] == 3 then
					pnl_fillOpening cx o 3 true gy0 1.0 det PNL_MAT_SKLO uv
				else
				(
					pnl_addBox cx o.x (gy0 + 0.07 * U) o.z o.y (gy0 + 0.15 * U) o.w PNL_MAT_DVERE uv
					local npan = 4
					for k = 1 to npan - 1 do
					(
						local zz = o.z + (o.w - o.z) * k / npan
						pnl_addBox cx o.x (gy0 + 0.04 * U) (zz - 0.02 * U) o.y (gy0 + 0.08 * U) (zz + 0.02 * U) \
							PNL_MAT_KLEMP uv
					)
				)
			)

			/*--- střecha garáže podle zvoleného typu ------------------------
				Na straně u domu nesmí přesah zasahovat do zdi: rozsah, se
				kterým se střecha staví, se proto o přesah zkrátí, aby okap
				skončil přesně v líci domu. Na volné straně přesah zůstává. */
			local rgx0 = if vpravo then (gx0 + gp) else gx0
			local rgx1 = if vpravo then gx1 else (gx1 - gp)
			local gOkap = gze + gp * gtg
			local gPultB = gze + (gd + gp) * gtg
			case garazStrecha of
			(
				2: (
					bud_strechaPultova cx rgx0 rgx1 gy0 gy1 gze gvP gp gkt BUD_MAT_KRYTINA uv
					bud_dozdivka cx gx0 gx1 gy0 gy1 t gze gOkap gPultB PNL_MAT_FASADA uv
					bud_stit cx gx0 (gx0 + t) gy0 gy1 gze gOkap gPultB 0.0 PNL_MAT_FASADA uv
					bud_stit cx (gx1 - t) gx1 gy0 gy1 gze gOkap gPultB 0.0 PNL_MAT_FASADA uv
				)
				3: (
					bud_strechaSedlova cx rgx0 rgx1 gy0 gy1 gze gvS gp gkt BUD_MAT_KRYTINA uv
					bud_dozdivka cx gx0 gx1 gy0 gy1 t gze gOkap gOkap PNL_MAT_FASADA uv
					bud_stit cx gx0 (gx0 + t) gy0 gy1 gze gOkap gOkap (gze + gvS) PNL_MAT_FASADA uv
					bud_stit cx (gx1 - t) gx1 gy0 gy1 gze gOkap gOkap (gze + gvS) PNL_MAT_FASADA uv
				)
				4: bud_strechaValbova cx rgx0 rgx1 gy0 gy1 gze gvS gp gkt BUD_MAT_KRYTINA uv
				default: bud_strechaPlocha cx gx0 gx1 gy0 gy1 gze gkt (0.3 * U) (t * 0.6) \
					PNL_MAT_STRECHA PNL_MAT_KLEMP uv
			)
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

fn dumRodinnySetParam pname val =
(
	for o in (selection as array) where (isKindOf o DumRodinnyGeo) do setProperty o pname val
	ok
)

macroScript DumRodinnyCreate
	category:"Budovy"
	buttonText:"Rodinny dum"
	tooltip:"Vytvorit parametricky rodinny dum"
(
	on execute do
	(
		local dnode = DumRodinnyGeo name:(uniquename "RodinnyDum")
		select dnode
		max modify mode
	)
)

format "\nRodinný dům: plugin načten. Create > Geometry > kategorie \"Budovy\".\n"
