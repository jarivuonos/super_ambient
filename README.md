# Potilastyötila – FHIR- ja ambient-kirjaamisen demo

Paikallinen, suomenkielinen web-demo, jossa kliinikko valitsee **synteettisen** potilaan ja palvelukontaktin ja voi samassa työtilassa:

1. **Kysyä potilastiedoista.** Kysymyksestä tulkitaan skeemavalidoitu tiedontarve. Palvelin muodostaa siitä sallitut FHIR-lukuhaut, ja vastaus sidotaan lähderesursseihin.
2. **Kirjata harjoitusvastaanoton.** Tarjolla ovat äänitys, liitetty litteraatti, käyntimerkintäluonnos ja rakenteiset ehdotukset.
3. **Tarkistaa, hyväksyä ja tallentaa** hyväksytyt kohdat HAPIin yhtenä transactionina sekä lukea ne takaisin.

> Oletuskohde on julkinen HAPI FHIR R4 -testipalvelin (`https://hapi.fhir.org/baseR4`). Se ei tarjoa yksityisyyttä, ja sen sisältö nollataan ajoittain. Lähteen voi vaihtaa yläpalkin valitsimesta; toinen lähde on Epicin avoin sandbox (vain luku, SMART-kirjautuminen), katso ”FHIR-lähteet ja kirjautuminen”. Käytä vain synteettistä aineistoa ja harjoituspuhetta. Sovellus ei tee hoitopäätöksiä.

## Käynnistys

