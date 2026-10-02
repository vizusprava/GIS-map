/*------------------------------------------------------------------------------
	PANELÁK S INTERIÉREM - parametrický scripted plugin pro 3ds Max
	---------------------------------------------------------------
	Druhá verze paneláku: kromě vnějšího pláště staví i vnitřek - schodišťová
	jádra s chodbou a dvouramennými schody, byty po stranách jádra, pokoje,
	předsíň, koupelnu a WC, včetně dveřních otvorů.

	Původní jednoduchá verze (jen plášť) zůstává v panelak.ms a funguje dál
	samostatně. Tenhle soubor z ní přebírá sdílené pomocné funkce, takže
	musí ležet ve stejné složce.

	Dispozice jedné sekce (= jeden vchod), v každém podlaží:

		|<------------------ šířka sekce ------------------>|
		+----------------+---------------+-----------------+
		|                |   chodba      |                 |   <- přední fasáda
		|   BYT vlevo    +---------------+   BYT vpravo    |
		|                |   schodiště   |                 |   <- zadní fasáda
		+----------------+---------------+-----------------+

	Dispozice jednoho bytu (od přední fasády dozadu):

		pokoje s okny  |  předsíň  |  koupelna + WC | zadní pokoje s okny

	Použití:
		1) Scripting > Run Script...  ->  panelak-interier.ms
		2) Create > Geometry > kategorie "Panelák" > Panelák (interiér)
		   a jedním kliknutím do pohledu
		3) Modify panel -> parametry

	Rozměry se zadávají v METRECH (viz "1 m = ... jednotek" v posledním rollupu).
------------------------------------------------------------------------------*/

/*	Sdílené pomocné funkce jsou v panelak.ms a načítají se VŽDYCKY, ne jen když
	chybí. Kdyby se to načítalo podmíněně, zůstaly by po aktualizaci v paměti
	staré verze funkcí a interiérová verze by volala něco, co tam ještě není. */
(
	local pnl_dir = ""
	try ( pnl_dir = getFilenamePath (getSourceFileName()) ) catch ( pnl_dir = "" )
	local pnl_base = pnl_dir + "panelak.ms"
	if pnl_dir != "" and (doesFileExist pnl_base) then
		fileIn pnl_base
	else
	(
		if (isKindOf pnl_addBox MAXScriptFunction) != true do
			format "CHYBA: vedle panelak-interier.ms musí ležet panelak.ms (nebo ho spusť ručně).\n"
	)
)

-- ID materiálů pro vnitřek (navazují na 1-8 z panelak.ms)
global PNL_MAT_NOSNA     = 9
global PNL_MAT_PRICKA    = 10
global PNL_MAT_PODLAHA   = 11
global PNL_MAT_SCHODY    = 12
global PNL_MAT_DVERE_INT = 13

global panelakInterierMaterial
global pnli_setParam

/*--- stěna podél osy X (v ose y = yc), otvory zadané v X -------------------*/
fn pnl_wallAlongX cx a1 a2 yc wt z1 z2 ops mid uv =
(
	local R = pnl_wallRects a1 a2 z1 z2 ops
	for r in R do pnl_addBox cx r.x (yc - wt * 0.5) r.z r.y (yc + wt * 0.5) r.w mid uv
	ok
)

/*--- stěna podél osy Y (v ose x = xc), otvory zadané v Y -------------------*/
fn pnl_wallAlongY cx b1 b2 xc wt z1 z2 ops mid uv =
(
	local R = pnl_wallRects b1 b2 z1 z2 ops
	for r in R do pnl_addBox cx (xc - wt * 0.5) r.x r.z (xc + wt * 0.5) r.y r.w mid uv
	ok
)

/*--- dveřní otvor jako point4 ----------------------------------------------*/
fn pnli_dvere a dw z1 z2 = [ a - dw * 0.5, a + dw * 0.5, z1, z2 ]

/*--- dvouramenné schodiště s mezipodestou -----------------------------------*/
fn pnli_schodiste cx ax0 ax1 ay0 ay1 zf fh riser U uv =
(
	local SW = ax1 - ax0
	local SD = ay1 - ay0
	if SW > 1.6 * U and SD > 2.4 * U do
	(
		local zm = zf + fh * 0.5
		local landD = amin (1.3 * U) (SD * 0.32)
		local runEnd = ay1 - landD
		local halfW = SW * 0.5
		local ris = amax (0.12 * U) riser

		-- mezipodesta u zadní stěny
		pnl_addBox cx ax0 runEnd (zm - 0.22 * U) ax1 ay1 zm PNL_MAT_SCHODY uv

		-- první rameno: vzhůru směrem +Y, levá polovina
		local n1 = amax 1 ((ceil ((zm - zf) / ris)) as integer)
		local run1 = (runEnd - ay0) / n1
		for k = 1 to n1 do
			pnl_addBox cx ax0 (ay0 + run1 * (k - 1)) zf \
				(ax0 + halfW) (ay0 + run1 * k) (zf + (zm - zf) * k / n1) PNL_MAT_SCHODY uv

		-- druhé rameno: zpět směrem -Y, pravá polovina
		local ztop = zf + fh
		local n2 = amax 1 ((ceil ((ztop - zm) / ris)) as integer)
		local run2 = (runEnd - ay0) / n2
		for k = 1 to n2 do
			pnl_addBox cx (ax1 - halfW) (runEnd - run2 * k) zf \
				ax1 (runEnd - run2 * (k - 1)) (zm + (ztop - zm) * k / n2) PNL_MAT_SCHODY uv
	)
	ok
)

/*--- dispozice jednoho bytu --------------------------------------------------
	ax0..ax1  šířka bytu,  iy0..iy1  hloubka traktu
	yA, yB    hranice středního pásu (předsíň) - počítá je volající, ať sedí
	          s dveřmi ve stěně jádra
	hallSide  +1 = jádro je vpravo od bytu, -1 = vlevo                       */
