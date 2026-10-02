# Panelák — parametrický model pro 3ds Max

Dva samostatné *scripted pluginy* (vlastní typy geometrie). Vytvoří objekt, jehož
rozměry jdou kdykoliv později měnit slidery a spinnery v Modify panelu — model se
přepočítá okamžitě.

| soubor | co dělá |
|--------|---------|
| `panelak.ms` | **Panelák** — jen vnější plášť: fasáda s okny, balkony, vstupy, střecha |
| `panelak-interier.ms` | **Panelák (interiér)** — totéž plus vnitřek: schodišťová jádra, chodby, byty, pokoje, koupelny |

Obě verze fungují vedle sebe a jsou na sobě nezávislé z pohledu scény — jen
`panelak-interier.ms` si z `panelak.ms` bere sdílené funkce, takže **musí ležet
ve stejné složce**. Načte si ho sám, a to pokaždé — spustit stačí interiérovou
verzi a základ se aktualizuje s ní.

## Instalace

1. V Maxu: **Scripting → Run Script…** → vyber `panelak.ms`
   (nebo skript přetáhni myší do viewportu).
2. Aby se plugin načítal sám po startu Maxu, zkopíruj soubor do
   `C:\Users\<jméno>\AppData\Local\Autodesk\3dsMax\<verze>\ENU\scripts\startup\`.

## Vytvoření domu

- **Create → Geometry → rozbalovací seznam „Panelák" → tlačítko Panelák**, pak
  jedním kliknutím do pohledu (netahat) — dům se postaví na kliknuté místo.
- nebo v Listeneru: `PanelakGeo()`
- Skript zároveň registruje makro **Panelak** (kategorie „Panelak") — v
  *Customize → Customize User Interface → Toolbars* ho přetáhneš na panel jako tlačítko.
  (Název makra je bez diakritiky schválně — makra s diakritikou se na tomhle
  stroji při startu Maxu nenačítají.)

Pak přepni na **Modify panel** — tam je všechno nastavení.

> **Když načítáš novou verzi skriptu:** smaž staré paneláky ze scény a Max
> restartuj (nebo *File → Reset*). MAXScript neumí za běhu předefinovat typ
> pluginu, když ve scéně existují jeho objekty — staré objekty by se pak
> nepřepočítávaly.

## Jednotky

Všechny rozměry se zadávají **v metrech**. Pokud máš scénu v centimetrech nebo
milimetrech, nastav v rollupu *Materiál a mapování* položku **„1 m = … jednotek"**
na `100` (cm) resp. `1000` (mm). Pole v panelu zůstanou v metrech, model se
postaví ve správné velikosti.

## Parametry

**Rozměry domu** — délka, hloubka, počet podlaží a výška podlaží mají slider i spinner.
Dál tloušťka stěn, výška a přesah soklu, volitelné vnitřní stropní desky.

**Fasáda a okna** — okenní osy se buď dopočítají z délky domu podle zadaného
rozponu (výchozí 3,6 m), nebo se zadá pevný počet os. Šířka/výška okna, parapet,
rámy, zapuštění zasklení do líce, okna ve štítu.

**Balkony** — žádné / vpředu / vzadu / z obou stran, balkon na každé N‑té ose,
od kterého podlaží, hloubka, šířka, tloušťka desky. Zábradlí plné, svislé tyče
nebo plné s madlem. Volba „balkonové dveře místo okna" protáhne otvor až k podlaze.

**Vstupy** — počet vchodů (rozmístí se rovnoměrně po délce), volitelně i ze zadní
strany, rozměry dveří, stříška nad vstupem a schody k soklu. Okna v přízemí, která
by kolidovala se vstupem, se automaticky vynechají.

**Střecha** — tloušťka stropní desky, výška a tloušťka atiky, strojovny nad vchody.

**Materiál a mapování** — generování UV (world‑aligned box mapping, velikost
dlaždice v metrech) a tlačítko **„Vytvořit a přiřadit materiál"**, které udělá
Multi/Sub‑Object materiál s těmito ID:

| ID | materiál | | ID | materiál |
|----|----------|-|----|----------|
| 1 | fasáda | | 11 | podlahy |
| 2 | sokl | | 12 | schodiště |
| 3 | sklo | | 13 | vnitřní dveře |
| 4 | rámy oken | | 14 | zábradlí 2 |
| 5 | zábradlí 1 | | 15 | zábradlí 3 |
| 6 | balkonové desky | | 16 | zábradlí 4 |
| 7 | střecha / atika | | 17 | fasáda akcent 1 |
| 8 | vstupní dveře | | 18 | fasáda akcent 2 |
| 9 | nosné stěny | | 19 | okno svítí teple |
| 10 | příčky | | 20 | okno svítí bíle |
| | | | 21 | spáry panelů |
| | | | 22 | klempířina |
| | | | 23 | drobnosti |

Materiál je společný pro obě verze — v té bez interiéru zůstanou sloty 9–13
prostě nevyužité.

### Sklo ve V-Ray

Slot 3 se vytvoří jako **VRayMtl**, když je V-Ray k dispozici. Nastavení míří na
realistické okenní sklo:

- odraz řídí **Fresnel** (IOR 1,52) — kolmo je sklo skoro čiré, při ostrém úhlu se
  zrcadlí, takže se to leskne jen „trošku" a ne jako zrcadlo
- lom má **IOR 1,0**, takže obraz neláme a je vidět dovnitř, jen mírně ztlumeně
- tmavý diffuse dělá to, že prázdný interiér působí jako tma za sklem
- ostrý odraz i lom (glossiness 1,0), takže to nerenderuje zbytečně dlouho

Rozsvícená okna (19, 20) dostanou **VRayLightMtl** s kompenzací expozice.

Když V-Ray nainstalovaný není, spadne to na Physical Material s průhledností
a úplně nejhůř na Standard s opacitou — na hlášce v Listeneru po stisku tlačítka
je vidět, co se použilo. Každá vlastnost se nastavuje zvlášť a chráněně, protože
VRayMtl mění názvy parametrů mezi verzemi; když nějakou neumí, zbytek se nastaví.

Zasklení **vstupních dveří** teď taky používá sklo (dřív mělo materiál dveří);
rámy, křídla a madla zůstávají na slotu 8.

Materiálová ID jsou v meshi nastavená vždy, i bez toho tlačítka — klidně si na ně
napoj vlastní Multi/Sub‑Object materiál.

## Detaily

Rollup **Detaily** má obě verze. Všechno jde vypnout — při ladění proporcí se to
vyplatí, protože detaily stojí dost polygonů.

**Okna** nejsou jen sklo v díře: mají obvodový rám, svislé sloupky mezi křídly
(1–4 křídla), volitelně nadsvětlík a hlavně **vnější parapetní plech**, který
přesahuje přes líc fasády. Ten je na paneláku vidět na každém okně.

**Balkonové dveře** jsou složené správně: dveřní křídlo (cca 95 cm) se spodním
rámem a klikou, vedle něj sloupek a pevné okno s parapetním panelem odspodu.
U dveřní části je práh, u pevné části parapetní plech.

**Vstupní dveře** mají nadsvětlík oddělený příčkou, dvě (nebo 1–3) křídla se
středovým sloupkem, neprůhledný spodní panel každého křídla a svislá madla, která
odstávají od roviny dveří.

**Spáry mezi panely** — svislé po okenních osách, vodorovné po patrech. Tohle je
ta mřížka, podle které se panelák pozná na první pohled. Spáry nekolidují s okny:
svislé jdou mezi osami, vodorovné v úrovni stropů pod parapety.

**Sokl** se nově staví jako stěny s otvory, ne jako plný kvádr, takže jdou udělat
**sklepní okénka** a je do nich vidět tma.

**Dešťové svody** jsou skutečné trubky (n-boký hranol s hladkým pláštěm): čtyři
u rohů **na štítových stěnách**, s rozšířeným kusem u země a objímkami ke stěně.
Na štítech jsou schválně — na podélné fasádě by kolidovaly s balkony.

**Zábradlí u vstupních schodů** je trubkové a **kopíruje sklon schodů**: spodní
a horní sloupek, mezi nimi šikmé madlo souběžné s hranami stupňů a pod ním druhá
trubka.

Počet hran trubek se dá nastavit (4–16, výchozí 8); víc hran = hladší, ale víc
polygonů.

Dál: **oplechování atiky** (přesahuje přes obě hrany, mění siluetu střechy),
**komínky a anténní stožár** na střeše rozmístěné podle seedu, a u vchodu
**tablo zvonků, lampa nad dveřmi a číslo popisné**.

### Co to stojí

S detaily má běžný dům klidně 40–50 tisíc polygonů a tažení slideru se zpomalí.
Při hledání proporcí vypni *Spáry mezi panely* a *Vnější parapetní plechy*
(ty dvě věci jich dělají nejvíc), na konci zapni zpátky.

## Variace a vzory

Rollup **Variace a vzory** má obě verze. Všechno se odvozuje od **seedu** — je to
číslo varianty, ne skutečná náhoda. Stejný seed dá vždycky stejný dům, takže se
model nemění při každém přepočtu a varianta, která se ti líbí, se dá zapsat a
kdykoliv vrátit. Tlačítko **„Losuj variantu"** přehází seed a vzory u všech
vybraných paneláků naráz (rozměry domu nechá být).

**Rozmístění balkonů** — tohle je ta hlavní věc, balkony už nemusí být nad sebou:

| vzor | jak vypadá |
|------|-----------|
| na všech osách | klasika, plná fasáda balkonů |
| svislé pásy | balkony jen v některých osách, ale nad sebou |
| šachovnice (zig-zag) | střídá se patro po patře, nikdy nejsou nad sebou |
| diagonála | každé patro posun o jednu osu → šikmé pruhy přes fasádu |
| dvojice s mezerou | dva vedle sebe, mezera, dva vedle sebe |
| náhodně | rozhází je podle seedu, hustotu řídí posuvník |

Rozteč u „svislých pásů", „diagonály" a „dvojic" bere hodnota *Balkon na každé
N-té ose* z rollupu Balkony. Zaškrtávátko **Střídat přední/zadní stranu** u
oboustranných balkonů hodí každý balkon jen na jednu stranu a střídá je, takže
dům není symetrický.

Balkonové dveře se řídí **tou samou mapou**, takže dveře jsou vždycky přesně tam,
kde je balkon — ať zvolíš jakýkoliv vzor.

**Barvy zábradlí** — čtyři barevné varianty (ID materiálu 5, 14, 15, 16),
přidělované buď po sloupcích, po patrech, šikmými pruhy nebo náhodně. Tohle dělá
z jednoho domu hodně různých domů, protože barevné balkony jsou po zateplení to
první, čeho si člověk na paneláku všimne.

**Barevné panely fasády** — část fasádních dílců dostane akcentní materiál
(ID 17 a 18): buď náhodně rozházené panely, svislé pruhy po okenních osách, nebo
vodorovné pásy po patrech.

**Rozsvícená okna** — podíl oken dostane svítící materiál (ID 19 teplé, 20 bílé),
rozmístěná podle seedu. Pro noční vizualizaci; při 0 jsou všechna zhasnutá.
Tlačítko na materiál těm dvěma slotům rovnou zapne emisi.

## Verze s interiérem

`panelak-interier.ms` přidá typ **Panelák (interiér)** se stejnými parametry
pláště a navíc rollupem **Interiér**.

Dispozice vychází z toho, jak paneláky opravdu fungují. Dům se dělí na **sekce** —
jedna sekce = jeden vchod. Uprostřed každé sekce je schodišťové jádro přes celou
hloubku traktu: vepředu vstupní chodba (za vchodovými dveřmi), vzadu dvouramenné
schodiště s mezipodestou. Po stranách jádra jsou v každém podlaží dva byty,
přístupné dveřmi ze schodišťové podesty.

Byt je členěný od přední fasády dozadu:

```
pokoje s okny | předsíň | koupelna + WC | zadní pokoje s okny
```

Počet pokojů v přední i zadní zóně se dopočítá z šířky bytu a cílové šířky pokoje,
takže širší sekce dá 3+1 nebo 4+1 místo 2+1. Koupelna a WC jsou bez oken uprostřed
dispozice, dveřmi do předsíně. Všechny vnitřní stěny mají skutečné dveřní otvory.

Parametry navíc: šířka jádra, hloubka vstupní chodby, tloušťka nosných stěn a
příček, hloubka předsíně, cílová šířka pokoje, šířka bloku koupelny s WC, rozměry
vnitřních dveří, podlahové desky.

**„Jen podlaží č."** je asi nejužitečnější přepínač: když nastavíš třeba 3,
postaví se jen třetí podlaží (bez soklu a střechy) a můžeš se na dispozici
podívat shora jako na půdorys. 0 = celý dům.

### Rychlost

Dům s interiérem má klidně 30 000 polygonů a přestavba při tažení slideru chvíli
trvá. Když ladíš proporce domu, vypni *Stavět vnitřek*; na dispozici si přepni
*Jen podlaží č.* na jedno patro. Na závěr zapni všechno zpátky.

## Poznámky

- Slidery hýbou modelem živě při tažení. Když naopak přepíšeš číslo ve spinneru,
  model se změní hned, ale jezdec slideru se dorovná až po sbalení a rozbalení
  rollupu.
- Model je jeden mesh složený z kvádrů (fasáda má skutečné otvory, ne jen
  namapované okno).
- Na ruční úpravy použij tlačítko **„Vytvořit Editable Poly (kopii)"** v rollupu
  *Materiál a mapování*, ne příkaz *Convert to Editable Poly* z pravého tlačítka —
  ten u scripted pluginů umí vyrobit prázdný objekt. Tlačítko vezme přesně tu síť,
  která je vidět v pohledu, a udělá z ní samostatný objekt; originál zůstane
  parametrický (klidně ho pak smaž). Do Listeneru se vypíše počet vertů a faců.
- Model stojí na `Z = 0`, pivot je uprostřed půdorysu. Přední fasáda (ta se
  vstupy) směřuje do **−Y**.
- Hodně velký dům s rámy oken a tyčovým zábradlím může mít desítky tisíc
  polygonů a přestavba při tažení slideru se zpomalí. Při ladění proporcí vypni
  *Rámy oken* a dej zábradlí *plné*, na závěr zapni zpátky.
- Vše se hlídá proti nesmyslným kombinacím (okno širší než osa, dveře vyšší než
  podlaží apod.) — hodnoty se automaticky ořežou, model se nerozbije.

## Skriptování

Objekt jde vytvořit i s parametry rovnou z kódu:

```maxscript
p = PanelakGeo name:"Dum A" delka:48.0 sirka:13.0 podlazi:12 \
      vchody:3 balkony:4 zabradliTyp:2 stitOkna:1
panelakMaterial nodes:#(p)
```