Vaatimukset: [Bun](https://bun.sh) (projekti käyttää bunia, Node ei ole pakollinen).

```bash
bun install
cp .env.example .env.local    # valinnainen; oletukset toimivat
bun run dev                   # http://localhost:3000
```

Tuotantobuild: `bun run build && bun run start`. Jos Nodea ei ole asennettu ja Next ei käynnisty, käytä `bun --bun next dev`.

| Komento | Tarkoitus |
| --- | --- |
| `bun run typecheck` | TypeScript-tarkistus |
| `bun run lint` | ESLint |
| `bun run test` | Yksikkö- ja integraatiotestit muistinvaraista FHIR-jäljitelmää vasten (ei verkkoa, ei kirjoituksia HAPIin) |
| `SMOKE_HAPI=1 bun run smoke:hapi` | **Erillinen smoke-testi, joka kirjoittaa julkiseen HAPIin** synteettisen aineiston ja testitallennuksen |
| `bun run eval:structure` | Litteraatin rakenteistuksen arviointi 13 synteettisellä suomenkielisellä keskustelulla (126 käsin merkittyä yksikköä, joista 20 on yhdistelmälauseiden osia): mock-säännöt. Ei verkkoyhteyksiä. Lisäämällä `-- --jev` ajetaan myös Jev-hybridi (peräkkäin ~120 pientä kutsua; **lähettää synteettisten lauseiden tekstit Typesafelle**). Tulostaa tyyppi-, kielteisyys-, ”kenestä”- ja epäröintitarkkuuden sekä **vaarallisten FHIR-kohteiden** määrän. |
| `bun run eval:interpret` | Kysymystulkinnan arviointi 41 + 38 suomenkielisellä kysymyksellä (perusjoukko ja vaikeampi joukko): mock-säännöt. Ei verkkoyhteyksiä. Lisäämällä `-- --jev` ajetaan myös Jev (peräkkäin ~79 pientä kutsua; tulostaa tarkkuuden, viiveen ja kynnysarvojen pyyhkäisyn). |
| `SMOKE_HAPI=1 APP_URL=http://localhost:3000 bun run e2e:ui` | Selainläpikäynti (Firefox + puppeteer-core) käynnissä olevaa sovellusta vasten; **kirjoittaa HAPIin** testitallennuksen. Edellyttää harjoitusaineistoa. |

## Käyttökulku

1. **Luo harjoitusaineisto HAPIin** (vasen palsta). Toiminto näyttää ensin esikatselun luotavista resursseista. Lähetys tapahtuu vasta erillisellä painalluksella, ja käynnistys ei koskaan kirjoita palvelimeen.
2. **Näytä demopotilaat**, valitse potilas (esim. *Aino Demolainen*) ja palvelukontakti.
3. **Kysy potilastiedoista**, esim. ”Näytä viimeisimmät verenpaineet”. Näkymä näyttää:
   - vastauksen
   - lähdehavainnot (resurssi, kenttä, mittausaika)
   - puuttuvat tiedot
   - avattavan hakusuunnitelman
4. **Vastaanotto ja kirjaaminen:**
   1. Äänitä tai liitä litteraatti. Valikosta voi ladata jonkin 14 synteettisestä esimerkkikeskustelusta (”Lataa esimerkkikeskustelu”): oletusesimerkin lisäksi mm. kielteisiä tietoja, lapsi ja huoltaja, yhdistelmälauseita sekä ohjeiden syöttöyrityksiä sisältävä keskustelu.
   2. Valitse ”Muodosta käyntimerkintäluonnos”.
   3. Tarkista ehdotukset ja valitse kullekin Muokkaa, Hyväksy tai Hylkää. Hyväksy lisäksi käyntimerkintä.
   4. Valitse ”Esikatsele tallennus”. Näet FHIR-Bundlen ja palvelimen `$validate`-tuloksen.
   5. Valitse ”Tallenna hyväksytyt HAPIin”. Tila näytetään kahtena erillisenä merkintänä: ”Tallennus hyväksytty palvelimella” ja ”Takaisinluku varmistettu”.

Synteettinen aineisto (`lib/fhir/fixtures.ts`):

- **Aino Demolainen:**
  - kaksi kontaktia
  - verenpainepaneelit kolmelta päivältä sekä erilliset systolinen ja diastolinen mittaus
  - laboratoriotulokset: Hb, krea, K ja LDL (koholla)
  - amlodipiini (MedicationStatement) ja vanha ibuprofeenimääräys
  - penisilliiniallergia
  - verenpainetauti
  - thorax-lausunto, jonka tekstissä on tarkoituksella ”ignore instructions” -kehote. Kehote jää pelkäksi dataksi.
- **Veikko Testinen:** kontakti, CRP ja astma. Häneltä puuttuvat verenpaineet, lääkitys ja allergiat.

Kaikilla resursseilla on demotunniste (`meta.tag` `urn:super-ambient:demo|synthetic-demo`) ja pysyvä identifier (`urn:super-ambient:demo:identifier`). Luonti käyttää conditional createa (`ifNoneExist`), joten toistettu luonti ei tee duplikaatteja. Palvelimen antamia id:itä ei kovakoodata.

## Arkkitehtuuri

> **Alustava ArchiMate-kuvaus:** `docs/architecture/super_ambient-architecture.pdf` (selostus) ja `docs/architecture/super_ambient-architecture.xml` (Open Group Exchange -malli, avattavissa esim. Archilla). Ne generoidaan tiedostosta `scripts/architecture/model.ts` komennolla `bun run architecture:build`; kuvaus on alustava eikä ole katselmoitu.

```
app/api/*            Route handlerit (palvelinpuoli: FHIR-yhteys ja avaimet pysyvät täällä)
app/api/auth/[source]/  SMART-kirjautuminen: login, callback, logout
components/          React-käyttöliittymä (Workspace, AskView, RecordView)
lib/fhir/            EhrAdapter, HapiR4Adapter, lähderekisteri (sources.ts), HTTP-kerros, hakurakentajat, resurssirakentajat, fixturet
lib/auth/            PKCE, SMART-kirjautumisvuo, evästeistunto (ei palvelimen muistia)
lib/clinical/        Skeemat (zod), ClinicalLanguageAdapter, mock-tulkinta ja -rakenteistaja, faktat, kysy-putki
lib/transcription/   TranscriptionAdapter
lib/workflow/        Hyväksyntä ja vanheneminen (review.ts), tallennuspolku (save.ts)
tests/               Vitest + muistinvarainen FHIR-jäljitelmä
scripts/smoke-hapi.ts  Erillinen integraatiotesti oikeaa HAPIa vasten
```

- **`EhrAdapter` / `HapiR4Adapter`** hoitaa seuraavat:
  - CapabilityStatementin luvun
  - potilas- ja kontaktihaun
  - potilaskohtaiset haut, joiden palautetut resurssit tarkistetaan potilasta vasten
  - resurssin luvun, `$validate`-validoinnin, transactionin ja identifier-haun

  HTTP-kerroksen ominaisuudet:
  - `application/fhir+json`
  - aikakatkaisu
  - enintään 2 uusintaa vain lukupyynnöille
  - sivu- ja resurssirajat
  - vastauskoon raja (4 Mt)
  - sivutuslinkkien ja uudelleenohjausten tarkistus sallittua palvelinta ja polkua vasten
  - OperationOutcome-käsittely

  Tyhjä, epäonnistunut ja osittainen haku ovat eri tiloja. Muu EHR vaatii oman adapterin ja yhteensopivuustestit.
- **`ClinicalLanguageAdapter`** tarjoaa kolme toimintoa: `interpretQuestion`, `answer` ja `structureTranscript` sekä valinnaisen `repair`-toiminnon. Rajoitukset:
  - Mallin tuotos validoidaan aina skeemaa vasten (`strictObject`), ja korjausyrityksiä on enintään yksi.
  - Malli palauttaa vain tiedontarpeen. URL:ää, potilasta, palvelinta tai HTTP-metodia se ei voi antaa.
  - Vastauksen luvut tarkistetaan faktoja vasten. Lähteettömät luvut johtavat faktoista koottuun varavastaukseen.
- **`TranscriptionAdapter`** on rajapinta koko tallenteen litteroinnille. Myöhempää puhevirtaa varten siinä on `openStream` sekä kyvykkyysliput (`streamingPartials`, `diarization`, `timestamps`).
- **Tallennuspolku** (`lib/workflow/save.ts`) on ainoa kirjoituspolku, eikä hakusuunnittelija tai malli voi kutsua sitä. Palvelin tarkistaa ennen kirjoitusta uudelleen:
  - litteraattiversion ja lähdeviitteet
  - jokaisen hyväksynnän sisältötiivisteen
  - sallitut FHIR-kohteet
  - potilaan demotunnisteen
  - Encounterin kuulumisen potilaalle
  - transaction- ja conditional create -tuen

  Lisäksi tallennettavan tilannevedoksen täytyy täsmätä esikatseltuun. Varsinainen kirjoitus etenee näin:
  1. Kirjoitus tehdään `Bundle.type=transaction` -pyyntönä, ja jokaisella resurssilla on pysyvä identifier sekä `ifNoneExist`. Sama tilannevedos ei siksi luo duplikaatteja.
  2. Transaction-vastauksen entryt tarkistetaan yksitellen.
  3. Aikakatkaisun jälkeen tila tarkistetaan identifierien avulla ennen uusintaa.
  4. Takaisinluku on oma vaiheensa, ja sen virhe ei tarkoita tallennuksen epäonnistumista.

### FHIR-lähteet ja kirjautuminen

- **Lähderekisteri** (`lib/fhir/sources.ts`) on ainoa paikka, jossa lähteen osoite, tunnistautumistapa, kirjoitusoikeus ja hakumuoto määritellään. Selain lähettää vain lähteen tunnisteen (`sourceId`, oletus `hapi`); palvelin tarkistaa sen rekisteriä vasten, eikä selain voi antaa osoitetta. Uusi lähde on uusi rekisterimerkintä, ei uusi koodipolku.
- **Lähteen vaihto** nollaa potilaan, kontaktin, hakutulokset ja luonnoksen (hyväksynnät vanhenevat), koska eri palvelimilla on eri potilaat ja kontaktit.
- **HAPI**: ei tunnistautumista; tallennus sallittu vain sovelluksen demopotilaille.
- **Epic (sandbox)**: SMART on FHIR, standalone launch, julkinen asiakas (ei salaisuutta) ja PKCE (S256). Vain luku: tallennus, esikatselu ja harjoitusaineiston luonti estetään palvelimella (403) ja käyttöliittymässä.
  - **Asetus:** `EPIC_CLIENT_ID` (ei salaisuus, mutta pidetään ympäristömuuttujassa `.env.local` ja Vercelissä, ei repossa). Epicille on rekisteröitävä täsmälleen `<origin>/api/auth/epic/callback` (paikallisesti `http://localhost:3000/api/auth/epic/callback`). Muutoksen voimaantulo voi kestää hetken.
  - **Kulku:** ”Kirjaudu” -> Epicin kirjautumissivu (sandboxin kliinikkotunnukset ovat Epicin dokumentaatiossa) -> `callback` vaihtaa koodin pääsytunnisteeksi -> tunniste tallennetaan `httpOnly`, `SameSite=Strict` -evästeeseen, jota vain palvelin lukee. Selaimen JavaScript ei näe sitä. Kirjautumisosoitteet luetaan palvelimen `.well-known/smart-configuration`-tiedosta, ja niiden on oltava palvelimen omalla originilla.
  - **Ei palvelimen muistia eikä `SESSION_SECRET`-arvoa:** Epic-liitäntä rakennetaan joka pyynnölle evästeen tunnisteesta, eikä sitä jaeta käyttäjien kesken. Tunniste vanhenee noin tunnissa (ei refresh-tunnistetta); sen jälkeen kirjaudutaan uudelleen. Ilman voimassa olevaa tunnistetta datareitit palauttavat 401.
  - **Hakumuoto:** Epicin potilashaku löytää nimellä vain, kun mukana on syntymäaika (todettu: sukunimi tai etunimi+sukunimi ei tuottanut osumia, etunimi+sukunimi+syntymäaika tuotti; sukunimi+syntymäaika ja nimi+sukupuoli on testaamatta). Hakukenttä ymmärtää ”Etunimi Sukunimi 1952-05-24”; tunnistehaku `system|arvo` toimii ilman. Painike ”Näytä lähteen testipotilaat” hakee Epicin dokumentoidut testipotilaat MRN:llä.
  - **Rajaus:** Epic ei ole tallennuskohde. Kun käyttäjäkohtainen kirjoitus joskus lisätään, se on oma suunniteltu työnsä; rekisterin testi vaatii nyt, että kirjoitettava lähde ei vaadi kirjautumista.
- Kielimalli (Jev) saa Epicistäkin vain kysymystekstin; haettuja potilastietoja ei lähetetä sille.

### FHIR-rakenteet (v1)

| Hyväksytty sisältö | Resurssi |
| --- | --- |
| Verenpaine | `Observation`: paneeli 85354-9 ja komponentit 8480-6/8462-4, `mm[Hg]` |
| Syke | `Observation` 8867-4, `/min` |
| Lämpö | `Observation` 8310-5, `Cel` |
| Oire, ongelma tai diagnoosiepäily | `Condition`: `verificationStatus` säilyttää epävarmuuden (epäily → `provisional`). Koodi vain tunnetusta luettelosta, muuten pelkkä teksti. |
| Käyntimerkintä | `DocumentReference`: `status=current`, `docStatus=preliminary`, teksti base64-liitteenä, `subject` ja `context.encounter`. Ei keksittyä tekijää. |
| Lääkitys- ja allergiamaininnat, suunnitelma, sukuanamneesi, kielteiset löydökset | Vain käyntimerkintään. v1 ei päivitä lääkelistaa tai allergioita eikä tee tilauksia. |

Keskustelusta poimituissa mittauksissa **`effective[x]` jätetään pois**, koska mittausaikaa ei ilmaistu, eikä sitä keksitä. Tästä syystä resursseihin ei merkitä vital-signs-profiilia. Mittauksen ajallisuus ja lähdelainaus kirjataan `note`-kenttään. Resursseihin ei lisätä standardiin kuulumattomia kenttiä. Jäljitettävyys ehdotuksesta tallennettuun resurssiin säilyy sovelluksen tilassa ja identifierissä.

## Mallipalvelu ja litterointi

- **Oletus on `LLM_PROVIDER=mock`.** Tila on sääntöpohjainen, eikä se ole kielimalli. Se tunnistaa rajatun joukon suomenkielisiä ilmauksia, kuten RR-arvot, sykkeen, lämmön, kiellot, epäilyt, läheisen tiedot, lääke-, allergia- ja toimenpidemaininnat sekä suunnitelman. Käyttöliittymä merkitsee tilan selvästi.
- **”Liitä mallivastaus käsin”** antaa pyyntöpohjan, jossa on JSON-skeema ja numeroidut puheenvuorot. Voit ajaa pyynnön valitsemallasi mallilla ja liittää vastauksen, joka käy läpi saman skeema- ja lähdeviitetarkistuksen.
- **Jev (`LLM_PROVIDER=jev`) tulkitsee kysymykset.** Jev (TypeSafe System One) on luokittelumalli, ei tekstiä tuottava kielimalli: se vastaa tyypitettyihin kysymyksiin (`choice`, `score`, `noul`) ja palauttaa valinnan ja todennäköisyyksiä. Siksi kytkentä on tarkoituksella **osittainen (hybridi)**:
  - **Kysymyksen tulkinta (Kysy potilastiedoista):** Jev saa yhden pyynnön, jossa on kolme kysymystä: mitä tietoa kysytään (`intent`, 9 vaihtoehtoa + `none`), rajataanko kysymys valittuun kontaktiin (`visit_only`) ja rajataanko aikaväli (`period`). Vastaus muutetaan skeemavalidoiduksi tiedontarpeeksi (`lib/clinical/jev-interpreter.ts`). Resurssilajit, hakurajaukset ja päivämäärät muodostaa sovellus; Jev ei voi antaa URL:ää, potilasta tai metodia. Jevin vastauksen ulkopuolinen valinta tai puuttuva vastaus on virhe, ei arvaus.
  - **Epävarmuus:** jos valitun tiedontarpeen todennäköisyys alittaa rajan (`THRESHOLDS`, nykyinen arvo 0,8, valittu 79 kysymyksen arvioinnin perusteella: väärät tulkinnat jäivät välille 0,62–0,72, oikeat olivat lähes kaikki vähintään 0,8) tai Jev vastaa `none`, sovellus pyytää tarkennusta eikä tee hakuja. Epävarma aikaväli tulkitaan ”ei rajausta”, jotta haku ei kavennu huomaamatta. Käyttöliittymässä varmuus on laadullinen (korkea/kohtalainen/matala); todennäköisyydet näkyvät vain avattavissa teknisissä tiedoissa.
  - **Vastauksen kokoaminen** ei käytä Jeviä: vastaus koostetaan suoraan haetuista resursseista. Tilapaneeli ja käyttöliittymä kertovat toiminnoittain, kuka mitäkin tekee.
  - **Litteraatin rakenteistus Jevillä (valinnainen, `LLM_STRUCTURING=jev`):** Jev ei kirjoita tekstiä eikä poimi arvoja, joten työnjako on tämä: *sovellus* pilkkoo lauseet ja poimii lainaukset, mittausarvot (RR, syke, lämpö) ja termit; *Jev* luokittelee jokaisen lauseen viidellä kysymyksellä (`lib/clinical/sentence-classifier.ts`): tyyppi (käynnin syy, oire, löydös, mittaus, aiempi sairaus, lääkitys, allergia, toimenpide, arvio, suunnitelma, sukuanamneesi, muu), onko asia kielletty, koskeeko se muuta henkilöä kuin potilasta, onko ilmaisu epäilevä ja ajankohta. Ehdotukset muodostaa sovellus (`lib/clinical/jev-structurer.ts`). Koska Jev vastaa vain annetuista vaihtoehdoista, se ei voi keksiä arvoja tai lähdeviitteitä, ja litteraatin sisältämät ”ohjeet” ovat pelkkää dataa.
    - **Varovaisuus:** FHIR-kohde (Observation/Condition) annetaan vain, kun Jevin arvio on ratkaiseva (tyyppi ≥ 0,8; kielteisyys ja ”kenestä” ≥ 0,8 tai ≤ 0,2). Epävarma arvio jää tarkistettavaksi ehdotukseksi ilman kohdetta ja selvällä huomautuksella. Läheisen tieto ei koskaan muutu potilaan Conditioniksi, kielteistä löydöstä ei tallenneta resurssina, ja aiempi mittaus ei päädy tämän käynnin havainnoksi. Rajat ovat `SENTENCE_THRESHOLDS`-vakiossa ja aloitusarvauksia.
    - **Yhdistelmälauseet:** lause jaetaan osiin vain varmoista erottimista (`mutta`, `vaikka`, `;`; ei `ja`), ja jokainen osa luokitellaan erikseen. Näin ”Pahoinvointia on ollut, mutta en ole oksentanut.” tuottaa kaksi ehdotusta: pahoinvointi (myönteinen) ja ei oksentelua (kielteinen). Osa lähetetään arvioitavaksi kenttänä `sentence`, ja koko lause annetaan kontekstiksi (`full_sentence`). Lainaukset ovat tarkkoja osia puheenvuoron tekstistä. Mittausarvot poimitaan silti koko lauseesta (asiayhteys, kuten ”RR”, voi olla toisessa osassa) ja liitetään siihen osaan, jonka sisällä ne ovat. Jakoa ei tehdä, jos jokin osa jäisi alle kahden sanan (tai luvun).
    - **Lauseet, joita ei luokitella:** kysymykset ja liian lyhyet vastaukset tai osat (”Ei.”); lyhyistä lauseista (esim. ”RR 148/92”) mittausarvot poimitaan silti koodilla. Kysymys–vastaus-parien (”Onko ollut kuumetta?” – ”Ei.”) yhdistäminen ei ole mukana: lähdeviite osoittaa yhteen lauseeseen. Mock ei tee sitäkään.
    - **Yksityisyys:** toisin kuin kysymystulkinnassa, tämä lähettää **litteraatin lauseet** (ei potilastunnisteita; kaksi edellistä puheenvuoroa kontekstina) Typesafelle. Siksi toiminto on oma, oletuksena pois päältä oleva asetus, käyttöliittymä varoittaa asiasta, ja sen tulee olla käytössä vain synteettisellä harjoituspuheella, kunnes palveluntarjoajan ja työnantajan tietojenkäsittelyehdot on tarkistettu.
    - **Kustannus ja nopeus:** yksi pieni pyyntö per lause tai lauseen osa (~1,5 k tokenia), enintään 80 luokiteltavaa yksikköä (lausetta tai sen osaa) per litteraatti (`MAX_SENTENCES`); `JEV_CONCURRENCY` (oletus 1, enintään 8) säätää rinnakkaisuutta tilauksen mukaan. Pitkä litteraatti vie sekunteja; reitillä on `maxDuration = 60`.
  - **Yksityisyys:** palveluun lähetetään vain kysymysteksti (enintään 500 merkkiä), ei potilastietoja, litteraattia eikä tunnisteita. Älä kirjoita kysymyksiin henkilötietoja. Käytä vain synteettistä aineistoa, kunnes palveluntarjoajan tietojenkäsittelyehdot on tarkistettu.
  - **Virhetilanteet:** jos Jev ei vastaa (aikakatkaisu 10 s, enintään 2 uusintaa 429/529/5xx-virheissä), Kysy-näkymä näyttää virheen eikä tee hakuja. Näkymässä on valinnainen painike ”Käytä mock-tulkintaa tähän kysymykseen”; vaihtoa ei tehdä huomaamatta.
  - **Asetukset:** `LLM_PROVIDER=jev` ja `TYPESAFE_API_KEY` (varavaihtoehto `LLM_API_KEY`); rakenteistukseen lisäksi `LLM_STRUCTURING=jev` ja tarvittaessa `JEV_CONCURRENCY`. Oletukset ovat `https://api.typesafe.ai/v1/systemone` (`LLM_ENDPOINT`, vain https) ja `jev-latest` (`LLM_MODEL`). Avain luetaan vain palvelimella; virheviestit, lokit ja tilavastaus eivät sisällä avainta tai kysymystekstiä. Jos avain puuttuu, tilapaneeli kertoo, ettei Jev ole käytössä.
  - **Laadun mittaus:** `bun run eval:interpret -- --jev` vertaa Jeviä ja mockia 79 suomenkielisellä kysymyksellä (`scripts/data/question-eval-set.ts`: 41 perusjoukkoa ja 38 vaikeampaa, joissa on monitulkintaisia, sekatyyppisiä, sotkuisia, lyhenteellisiä, ruotsin- ja englanninkielisiä sekä kehotteenpurkuyrityksiä) ja tulostaa myös kynnysarvon vaikutuksen. Kriteerit on kirjoitettu englanniksi suomalaisin avainsanoin; vaihtoehtoa voi verrata muokkaamalla `INTENT_CRITERIA`-taulua.
- **Litterointi (`TRANSCRIPTION_PROVIDER=none`):** selaimessa voi äänittää, kuunnella ja poistaa harjoitusäänitteen. ”Litteroi äänite” kertoo, ettei palvelua ole asetettu, joten litteraatti liitetään käsin. Ääntä ei lähetetä HAPIin, ja se säilyy vain selainistunnon muistissa. Reaaliaikainen litterointi ja puhujien erottelu **eivät ole toteutettuja**.

## Testit

`bun run test` (155 testiä) kattaa:

- **Hakurakentajat:** koodaus, potilasrajaus, kontaktirajaus ja injektioyritykset.
- **Skeemavalidointi** ja korjausyritysten raja.
- **Resurssirakentajat:**
  - UCUM-yksiköt
  - ei keksittyä aikaa
  - ei vapaita kenttiä
  - `ifNoneExist` ja urn:uuid
- **Hyväksynnän vanheneminen:** ehdotuksen tai käyntimerkinnän muokkaus, litteraatin muutos ja väärennetty hyväksyntä.
- **Kaikki §13:n mallikeskustelut:**
  - RR, syke ja lämpö
  - ”Ei kuumetta. Epäilen appendisiittia.”
  - kaksi verenpainetta
  - isän diabetes
- **Haku:**
  - ”ignore instructions” jää dataksi
  - OperationOutcome
  - sivutusraja
  - ulkopuolinen sivutuslinkki
  - yhteyskatko
  - toisen potilaan resurssit suodattuvat pois
- **Jev-kysymystulkinta:**
  - pyynnön muoto, uusinnat, aikakatkaisu, peruutus ja odottamattomat vastaukset
  - kynnysarvot, aikavälin päivämäärälaskenta ja kontaktirajaus
  - virheviesteissä ei avainta eikä kysymystekstiä, ja pyyntöön ei mene potilastunnisteita
  - koko Kysy-putki Jev-adapterilla: tarkennus, Jev-virhe ja oikea potilasrajaus
- **Jev-rakenteistus:** lauseluokittelun kysymykset ja tila (ei tunnisteita), lauseiden jako osiin (tarkat merkkikohdat, ei jakoa liian lyhyille osille), arvion jäsennys, kaikki ehdotustyypit, varovaisuussäännöt (epävarma arvio, läheinen, kielteinen, aiempi mittaus), ohjeiden syöttöyritys, lauseraja, rinnakkaisuus, lyhyet mittauslauseet, koko esimerkkikeskustelu ja adapterin valinnat sekä virhetilanteet.
- **Tallennus:**
  - kaksinkertainen tallennus ilman duplikaatteja
  - väärä kontakti
  - vanhan ehdotuksen tallennus uudelle potilaalle
  - puuttuva transaction-tuki
  - aikakatkaisun jälkeinen identifier-tarkistus
  - takaisinluvun virhe

Käyttöliittymä ohittaa vanhentuneet vastaukset sukupolvilaskurilla ja AbortControllerilla, ja potilaan tai kontaktin vaihto nollaa näkymät.

## Tiedossa olevat rajoitukset ja jatkokehitys

- Mock-rakenteistaja on sääntöpohjainen ja hauras. Jev-hybridi parantaa sen arviointeja (tyyppi, kielteisyys, kenestä, epäröinti), mutta ei nimeä uusia ongelmia: ehdotuksen teksti on lause tai mockin termipoiminta, ja Jev ei poimi arvoja, joita sovelluksen säännöt eivät löydä. Kultajoukko (`lib/clinical/sample-conversations.ts`) on laatijan merkitsemä eikä lääkärin tarkistama; todellinen laatu on mitattava kliinikoiden kirjoittamilla synteettisillä keskusteluilla.
- Jev-tulkinnan kynnysarvot (`THRESHOLDS`) perustuvat omaan 79 kysymyksen joukkoon, jonka kirjoittaja on myös kriteerien kirjoittaja. Ne on vahvistettava kliinikoiden omin sanoin kirjoittamalla irrotetulla joukolla ennen luottamista.
- Yhdistelmäkysymykset (esim. ”sydänvaivat ja niiden lääkkeet”) johtavat tarkennuspyyntöön, koska tiedontarve on yksi kerrallaan; kahden tiedontarpeen tuki olisi erillinen ominaisuus.
- Jev saattaa tulkita kirjoituspyynnön (”poista allergiamerkintä”) lukupyynnöksi. Sovellus on vain lukeva, joten mitään ei muutu, mutta kriteereihin on lisätty selvä maininta kirjoituspyynnöistä; vaikutus on mitattava.
- ICD-11-koodiehdotukset (paikallinen ICD-API) ovat mahdollinen jatko: nykyinen koodiluettelo on pieni ja käsin tarkistettu.
- Litterointipalvelua ei ole. Seuraavat askeleet ovat koko tallenteen litterointi ja sen jälkeen puhevirta, osittaiset tulokset ja puhujien erottelu (`openStream`).
- Kirjoitukset rajautuvat käyntimerkintään, vitaalimittauksiin ja Conditioniin. Lääkitys- ja allergialistojen päivitys, tilaukset (ServiceRequest) ja FamilyMemberHistory ovat myöhempiä vaiheita.
- Profiilit, terminologiapalvelin, THL-yhteensopivuus, tunnistautuminen ja allekirjoitusprosessi puuttuvat. Koodiluettelo (`lib/clinical/codes.ts`) on pieni käsin tarkistettu lista.
- Mittausajan voisi myöhemmin ottaa litterointipalvelun aikaleimoista, jos ne ovat todellisia.
- Potilashaku näyttää enintään 20 osumaa ilman ”seuraava sivu” -toimintoa; sivutus on toteutettu adapterissa, mutta käyttöliittymästä se puuttuu.
- Hakuehdot tarkistetaan viimeisintä onnistunutta CapabilityStatementia vasten; ennen ensimmäistä yhteystarkistusta tarkistus ohitetaan.
- Kysy-näkymän yhteenveto käyttää palvelimen kelloa ”viimeiset 90 vrk” -rajaukseen.
- Epic-lähteen hakuja on kokeiltu käsin muutamalla sandboxin testipotilaalla: potilashaku, kontaktihaku sekä verenpaine-, laboratorio-, allergia-, lääkitys- ja diagnoosikysymykset toimivat (lääkkeen nimi luetaan viitteen `display`-kentästä). Kuvantamislausunto-, asiakirja- ja yhteenvetokysymykset ovat kokeilematta, eikä ole varmistettu, noudattaako Epic `_sort`-parametria (se hyväksyy sen). Kirjautumista Epicin sandboxia vasten ei voi testata automaattisesti (se vaatii käyttäjän selaimen), vain jäljitelmäpalvelimella.
- Epic-pääsytunniste vanhenee noin tunnissa, eikä uusintakirjautumista tehdä automaattisesti. Kirjautuminen toimii myös Vercelissä (omistaja vahvisti), mutta jokainen uusi osoite (esikatselujulkaisu, oma verkkotunnus, Azure) on rekisteröitävä Epicille erikseen, ja Epic vertaa osoitetta kirjaimellisesti (https, täsmällinen polku). Uuden osoitteen voimaantulo kesti noin kymmenen minuuttia.
- Julkisen HAPIn tallennus on tarkoitettu vain demoon, ja aineisto voi kadota palvelimen nollauksessa. Luo silloin harjoitusaineisto uudelleen.