fn pnli_byt cx ax0 ax1 iy0 iy1 yA yB zf hh pt dwi dhi roomW bathW hallSide U uv =
(
	local AW = ax1 - ax0
	if AW > 2.5 * U and (iy1 - iy0) > 5.0 * U do
	(
		local z2 = zf + hh
		local zd = zf + dhi

		/*--- přední zóna: pokoje s okny ---*/
		local nPok = amax 1 ((floor (AW / roomW + 0.5)) as integer)
		local fwid = AW / nPok
		for k = 1 to nPok - 1 do
			pnl_wallAlongY cx iy0 yA (ax0 + fwid * k) pt zf z2 #() PNL_MAT_PRICKA uv

		local opsA = #()
		for k = 1 to nPok do append opsA (pnli_dvere (ax0 + fwid * (k - 0.5)) dwi zf zd)
		pnl_wallAlongX cx ax0 ax1 yA pt zf z2 opsA PNL_MAT_PRICKA uv

		/*--- zadní zóna: hygienické jádro u strany schodiště + pokoje ---*/
		local bw = amin bathW (AW * 0.45)
		local bx0 = if hallSide > 0 then (ax1 - bw) else ax0
		local bx1 = bx0 + bw
		local bathD = amin (2.4 * U) ((iy1 - yB) * 0.7)
		local xk = bx0 + bw * 0.58              -- dělení koupelna / WC
		local dwb = amin dwi (bw * 0.36)        -- užší dveře do koupelny a WC

		local rx0 = if hallSide > 0 then ax0 else bx1
		local rx1 = if hallSide > 0 then bx0 else ax1
		local nB = amax 1 ((floor ((rx1 - rx0) / roomW + 0.5)) as integer)
		local bwid = (rx1 - rx0) / nB

		local opsB = #()
		append opsB (pnli_dvere (bx0 + bw * 0.29) dwb zf zd)     -- koupelna
		append opsB (pnli_dvere (bx0 + bw * 0.79) dwb zf zd)     -- WC
		for k = 1 to nB do append opsB (pnli_dvere (rx0 + bwid * (k - 0.5)) dwi zf zd)
		pnl_wallAlongX cx ax0 ax1 yB pt zf z2 opsB PNL_MAT_PRICKA uv

		-- stěny hygienického jádra
		pnl_wallAlongY cx yB (yB + bathD) xk pt zf z2 #() PNL_MAT_PRICKA uv
		pnl_wallAlongX cx bx0 bx1 (yB + bathD) pt zf z2 #() PNL_MAT_PRICKA uv
		local bxe = if hallSide > 0 then bx0 else bx1
		pnl_wallAlongY cx yB (yB + bathD) bxe pt zf z2 #() PNL_MAT_PRICKA uv

		-- příčky mezi zadními pokoji
		for k = 1 to nB - 1 do
			pnl_wallAlongY cx yB iy1 (rx0 + bwid * k) pt zf z2 #() PNL_MAT_PRICKA uv
	)
	ok
)

/*============================ scripted plugin ===============================*/
plugin simpleObject PanelakInterierGeo
	name:"Panelák (interiér)"
	classID:#(0x51ab33c8, 0x2d7f9105)
	category:"Panelák"
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

	/*-------------------------- parametry -------------------------------*/
	parameters pRozmery rollout:rMain
	(
		delka        type:#float   ui:spDelka    default:36.0
		sirka        type:#float   ui:spSirka    default:12.0
		podlazi      type:#integer ui:spPodlazi  default:8
		vyskaPodlazi type:#float   ui:spVyskaP   default:2.8
		tlSteny      type:#float   ui:spTlSteny  default:0.3
		soklVyska    type:#float   ui:spSokl     default:0.6
		soklPresah   type:#float   ui:spSoklP    default:0.06
	)

	parameters pInterier rollout:rInterier
	(
		interier     type:#boolean ui:chkInterier   default:true
		rezPodlazi   type:#integer ui:spRez         default:0
		stropy       type:#boolean ui:chkStropy     default:true
		stropTl      type:#float   ui:spStropT      default:0.25
		jadroSirka   type:#float   ui:spJadro       default:5.4
		chodbaHl     type:#float   ui:spChodba      default:3.2
		schodiste    type:#boolean ui:chkSchodiste  default:true
		nosnaTl      type:#float   ui:spNosna       default:0.2
		prickaTl     type:#float   ui:spPricka      default:0.12
		stredniPas   type:#float   ui:spStredni     default:3.0
		pokojSirka   type:#float   ui:spPokoj       default:3.8
		koupelnaS    type:#float   ui:spKoupelna    default:2.6
		dverSirkaInt type:#float   ui:spDverSInt    default:0.85
		dverVyskaInt type:#float   ui:spDverVInt    default:2.0
	)

	parameters pFasada rollout:rFasada
	(
		autoOsy    type:#boolean ui:chkAutoOsy   default:true
		rozponOsy  type:#float   ui:spRozpon     default:3.6
		pocetOsi   type:#integer ui:spOsy        default:10
		oknoSirka  type:#float   ui:spOknoS      default:1.8
		oknoVyska  type:#float   ui:spOknoV      default:1.5
		parapet    type:#float   ui:spParapet    default:0.85
		ramy       type:#boolean ui:chkRamy      default:true
		ramSirka   type:#float   ui:spRam        default:0.07
		sklozap    type:#float   ui:spZapusteni  default:0.14
		stitOkna   type:#integer ui:spStitOkna   default:0
	)

	parameters pDetaily rollout:rDetaily
	(
		oknoDeleni     type:#integer ui:spDeleni    default:2
		oknaNadsvetlik type:#boolean ui:chkNadsv    default:false
		parapetPlech   type:#boolean ui:chkParapet  default:true
		dverKridla     type:#integer ui:spKridla    default:2
		spary          type:#boolean ui:chkSpary    default:true
		sparaSirka     type:#float   ui:spSpara     default:0.04
		oplechovani    type:#boolean ui:chkOplech   default:true
		sklepniOkna    type:#boolean ui:chkSklep    default:true
		svody          type:#boolean ui:chkSvody    default:true
		strechaDetail  type:#boolean ui:chkStrDet   default:true
		vstupDetail    type:#boolean ui:chkVstupDet default:true
		trubkaHran     type:#integer ui:spHran     default:8
	)

	parameters pBalkony rollout:rBalkony
	(
		balkony        type:#integer ui:ddlBalkony   default:2
		balkonKrok     type:#integer ui:spKrok       default:1
		balkonOd       type:#integer ui:spBalkonOd   default:2
		balkonHloubka  type:#float   ui:spBHl        default:1.5
		balkonSirka    type:#float   ui:spBSir       default:3.0
		balkonDeska    type:#float   ui:spBDeska     default:0.18
		zabradliTyp    type:#integer ui:ddlZabradli  default:1
		zabradliVyska  type:#float   ui:spZabrV      default:1.1
		zabradliTl     type:#float   ui:spZabrT      default:0.1
		tyceKrok       type:#float   ui:spTyce       default:0.14
		balkonoveDvere type:#boolean ui:chkBalkDvere default:true
	)

	parameters pVariace rollout:rVariace
	(
		seed          type:#integer ui:spSeed       default:1
		balkonVzor    type:#integer ui:ddlBVzor     default:1
		balkonHustota type:#float   ui:spBHust      default:0.5
		stridatStrany type:#boolean ui:chkStridat   default:false
		zabradliBarvy type:#integer ui:ddlBarvy     default:1
		pocetBarev    type:#integer ui:spPocetBarev default:3
		fasadaVzor    type:#integer ui:ddlFVzor     default:1
		fasadaHustota type:#float   ui:spFHust      default:0.25
		oknaSviti     type:#float   ui:spSviti      default:0.0
	)

	parameters pVstupy rollout:rVstupy
	(
		vchody         type:#integer ui:spVchody      default:2
		dverSirka      type:#float   ui:spDverS       default:1.8
		dverVyska      type:#float   ui:spDverV       default:2.3
		strisky        type:#boolean ui:chkStriska    default:true
		striskaSirka   type:#float   ui:spStriskaS    default:3.0
		striskaHloubka type:#float   ui:spStriskaH    default:1.4
		striskaTl      type:#float   ui:spStriskaT    default:0.18
		schody         type:#boolean ui:chkSchody     default:true
		schodySirka    type:#float   ui:spSchodyS     default:2.4
		schodyHloubka  type:#float   ui:spSchodyH     default:0.32
	)

	parameters pStrecha rollout:rStrecha
	(
		strechaTl      type:#float   ui:spStrechaT   default:0.3
		atikaVyska     type:#float   ui:spAtikaV     default:0.6
		atikaTl        type:#float   ui:spAtikaT     default:0.25
		strojovna      type:#boolean ui:chkStrojovna default:true
		strojovnaVyska type:#float   ui:spStrojV     default:2.6
	)

	parameters pMat rollout:rMat
	(
		mapovani  type:#boolean ui:chkMapovani  default:true
		uvMeritko type:#float   ui:spUV         default:1.0
		unitsPerM type:#float   ui:spJednotky   default:1.0
	)

	/*-------------------------- rozhraní --------------------------------*/
	rollout rMain "Rozměry domu"
	(
		spinner spDelka "Délka (m):" type:#float range:[4,400,36] scale:0.25 fieldwidth:58
		slider  slDelka "" type:#float range:[4,400,36] ticks:0 width:150 offset:[0,-3]

		spinner spSirka "Hloubka (m):" type:#float range:[6,60,12] scale:0.25 fieldwidth:58
		slider  slSirka "" type:#float range:[6,60,12] ticks:0 width:150 offset:[0,-3]

		spinner spPodlazi "Počet podlaží:" type:#integer range:[1,40,8] fieldwidth:58
		slider  slPodlazi "" type:#integer range:[1,40,8] ticks:0 width:150 offset:[0,-3]

		spinner spVyskaP "Výška podlaží (m):" type:#float range:[2,8,2.8] scale:0.05 fieldwidth:58
		slider  slVyskaP "" type:#float range:[2,8,2.8] ticks:0 width:150 offset:[0,-3]

		spinner spTlSteny "Tloušťka obv. stěn (m):" type:#float range:[0.08,1.5,0.3] scale:0.01 fieldwidth:58
		spinner spSokl "Výška soklu (m):" type:#float range:[0,4,0.6] scale:0.05 fieldwidth:58
		spinner spSoklP "Přesah soklu (m):" type:#float range:[0,0.5,0.06] scale:0.01 fieldwidth:58

		on slDelka changed val do pnli_setParam #delka val
		on slSirka changed val do pnli_setParam #sirka val
		on slPodlazi changed val do pnli_setParam #podlazi val
		on slVyskaP changed val do pnli_setParam #vyskaPodlazi val
		on rMain open do
			try
			(
				slDelka.value = delka
				slSirka.value = sirka
				slPodlazi.value = podlazi
				slVyskaP.value = vyskaPodlazi
			)
			catch ()
	)

	rollout rInterier "Interiér"
	(
		checkbox chkInterier "Stavět vnitřek" checked:true
		spinner spRez "Jen podlaží č. (0 = celý dům):" type:#integer range:[0,40,0] fieldwidth:44
		slider  slRez "" type:#integer range:[0,40,0] ticks:0 width:150 offset:[0,-3]
		label lblRez "Jedno patro = pohled do dispozice." offset:[0,2]
		checkbox chkStropy "Podlahové desky" checked:true offset:[0,4]
		spinner spStropT "Tloušťka desky (m):" type:#float range:[0.05,0.6,0.25] scale:0.01 fieldwidth:58
		spinner spJadro "Šířka schodišť. jádra (m):" type:#float range:[2,12,5.4] scale:0.1 fieldwidth:58
		spinner spChodba "Hloubka vstupní chodby (m):" type:#float range:[1,12,3.2] scale:0.1 fieldwidth:58
		checkbox chkSchodiste "Schodiště" checked:true
		spinner spNosna "Vnitřní nosné stěny (m):" type:#float range:[0.06,0.6,0.2] scale:0.01 fieldwidth:58
		spinner spPricka "Příčky (m):" type:#float range:[0.04,0.4,0.12] scale:0.01 fieldwidth:58
		spinner spStredni "Hloubka předsíně (m):" type:#float range:[1.2,8,3.0] scale:0.1 fieldwidth:58
		spinner spPokoj "Cílová šířka pokoje (m):" type:#float range:[2,10,3.8] scale:0.1 fieldwidth:58
		spinner spKoupelna "Šířka koupelny + WC (m):" type:#float range:[1.2,6,2.6] scale:0.1 fieldwidth:58
		spinner spDverSInt "Šířka vnitř. dveří (m):" type:#float range:[0.5,2,0.85] scale:0.05 fieldwidth:58
		spinner spDverVInt "Výška vnitř. dveří (m):" type:#float range:[1.6,3,2.0] scale:0.05 fieldwidth:58

		on slRez changed val do pnli_setParam #rezPodlazi val
		on rInterier open do try (slRez.value = rezPodlazi) catch ()
	)

	rollout rFasada "Fasáda a okna"
	(
		checkbox chkAutoOsy "Okenní osy dopočítat z délky" checked:true
		spinner spRozpon "Rozpon osy (m):" type:#float range:[1.5,12,3.6] scale:0.1 fieldwidth:58
		spinner spOsy "Počet os (ručně):" type:#integer range:[1,120,10] fieldwidth:58
		slider  slOsy "" type:#integer range:[1,120,10] ticks:0 width:150 offset:[0,-3]
		spinner spOknoS "Šířka okna (m):" type:#float range:[0.4,6,1.8] scale:0.05 fieldwidth:58
		spinner spOknoV "Výška okna (m):" type:#float range:[0.4,4,1.5] scale:0.05 fieldwidth:58
		spinner spParapet "Parapet (m):" type:#float range:[0,3,0.85] scale:0.05 fieldwidth:58
		checkbox chkRamy "Rámy oken" checked:true
		spinner spRam "Šířka rámu (m):" type:#float range:[0.02,0.3,0.07] scale:0.005 fieldwidth:58
		spinner spZapusteni "Zapuštění okna (m):" type:#float range:[0,0.6,0.14] scale:0.01 fieldwidth:58
		spinner spStitOkna "Oken ve štítu / patro:" type:#integer range:[0,8,0] fieldwidth:58

		on slOsy changed val do pnli_setParam #pocetOsi val
		on rFasada open do try (slOsy.value = pocetOsi) catch ()
	)

	rollout rDetaily "Detaily"
	(
		label lbO "— Okna a dveře —"
		spinner spDeleni "Křídel v okně:" type:#integer range:[1,4,2] fieldwidth:58
		checkbox chkNadsv "Nadsvětlík nad okny"
		checkbox chkParapet "Vnější parapetní plechy" checked:true
		spinner spKridla "Křídel vstupních dveří:" type:#integer range:[1,3,2] fieldwidth:58
		label lbO2 "Balkonové dveře = křídlo + pevné" offset:[0,2]
		label lbO3 "okno s parapetem." offset:[0,0]

		label lbP "— Panelová fasáda —" offset:[0,8]
		checkbox chkSpary "Spáry mezi panely" checked:true
		spinner spSpara "Šířka spáry (m):" type:#float range:[0.01,0.15,0.04] scale:0.005 fieldwidth:58

		label lbD "— Okolo domu —" offset:[0,8]
		checkbox chkOplech "Oplechování atiky" checked:true
		checkbox chkSklep "Sklepní okénka v soklu" checked:true
		checkbox chkSvody "Dešťové svody" checked:true
		checkbox chkStrDet "Komínky a anténa na střeše" checked:true
		checkbox chkVstupDet "Tablo zvonků, lampa, číslo" checked:true
		spinner spHran "Hran trubek (svody, zábradlí):" type:#integer range:[4,16,8] fieldwidth:44 offset:[0,4]
	)

	rollout rBalkony "Balkony"
	(
		dropdownlist ddlBalkony "" items:#("bez balkonů", "vpředu", "vzadu", "z obou stran") selection:2
		spinner spKrok "Balkon na každé N-té ose:" type:#integer range:[1,6,1] fieldwidth:44
		spinner spBalkonOd "Od podlaží č.:" type:#integer range:[1,40,2] fieldwidth:44
		spinner spBHl "Hloubka (m):" type:#float range:[0.4,4,1.5] scale:0.05 fieldwidth:58
		slider  slBHl "" type:#float range:[0.4,4,1.5] ticks:0 width:150 offset:[0,-3]
		spinner spBSir "Šířka (m):" type:#float range:[0.8,12,3.0] scale:0.05 fieldwidth:58
		slider  slBSir "" type:#float range:[0.8,12,3.0] ticks:0 width:150 offset:[0,-3]
		spinner spBDeska "Tloušťka desky (m):" type:#float range:[0.05,0.6,0.18] scale:0.01 fieldwidth:58
		dropdownlist ddlZabradli "Zábradlí:" items:#("plné", "svislé tyče", "plné + madlo") selection:1
		spinner spZabrV "Výška zábradlí (m):" type:#float range:[0.4,2,1.1] scale:0.05 fieldwidth:58
		spinner spZabrT "Tloušťka zábradlí (m):" type:#float range:[0.02,0.4,0.1] scale:0.01 fieldwidth:58
		spinner spTyce "Rozteč tyčí (m):" type:#float range:[0.05,0.6,0.14] scale:0.01 fieldwidth:58
		checkbox chkBalkDvere "Balkonové dveře místo okna" checked:true

		on slBHl changed val do pnli_setParam #balkonHloubka val
		on slBSir changed val do pnli_setParam #balkonSirka val
		on rBalkony open do
			try
			(
				slBHl.value = balkonHloubka
				slBSir.value = balkonSirka
			)
			catch ()
	)

	rollout rVariace "Variace a vzory"
	(
		spinner spSeed "Seed (číslo varianty):" type:#integer range:[0,999,1] fieldwidth:58
		slider  slSeed "" type:#integer range:[0,999,1] ticks:0 width:150 offset:[0,-3]
		button  btnLos "Losuj variantu" width:170 height:22 offset:[0,2]

		label lbB "— Rozmístění balkonů —" offset:[0,8]
		dropdownlist ddlBVzor "" width:160 selection:1 \
			items:#("na všech osách", "svislé pásy (nad sebou)", "šachovnice (zig-zag)", \
					"diagonála (posun po patrech)", "dvojice s mezerou", "náhodně")
		label lbB2 "Rozteč řídí \"na každé N-té ose\"" offset:[0,1]
		spinner spBHust "Hustota (pro náhodně):" type:#float range:[0.05,1,0.5] scale:0.05 fieldwidth:58
		checkbox chkStridat "Střídat přední/zadní stranu"

		label lbC "— Barvy zábradlí —" offset:[0,8]
		dropdownlist ddlBarvy "" width:160 selection:1 \
			items:#("jedna barva", "po sloupcích", "po patrech", "šikmé pruhy", "náhodně")
		spinner spPocetBarev "Počet barev:" type:#integer range:[2,4,3] fieldwidth:58

		label lbF "— Barevné panely fasády —" offset:[0,8]
		dropdownlist ddlFVzor "" width:160 selection:1 \
			items:#("bez akcentů", "náhodné panely", "svislé pruhy", "vodorovné pásy")
		spinner spFHust "Podíl akcentů:" type:#float range:[0.05,1,0.25] scale:0.05 fieldwidth:58

		label lbS "— Rozsvícená okna —" offset:[0,8]
		spinner spSviti "Podíl svítících oken:" type:#float range:[0,1,0.0] scale:0.05 fieldwidth:58
		label lbS2 "0 = všechna zhasnutá" offset:[0,1]

		on slSeed changed val do pnli_setParam #seed val
		on btnLos pressed do panelakLosuj()
		on rVariace open do try (slSeed.value = seed) catch ()
	)

	rollout rVstupy "Vstupy a sekce"
	(
		label lblV1 "Počet vchodů = počet sekcí."
		label lblV2 "Každá sekce má svoje schodiště." offset:[0,0]
		spinner spVchody "Počet vchodů:" type:#integer range:[1,20,2] fieldwidth:58 offset:[0,3]
		slider  slVchody "" type:#integer range:[1,20,2] ticks:0 width:150 offset:[0,-3]
		spinner spDverS "Šířka dveří (m):" type:#float range:[0.8,6,1.8] scale:0.05 fieldwidth:58
		spinner spDverV "Výška dveří (m):" type:#float range:[1.8,4,2.3] scale:0.05 fieldwidth:58
		checkbox chkStriska "Stříška nad vstupem" checked:true
		spinner spStriskaS "Šířka stříšky (m):" type:#float range:[0.8,8,3.0] scale:0.1 fieldwidth:58
		spinner spStriskaH "Vyložení stříšky (m):" type:#float range:[0.2,4,1.4] scale:0.05 fieldwidth:58
		spinner spStriskaT "Tloušťka stříšky (m):" type:#float range:[0.05,0.5,0.18] scale:0.01 fieldwidth:58
		checkbox chkSchody "Schody před vstupem" checked:true
		spinner spSchodyS "Šířka schodů (m):" type:#float range:[0.8,8,2.4] scale:0.1 fieldwidth:58
		spinner spSchodyH "Hloubka stupně (m):" type:#float range:[0.2,0.6,0.32] scale:0.01 fieldwidth:58

		on slVchody changed val do pnli_setParam #vchody val
		on rVstupy open do try (slVchody.value = vchody) catch ()
	)

	rollout rStrecha "Střecha"
	(
		spinner spStrechaT "Tloušťka střechy (m):" type:#float range:[0.05,1,0.3] scale:0.05 fieldwidth:58
		spinner spAtikaV "Výška atiky (m):" type:#float range:[0,2,0.6] scale:0.05 fieldwidth:58
		spinner spAtikaT "Tloušťka atiky (m):" type:#float range:[0.05,1,0.25] scale:0.01 fieldwidth:58
		checkbox chkStrojovna "Strojovna nad vchody" checked:true
		spinner spStrojV "Výška strojovny (m):" type:#float range:[1,6,2.6] scale:0.1 fieldwidth:58
	)

	rollout rMat "Materiál a mapování"
	(
		checkbox chkMapovani "Generovat UV mapování" checked:true
		spinner spUV "Velikost dlaždice UV (m):" type:#float range:[0.05,20,1.0] scale:0.1 fieldwidth:58
		spinner spJednotky "1 m = ... jednotek:" type:#float range:[0.0001,10000,1.0] scale:1 fieldwidth:58
		button btnMat "Vytvořit a přiřadit materiál" width:170 height:22 offset:[0,4]
		button btnPoly "Vytvořit Editable Poly (kopii)" width:170 height:22 offset:[0,3]
		label lblInfo1 "Originál zůstane parametrický," offset:[0,4]
		label lblInfo2 "upravuj až tu kopii."

		on btnMat pressed do panelakInterierMaterial()
		on btnPoly pressed do panelakToPoly()
	)

	/*-------------------------- geometrie -------------------------------*/
	on buildMesh do
	(
		local cx = pnl_ctx()
		cx.V = #(); cx.F = #(); cx.M = #(); cx.TV = #(); cx.TF = #(); cx.S = #()
		local U  = amax 0.0001 unitsPerM
		local uv = if mapovani then (amax 0.001 (uvMeritko * U)) else 0.0

		local L  = amax (2.0 * U) (delka * U)
		local W  = amax (6.0 * U) (sirka * U)
		local NF = amax 1 podlazi
		local fh = amax (1.5 * U) (vyskaPodlazi * U)
		local t  = amin (amax (0.05 * U) (tlSteny * U)) (amin (L * 0.2) (W * 0.2))
		local zb = amax 0.0 (soklVyska * U)
		local so = amax 0.0 (soklPresah * U)
		local mrg = 0.25 * U

		local x0 = -L * 0.5, x1 = L * 0.5
		local y0 = -W * 0.5, y1 = W * 0.5
		local iy0 = y0 + t, iy1 = y1 - t

		-- řez: stavíme jen jedno podlaží?
		local rez = (rezPodlazi > 0 and rezPodlazi <= NF)
		local f1 = 1, f2 = NF
		if rez do ( f1 = rezPodlazi; f2 = rezPodlazi )
		local zLo = zb + (f1 - 1) * fh
		local zHi = zb + f2 * fh

		-- okenní osy
		local n = amax 1 pocetOsi
		if autoOsy do n = amax 1 ((floor (L / (amax (1.0 * U) (rozponOsy * U)) + 0.5)) as integer)
		local stepX = L / n
		local AX = for i = 1 to n collect (x0 + stepX * (i - 0.5))

		local oh = amin (amax (0.3 * U) (oknoVyska * U)) (fh - 0.4 * U)
		local ow = amin (amax (0.3 * U) (oknoSirka * U)) (stepX - 0.4 * U)
		local par = amax (0.0) (amin (parapet * U) (fh - oh - 0.25 * U))
		local hasWin = ow > 0.25 * U

		-- vchody = sekce
		local nsec = amax 1 vchody
		local SW = L / nsec
		local dw = amin (dverSirka * U) (SW - 0.8 * U)
		local dh = amin (dverVyska * U) (fh - 0.25 * U)
		local ne = nsec
		if dw < 0.6 * U do ( ne = 0; dw = 0.0 )
		local EX = for e = 1 to ne collect (x0 + SW * (e - 0.5))

		-- balkony: jedna mapa řídí balkony i balkonové dveře, takže spolu sedí
		local bmap = pnl_balcMap n NF balkonVzor (amax 1 balkonKrok) (amax 1 balkonOd) \
			balkonHustota balkony stridatStrany seed
		local bw = amin (amax (0.6 * U) (balkonSirka * U)) (stepX - 0.1 * U)
		local bd = amax (0.3 * U) (balkonHloubka * U)
		local bs = amax (0.03 * U) (balkonDeska * U)
		local rh = amax (0.3 * U) (zabradliVyska * U)
		local rt = amin (amax (0.02 * U) (zabradliTl * U)) (bd * 0.4)

		local fw = amax (0.01 * U) (ramSirka * U)
		local ins = amin (amax 0.0 (sklozap * U)) (t - fw * 1.2)
		if ins < 0.0 do ins = 0.0

		-- nastavení detailů výplní (rozměry už v jednotkách scény)
		local det = pnl_det()
		det.U = U
		det.ramy = ramy
		det.ram = fw
		det.zapusteni = ins
		det.deleni = amax 1 oknoDeleni
		det.nadsvetlik = oknaNadsvetlik
		det.nadsvetlikV = 0.45 * U
		det.parapetPlech = parapetPlech
		det.parapetTl = 0.04 * U
		det.parapetPresah = 0.07 * U
		det.balkonParapet = amax (0.2 * U) par
		det.dverKridla = amax 1 dverKridla
		det.dverNadsvetlik = true
		det.dverNadsvetlikV = 0.5 * U

		/*--- otvory ve fasádách ---*/
		local resF = pnl_facadeOps2 AX (if hasWin then n else 0) ow oh par zb fh NF \
			bmap 1 balkonoveDvere EX ne dw dh mrg
		local resB = pnl_facadeOps2 AX (if hasWin then n else 0) ow oh par zb fh NF \
			bmap 2 balkonoveDvere #() 0 dw dh mrg
		local opsF = resF[1], kndF = resF[2]
		local opsB = resB[1], kndB = resB[2]

		/*--- sokl se sklepními okénky ---*/
		if not rez do
		(
			if zb > 0.02 * U then
			(
				local sops = #()
				if sklepniOkna do
					for i = 1 to n do
					(
						local sow = amin (0.9 * U) (stepX * 0.4)
						local soh = amin (0.5 * U) (zb * 0.42)
						local soz = zb - soh - 0.12 * U
						if soz > 0.12 * U do
							append sops [ AX[i] - sow * 0.5, AX[i] + sow * 0.5, soz, soz + soh ]
					)
				local SR = pnl_wallRects (x0 - so) (x1 + so) 0 zb sops
				for r in SR do
				(
					pnl_addBox cx r.x (y0 - so) r.z r.y (y0 + t) r.w PNL_MAT_SOKL uv
					pnl_addBox cx r.x (y1 - t) r.z r.y (y1 + so) r.w PNL_MAT_SOKL uv
				)
				pnl_addBox cx (x0 - so) (y0 + t) 0 (x0 + t) (y1 - t) zb PNL_MAT_SOKL uv
				pnl_addBox cx (x1 - t) (y0 + t) 0 (x1 + so) (y1 - t) zb PNL_MAT_SOKL uv
				pnl_addBox cx (x0 - so) (y0 - so) 0 (x1 + so) (y1 + so) (0.15 * U) PNL_MAT_SOKL uv
				for op in sops do
				(
					pnl_addBox cx op.x (y0 - so + 0.05 * U) op.z op.y (y0 - so + 0.09 * U) op.w PNL_MAT_SKLO uv
					pnl_addBox cx op.x (y1 + so - 0.09 * U) op.z op.y (y1 + so - 0.05 * U) op.w PNL_MAT_SKLO uv
				)
			)
			else
				pnl_addBox cx x0 y0 (-0.25 * U) x1 y1 0 PNL_MAT_SOKL uv
		)

		/*--- obvodové stěny (jen stavěný svislý rozsah) ---*/
		local R = pnl_wallRects x0 x1 zLo zHi opsF
		for r in R do
			pnl_addBox cx r.x y0 r.z r.y (y0 + t) r.w \
				(pnl_fasadaMat ((r.x + r.y) * 0.5) ((r.z + r.w) * 0.5) fasadaVzor fasadaHustota stepX fh seed) uv

		R = pnl_wallRects x0 x1 zLo zHi opsB
		for r in R do
			pnl_addBox cx r.x (y1 - t) r.z r.y y1 r.w \
				(pnl_fasadaMat ((r.x + r.y) * 0.5) ((r.z + r.w) * 0.5) fasadaVzor fasadaHustota stepX fh (seed + 5)) uv

		local opsG = #()
		if stitOkna > 0 do
		(
			local sy = (W - 2 * t) / stitOkna
			local gw = amin (oknoSirka * U) (sy - 0.4 * U)
			if gw > 0.25 * U do
				for f = f1 to f2 do
				(
					local zf = zb + (f - 1) * fh
					for k = 1 to stitOkna do
					(
						local yc = iy0 + sy * (k - 0.5)
						append opsG [ yc - gw * 0.5, yc + gw * 0.5, zf + par, zf + par + oh ]
					)
				)
		)
		R = pnl_wallRects iy0 iy1 zLo zHi opsG
		for r in R do
		(
			pnl_addBox cx x0 r.x r.z (x0 + t) r.y r.w PNL_MAT_FASADA uv
			pnl_addBox cx (x1 - t) r.x r.z x1 r.y r.w PNL_MAT_FASADA uv
		)

		/*--- výplně otvorů (jen ty ve stavěném rozsahu) ---*/
		for j = 1 to opsF.count do
			if opsF[j].z > zLo - mrg and opsF[j].w < zHi + mrg do
				pnl_fillOpening cx opsF[j] kndF[j] true y0 1.0 det (pnl_skloMat opsF[j] oknaSviti seed) uv
		for j = 1 to opsB.count do
			if opsB[j].z > zLo - mrg and opsB[j].w < zHi + mrg do
				pnl_fillOpening cx opsB[j] kndB[j] true y1 (-1.0) det (pnl_skloMat opsB[j] oknaSviti (seed + 5)) uv
		for o in opsG do
		(
			pnl_fillOpening cx o 1 false x0 1.0 det (pnl_skloMat o oknaSviti (seed + 9)) uv
			pnl_fillOpening cx o 1 false x1 (-1.0) det (pnl_skloMat o oknaSviti (seed + 13)) uv
		)

		/*--- spáry mezi panely ---*/
		if spary do
		(
			local ss = amax (0.01 * U) (sparaSirka * U)
			local sv = 0.025 * U
			local modY = amax (1.5 * U) (rozponOsy * U)
			pnl_spary cx true x0 x1 y0 1.0 zLo zHi stepX fh ss sv uv
			pnl_spary cx true x0 x1 y1 (-1.0) zLo zHi stepX fh ss sv uv
			pnl_spary cx false iy0 iy1 x0 1.0 zLo zHi modY fh ss sv uv
			pnl_spary cx false iy0 iy1 x1 (-1.0) zLo zHi modY fh ss sv uv
		)

		/*--- balkony ---*/
		for f = f1 to f2 do
		(
			local zf = zb + (f - 1) * fh
			for i = 1 to n do
			(
				local bv = bmap[f][i]
				if bv > 0 do
				(
					local mr = pnl_balcMat f i zabradliBarvy pocetBarev seed
					if bv == 1 or bv == 3 do
						pnl_balkon cx AX[i] y0 (-1.0) zf bw bd bs rh rt zabradliTyp (tyceKrok * U) mr uv
					if bv == 2 or bv == 3 do
						pnl_balkon cx AX[i] y1 1.0 zf bw bd bs rh rt zabradliTyp (tyceKrok * U) mr uv
				)
			)
		)

		/*--- vstupy ---*/
		if f1 == 1 do
			for e = 1 to ne do
			(
				local xe = EX[e]
				if strisky do
				(
					local cw = amax (dw + 0.4 * U) (striskaSirka * U)
					local cd = amax (0.2 * U) (striskaHloubka * U)
					local ct = amax (0.04 * U) (striskaTl * U)
					local zc = zb + dh + 0.12 * U
					pnl_addBox cx (xe - cw * 0.5) (y0 - cd) zc \
						(xe + cw * 0.5) (y0 + t * 0.5) (zc + ct) PNL_MAT_STRECHA uv
				)
				if schody and zb > 0.05 * U do
				(
					local ns = amax 1 ((ceil (zb / (0.17 * U))) as integer)
					local hs = zb / ns
					local ds = amax (0.15 * U) (schodyHloubka * U)
					local stw = amax (dw + 0.4 * U) (schodySirka * U)
					for k = 1 to ns do
						pnl_addBox cx (xe - stw * 0.5) (y0 - (ns - k + 1) * ds) 0 \
							(xe + stw * 0.5) y0 (k * hs) PNL_MAT_SOKL uv
					/*	Trubkové zábradlí kopírující sklon schodů:
						madlo jde šikmo od spodního sloupku k hornímu, souběžně
						s hranami stupňů, a pod ním vede druhá trubka.        */
					local rr = 0.025 * U
					local hr = amax 4 trubkaHran
					local rvys = 0.95 * U
					local yRa = y0 - ns * ds
					local zRa = hs + rvys
					local yRb = y0 - ds * 0.5
					local zRb = zb + rvys
					local hw = stw * 0.5
					for sgn in #(-1.0, 1.0) do
					(
						local hx = xe + sgn * (hw - rr)
						pnl_addPipe2 cx [hx, yRa, 0] [hx, yRa, zRa] rr hr PNL_MAT_ZABRADLI uv
						pnl_addPipe2 cx [hx, yRb, 0] [hx, yRb, zRb] rr hr PNL_MAT_ZABRADLI uv
						pnl_addPipe2 cx [hx, yRa, zRa] [hx, yRb, zRb] rr hr PNL_MAT_ZABRADLI uv
						pnl_addPipe2 cx [hx, yRa, zRa - 0.4 * U] [hx, yRb, zRb - 0.4 * U] rr hr PNL_MAT_ZABRADLI uv
					)
				)
				if vstupDetail do
				(
					pnl_addBox cx (xe + dw * 0.5 + 0.25 * U) (y0 - 0.05 * U) (zb + 1.15 * U) \
						(xe + dw * 0.5 + 0.47 * U) (y0 + 0.02 * U) (zb + 1.5 * U) PNL_MAT_DROBNOSTI uv
					pnl_addBox cx (xe - 0.15 * U) (y0 - 0.24 * U) (zb + dh + 0.3 * U) \
						(xe + 0.15 * U) (y0 + 0.02 * U) (zb + dh + 0.46 * U) PNL_MAT_DROBNOSTI uv
					pnl_addBox cx (xe - dw * 0.5 - 0.55 * U) (y0 - 0.04 * U) (zb + dh + 0.45 * U) \
						(xe - dw * 0.5 - 0.1 * U) (y0 + 0.02 * U) (zb + dh + 0.78 * U) PNL_MAT_DROBNOSTI uv
				)
			)

		/*--- střecha ---*/
		local rtk = amax (0.04 * U) (strechaTl * U)
		if not rez do
		(
			pnl_addBox cx x0 y0 zHi x1 y1 (zHi + rtk) PNL_MAT_STRECHA uv
			local ah = amax 0.0 (atikaVyska * U)
			if ah > 0.02 * U do
			(
				local atk = amin (amax (0.04 * U) (atikaTl * U)) (amin (L * 0.2) (W * 0.2))
				local za = zHi + rtk
				local zc = za + ah
				pnl_addBox cx x0 y0 za x1 (y0 + atk) zc PNL_MAT_STRECHA uv
				pnl_addBox cx x0 (y1 - atk) za x1 y1 zc PNL_MAT_STRECHA uv
				pnl_addBox cx x0 (y0 + atk) za (x0 + atk) (y1 - atk) zc PNL_MAT_STRECHA uv
				pnl_addBox cx (x1 - atk) (y0 + atk) za x1 (y1 - atk) zc PNL_MAT_STRECHA uv
				if oplechovani do
				(
					local ov = 0.07 * U
					local ot = 0.05 * U
					pnl_addBox cx (x0 - ov) (y0 - ov) zc (x1 + ov) (y0 + atk + ov) (zc + ot) PNL_MAT_KLEMP uv
					pnl_addBox cx (x0 - ov) (y1 - atk - ov) zc (x1 + ov) (y1 + ov) (zc + ot) PNL_MAT_KLEMP uv
					pnl_addBox cx (x0 - ov) (y0 + atk) zc (x0 + atk + ov) (y1 - atk) (zc + ot) PNL_MAT_KLEMP uv
					pnl_addBox cx (x1 - atk - ov) (y0 + atk) zc (x1 + ov) (y1 - atk) (zc + ot) PNL_MAT_KLEMP uv
				)
			)
			if svody do
			(
				local pr = 0.07 * U
				local zt2 = zHi + rtk + ah
				local hr = amax 4 trubkaHran
				-- svody patří na štítové stěny, na podélných fasádách by lezly do balkonů
				local PX = #(x0 - pr * 1.25, x1 + pr * 1.25)
				local PY = #(y0 + 0.7 * U, y1 - 0.7 * U)
				for sx in PX do
					for sy in PY do
					(
						pnl_addPipe cx 3 0 zt2 sx sy pr hr PNL_MAT_KLEMP uv
						pnl_addPipe cx 3 0 (0.5 * U) sx sy (pr * 1.35) hr PNL_MAT_KLEMP uv
						pnl_addPipe cx 3 (zt2 * 0.35 - 0.04 * U) (zt2 * 0.35 + 0.04 * U) sx sy (pr * 1.5) hr PNL_MAT_KLEMP uv
						pnl_addPipe cx 3 (zt2 * 0.7 - 0.04 * U) (zt2 * 0.7 + 0.04 * U) sx sy (pr * 1.5) hr PNL_MAT_KLEMP uv
					)
			)
			if strechaDetail do
			(
				local zr2 = zHi + rtk
				local nv = amax 2 ((floor (L / (7.0 * U))) as integer)
				for k = 1 to nv do
				(
					local vx = x0 + L * (k - 0.5) / nv
					local vy = ((pnl_hash (k * 4.1) 1.0 seed) - 0.5) * (W - 3.0 * U)
					local vd = 0.3 * U
					local vh = (0.5 + (pnl_hash (k * 2.7) 2.0 seed)) * 0.7 * U
					pnl_addBox cx (vx - vd * 0.5) (vy - vd * 0.5) zr2 (vx + vd * 0.5) (vy + vd * 0.5) (zr2 + vh) PNL_MAT_KLEMP uv
					pnl_addBox cx (vx - vd * 0.85) (vy - vd * 0.85) (zr2 + vh) \
						(vx + vd * 0.85) (vy + vd * 0.85) (zr2 + vh + 0.08 * U) PNL_MAT_KLEMP uv
				)
				local amx = x0 + L * 0.35
				pnl_addBox cx (amx - 0.05 * U) (-0.05 * U) zr2 (amx + 0.05 * U) (0.05 * U) (zr2 + 3.5 * U) PNL_MAT_KLEMP uv
				pnl_addBox cx (amx - 0.5 * U) (-0.04 * U) (zr2 + 2.6 * U) (amx + 0.5 * U) (0.04 * U) (zr2 + 2.68 * U) PNL_MAT_KLEMP uv
				pnl_addBox cx (amx - 0.4 * U) (-0.04 * U) (zr2 + 3.0 * U) (amx + 0.4 * U) (0.04 * U) (zr2 + 3.08 * U) PNL_MAT_KLEMP uv
			)
			if strojovna and ne > 0 do
				for e = 1 to ne do
				(
					-- pozor: MAXScript nerozlišuje velikost písmen, takže se tyhle
					-- proměnné nesmí jmenovat sw/sd - zastínily by SW (šířku sekce)
					local mrw = amin (3.6 * U) (SW - 1.0 * U)
					local mrd = amin (3.2 * U) (W - 2.0 * U)
					local mrh = amax (0.5 * U) (strojovnaVyska * U)
					local za = zHi + rtk
					if mrw > 0.5 * U and mrd > 0.5 * U do
					(
						pnl_addBox cx (EX[e] - mrw * 0.5) (-mrd * 0.5) za \
							(EX[e] + mrw * 0.5) (mrd * 0.5) (za + mrh) PNL_MAT_FASADA uv
						pnl_addBox cx (EX[e] - mrw * 0.5 - 0.15 * U) (-mrd * 0.5 - 0.15 * U) (za + mrh) \
							(EX[e] + mrw * 0.5 + 0.15 * U) (mrd * 0.5 + 0.15 * U) (za + mrh + 0.18 * U) \
							PNL_MAT_STRECHA uv
					)
				)
		)

		/*======================= INTERIÉR ==============================*/
		if interier do
		(
			local stl = amax (0.03 * U) (stropTl * U)
			local nwt = amax (0.05 * U) (nosnaTl * U)
			local pt  = amax (0.03 * U) (prickaTl * U)
			local dwi = amax (0.4 * U) (dverSirkaInt * U)
			local dhi = amin (amax (1.4 * U) (dverVyskaInt * U)) (fh - stl - 0.1 * U)
			local hh  = amax (1.0 * U) (fh - stl)
			local roomW = amax (1.5 * U) (pokojSirka * U)
			local bathW = amax (1.0 * U) (koupelnaS * U)
			local chD = amax (1.0 * U) (chodbaHl * U)
			local riser = 0.17 * U

			-- střední pás (předsíň) - musí sedět s dveřmi ve stěně jádra
			local MD = amin (amax (1.2 * U) (stredniPas * U)) ((iy1 - iy0) * 0.4)
			local FD = ((iy1 - iy0) - MD) * 0.5
			local yA = iy0 + FD
			local yB = yA + MD
			local yh = (yA + yB) * 0.5

			for f = f1 to f2 do
			(
				local zf = zb + (f - 1) * fh
				local z2 = zf + hh

				-- podlahová deska
				if stropy do
					pnl_addBox cx (x0 + t) iy0 (zf - stl) (x1 - t) iy1 zf PNL_MAT_PODLAHA uv

				for s = 1 to nsec do
				(
					local sx0 = x0 + SW * (s - 1)
					local sx1 = sx0 + SW
					local scc = (sx0 + sx1) * 0.5
					local jadW = amin (amax (2.0 * U) (jadroSirka * U)) (SW * 0.6)
					local jx0 = scc - jadW * 0.5
					local jx1 = scc + jadW * 0.5

					-- dělicí nosná stěna mezi sekcemi
					if s > 1 do
						pnl_wallAlongY cx iy0 iy1 sx0 nwt zf z2 #() PNL_MAT_NOSNA uv

					-- stěny jádra, v každé jedny bytové dveře
					pnl_wallAlongY cx iy0 iy1 jx0 nwt zf z2 \
						#(pnli_dvere yh dwi zf (zf + dhi)) PNL_MAT_NOSNA uv
					pnl_wallAlongY cx iy0 iy1 jx1 nwt zf z2 \
						#(pnli_dvere yh dwi zf (zf + dhi)) PNL_MAT_NOSNA uv

					-- příčka mezi vstupní chodbou a schodištěm, s průchodem
					local yj = amin (iy0 + chD) (iy1 - 2.0 * U)
					local prus = amin (1.4 * U) (jadW * 0.5)
					pnl_wallAlongX cx jx0 jx1 yj pt zf z2 \
						#(pnli_dvere scc prus zf (zf + amax dhi (2.1 * U))) PNL_MAT_PRICKA uv

					-- Schodiště až za pásem předsíně: mezi příčkou chodby a rameny
					-- zůstane podesta, na kterou ústí bytové dveře (ty jsou v ose yh).
					if schodiste do
						pnli_schodiste cx (jx0 + nwt * 0.5) (jx1 - nwt * 0.5) \
							(amax (yj + pt * 0.5) yB) iy1 zf fh riser U uv

					-- byty po stranách jádra
					pnli_byt cx sx0 jx0 iy0 iy1 yA yB zf hh pt dwi dhi roomW bathW 1.0 U uv
					pnli_byt cx jx1 sx1 iy0 iy1 yA yB zf hh pt dwi dhi roomW bathW (-1.0) U uv
				)
			)
		)

		/*--- sestavení meshe ---*/
		if cx.V.count < 3 do
			pnl_addBox cx x0 y0 0 x1 y1 (1.0 * U) PNL_MAT_FASADA uv

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

/*--- nastavení parametru u vybraných objektů --------------------------------*/
fn pnli_setParam pname val =
(
	for o in (selection as array) where (isKindOf o PanelakInterierGeo) do
		setProperty o pname val
	ok
)

/*--- materiál (deleguje na společný 18slotový z panelak.ms) -----------------*/
fn panelakInterierMaterial nodes:unsupplied =
(
	-- materiál je společný pro obě verze (18 slotů), definovaný v panelak.ms
	local trg = if nodes == unsupplied then (selection as array) else nodes
	if trg.count == 0 do trg = for o in objects where (classof o) == PanelakInterierGeo collect o
	panelakMaterial nodes:trg
)

/*--------------------------- tlačítko do toolbaru ---------------------------*/
macroScript PanelakInterierCreate
	category:"Panelak"
	buttonText:"Panelak interier"
	tooltip:"Vytvorit parametricky panelak s interierem"
(
	on execute do
	(
		local p = PanelakInterierGeo name:(uniquename "PanelakInterier")
		select p
		max modify mode
	)
)

format "\nPanelák (interiér): plugin načten. Create > Geometry > kategorie \"Panelák\".\n"
