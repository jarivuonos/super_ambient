# Toteutusohje Claude Codelle: potilaskohtainen FHIR-työtila ja ambient-kirjaaminen

Päiväys: 7.10.2026. Ensimmäinen kohde: HAPI FHIR R4, `https://hapi.fhir.org/baseR4`.

Tämä on sovelluksen toteutuspyyntö. Rakenna toimiva, suomenkielinen paikallinen web-demo. Etene toteutukseen ja varmista keskeinen käyttökulku. Jos nykyinen FHIR-demo on tässä repossa, tutki se ensin ja kehitä sitä. Jos koodia ei ole käytettävissä, toteuta itsenäinen paikallinen sovellus. Kerro lopuksi, mikä toimii oikeilla yhteyksillä ja mikä vaatii vielä palveluasetukset.

## 1. Sovelluksen tarkoitus

Kliinikko valitsee synteettisen potilaan ja palvelukontaktin. Hän voi samassa työtilassa:

1. Kysyä luonnollisella kielellä potilastiedoista. Sovellus tulkitsee tiedontarpeen, hakee tarvittavat FHIR-resurssit ja antaa lähteisiin perustuvan vastauksen.
2. Nauhoittaa harjoitusvastaanoton tai liittää sen litteraatin. Sovellus muodostaa käyntimerkintäluonnoksen ja ehdotukset rakenteisiksi tiedoiksi.
3. Tarkistaa ja muokata ehdotukset, hyväksyä haluamansa kohdat ja tallentaa ne valittuun potilas- ja kontaktikontekstiin HAPIin.

Johtotähti on potilaan tilanteen ymmärtäminen ja sujuva kirjaaminen. FHIR-hakujen ja JSONin tarkastelu on tarvittaessa avattava lisänäkymä.

## 2. Ensimmäisen version rajaus

Kohteena on julkinen HAPI R4 -testipalvelin. Käytä ainoastaan itse luotua synteettistä potilasaineistoa ja harjoituspuhetta. HAPI ei tarjoa tietojen yksityisyyttä ja sen sisältö nollataan ajoittain. Sovelluksen omat esimerkit ovat toistettavissa paikallisista fixtureistä.

Toteuta ensisijaisesti yksi kokonainen polku: **valitse potilas ja kontakti → kysy verenpaineista → liitä tai litteroi harjoituskeskustelu → tarkista käyntimerkintä ja havainnot → tallenna → lue tallennetut resurssit takaisin**.

Lääkitys-, allergia-, laboratorio- ja lausuntotietojen lukeminen kuuluu ensimmäiseen versioon tuettujen resurssien puitteissa. Ensimmäisen version kirjoitukset rajataan käyntimerkintään, mitattuihin havaintoihin ja ammattilaisen erikseen hyväksymiin ongelma- tai diagnoosiehdotuksiin. Lääkkeiden määrääminen ja tutkimustilausten lähettäminen jäävät myöhempään vaiheeseen.

Sovellus tukee tiedonhakua, yhteenvetoa ja kirjaamista. Se ei tee itsenäisiä hoitopäätöksiä. Tulevan oikean EHR-integraation tunnistautuminen, profiilit, terminologia ja hyväksymismenettelyt toteutetaan erikseen.

## 3. Käyttöliittymä

Näytä pysyvästi valittu potilas, Patient-tunniste, palvelukontakti, Encounter-tunniste ja käytössä oleva FHIR-palvelin. Potilaan vaihto tyhjentää edellisen potilaan vastaukset ja ehdotukset; tallentamaton työ huomioidaan ennen vaihtoa. Vanhentuneet verkkovastaukset eivät saa ilmestyä uuden potilaan työtilaan.

Työtilassa on kaksi selkeää näkymää:

| Näkymä | Sisältö |
| --- | --- |
| Kysy potilastiedoista | Kysymys, lyhyt vastaus, lähdehavainnot päivämäärineen, puuttuva tieto ja tarvittaessa avattava hakusuunnitelma. |
| Vastaanotto ja kirjaaminen | Tallennus tai litteraatin liittäminen, muokattava litteraatti, käyntimerkintäluonnos, rakenteiset ehdotukset sekä hyväksyntä ja tallennustulos. |

Esimerkkikysymykset: ”Näytä viimeisimmät verenpaineet”, ”Mitä lääkitystietoja löytyy?”, ”Näytä viimeisin kuvantamislausunto” ja ”Mitä keskeisiä ongelmia ja viimeaikaisia muutoksia potilaan tiedoissa näkyy?”.

Ehdotustaulukossa näytetään sisältö, lähdekohta, varmuuden laadullinen kuvaus, mahdollinen ristiriita, FHIR-kohde ja valinta tallennettavaksi. Käytettävissä on Muokkaa, Hyväksy ja Hylkää. Tarkistamaton epäselvä ehdotus ei ole oletuksena mukana tallennuksessa.

Virheet näytetään ymmärrettävästi: yhteys epäonnistui, tietoa ei löytynyt, haku jäi kesken, mallipalvelu ei ole käytössä tai tallennus jäi varmistamatta. Tavallisessa näkymässä tekninen virhekoodi on avattavan lisätiedon takana.

## 4. Arkkitehtuuri ja vaihdettavat palvelut

Käytä repossa olevaa teknologiaa, jos se soveltuu tehtävään. Uuden toteutuksen oletus on TypeScript, React ja pieni palvelinpuoli. Pidä FHIR-yhteydet ja malliavaimet palvelinpuolella. Erota käyttöliittymä, sovelluslogiikka, mallikutsut ja FHIR-liitäntä.

Toteuta vähintään seuraavat rajapinnat:

- `EhrAdapter`: kyvykkyyksien luku, potilashaku, kontaktihaku, potilaskohtaiset resurssihaut, resurssin luku, validointi ja hyväksyttyjen resurssien tallennus.
- `ClinicalLanguageAdapter`: kysymyksen tulkinta, haettuihin tietoihin perustuva vastaus sekä litteraatin rakenteistaminen ja käyntimerkintäluonnos.
- `TranscriptionAdapter`: harjoitusäänitteen litterointi, tarvittaessa myöhemmin myös osittaiset reaaliaikaiset tulokset.

Ensimmäinen EHR-adapteri on `HapiR4Adapter`. Muun EHR:n lisääminen edellyttää oman adapterin ja yhteensopivuuden testauksen; pelkkä URL:n vaihtaminen ei takaa kirjoitusten toimivuutta.

Mallipalvelun nimi, mallin tunniste ja osoite ovat asetuksia. Jev on tavoiteltu vaihtoehto, mutta sen tarkka palveluntarjoaja, API ja ominaisuudet selvitetään toimitetuista tiedoista. Toteuta sen adapteri vasta todellisen dokumentaation perusteella. Älä keksi endpointia tai oleta OpenAI-yhteensopivuutta. Jos repo sisältää muun toimivan malliyhteyden, säilytä mahdollisuus käyttää sitä.

Ilman malliasetuksia demo toimii selvästi merkityllä fixture-/mock-tilalla ja tarvittaessa käsin liitettävällä mallivastauksella. Mock-tilaa ei esitetä oikeana kielimallina eikä tallennettua harjoituslitteraattia oikeana puheentunnistuksena.

API-avaimet luetaan palvelinpuolen ympäristömuuttujista. Tee `.env.example` ilman salaisuuksia. Käytä mahdollisia olemassa olevia palveluita; uusien tilien ja maksullisten palveluiden aktivointia ei tehdä tämän toteutuspyynnön perusteella.

## 5. HAPI-yhteys ja toistettava testiaineisto

1. Lue aluksi `GET /metadata` ja käsittele vastaus FHIR R4 `CapabilityStatement` -resurssina. Tarkista resurssit, hakutoiminnot ja kirjoituskyvykkyydet. Näytä myös viimeisin onnistunut yhteystarkistus.
2. Toteuta nimeen tai tunnisteeseen perustuva potilashaku ja valitun potilaan Encounter-haku. Listaa korkeintaan 20 osumaa sivulla. Sivutus ja sovelluksen oma kokonaisraja ovat erillisiä asioita.
3. Pidä fixtureissä vähintään kaksi synteettistä potilasta, kontaktit, eri päivien verenpaineet, muutama laboratoriotulos, lääkitystieto, allergia, ongelmatieto ja tekstimuotoinen lausunto. Toisella potilaalla osa tiedoista puuttuu.
4. Tarjoa erillinen ”Luo harjoitusaineisto HAPIin” -toiminto, joka esikatselee luotavan aineiston ja lähettää vain nämä omat fixturet. Sovelluksen käynnistyminen ei kirjoita palvelimeen.
5. Käytä oman aineiston löytämiseen pysyviä demoidentifier-arvoja ja demotunnistetta. Käytä vastauksissa palvelimen palauttamia tunnisteita; älä kovakoodaa aiemmissa kokeiluissa käytettyjä Patient- tai Encounter-id:itä.

Käytä `application/fhir+json`-sisältötyyppiä. Toteuta aikakatkaisu, rajallinen lukuyritysten uusinta, hallittu sivutus ja vastauskoon raja. Näytä käyttäjälle, jos raja jätti tietoja hakematta. Sivutuslinkit, uudelleenohjaukset ja viittaukset tarkistetaan sallittua palvelinta ja polkua vasten.

Käsittele HTTP-virheet ja FHIR `OperationOutcome`. Tyhjä hakutulos, epäonnistunut haku ja osittainen haku ovat kolme eri tilaa. Tarkista myös hakutuloksen mukana palautuvat varoitukset.

## 6. Luonnollinen kieli → tarkistettu hakusuunnitelma

Kielimalli palauttaa JSON-skeemaan sopivan **tiedontarpeen**, ei vapaasti suoritettavaa URL:ää tai ohjelmakoodia. Suunnitelma sisältää esimerkiksi intention, resurssilajit, haettavat käsitteet, aikarajauksen, potilas-/kontaktikohtaisen laajuuden ja mahdollisen tarkentavan kysymyksen.

Palvelin tarkistaa suunnitelman, liittää valitun potilaan tunnisteen ja muodostaa haut ennalta sallituilla hakurakentajilla. Malli ei voi vaihtaa potilasta, palvelinosoitetta tai HTTP-metodia. Tässä polussa sallitaan vain lukutoiminnot. Rajaa hakujen määrä ja haettavien resurssien kokonaismäärä.

Käytä tarvittaessa `Observation`, `Condition`, `MedicationRequest`, `MedicationStatement`, `AllergyIntolerance`, `DiagnosticReport` ja `DocumentReference` -resursseja. Varmista resurssikohtaiset potilas- ja kontaktihakuehdot. Potilaan pitkittäiskyselyä ei rajata automaattisesti nykyiseen kontaktiin.

Verenpainekysymyksen esimerkkihaku:

```http
GET /Observation?patient={patientId}&code=http://loinc.org|85354-9&_sort=-date&_count=20
```

Tämä on hakurakentajan muodostama esimerkki; tuotettuun URL:ään arvot koodataan oikein. Tarkista palvelimen tukemat hakuehdot. Verenpainepaneelista luetaan systolinen `8480-6` ja diastolinen `8462-4` komponentti sekä UCUM-yksikkö `mm[Hg]`. Erota ajankohta `effective[x]` resurssin päivitysajasta. Jos aineistossa on vain erillisiä mittausresursseja, käsittele ne ilman perusteetonta yhdistämistä saman mittaushetken pariksi.

Vastaus perustuu palautettuihin resursseihin. Jokainen numeerinen arvo on jäljitettävissä resurssiin ja sen kenttään. Näytä lähteissä resurssitunniste ja mittaus- tai tapahtuma-aika. ”Tietoa ei löytynyt tästä hausta” ei tarkoita ”potilaalla ei ole tätä”. Lääkityslistan ajantasaisuutta ei päätellä pelkästään vanhasta MedicationRequest-resurssista.

Laaja kysymys ”Mikä potilaan ongelma on?” tuottaa tunnetut ongelmat, poikkeavat havainnot ja tietopuutteet lähteineen. Se ei muutu automaattisesti uudeksi diagnoosiksi. Epäselvä tiedontarve tarkennetaan tai vastauksessa kerrotaan käytetty rajaus.

## 7. Ambient ja puhe

Toteuta selaimessa harjoitusäänen tallennuksen aloitus, lopetus, kesto, mikrofoni-indikaattori ja selvä tallennustila. Lähetä ääni litterointipalvelulle vain käyttäjän käynnistämällä toiminnolla. Jos litterointipalvelua ei ole asetettu, äänitteen voi kuunnella ja litteraatin liittää käsin.

Ensimmäinen toimiva ambient-polku voi käyttää koko tallenteen litterointia tallennuksen jälkeen. Pidä rajapinta sellaisena, että myöhemmin voidaan lisätä puhevirran osittaiset tulokset ja pieniviiveinen kysymysten tulkinta. Todellinen reaaliaikainen litterointi ja puhujien erottelu merkitään toimiviksi vasta, kun käytössä oleva palvelu tukee niitä ja ne on testattu.

Käyttäjä tarkistaa litteraatin ennen lopullista rakenteistamista. Säilytä lähdeviitteet litteraatin versioon, puheenvuoroon tai merkkialueeseen. Aikaleimat ja puhujaroolit tallennetaan, jos ne ovat todellisuudessa käytettävissä; muuten käytä tuntematonta puhujaa. Huomioi, että keskustelussa voidaan puhua potilaan lisäksi hänen läheisestään.

Ääntä ei lähetetä HAPIin. Demoäänite on poistettavissa istunnosta. Tietojen säilytyskäytäntö pidetään näkyvänä ja yksinkertaisena.

## 8. Litteraatti → käyntimerkintä ja rakenteiset ehdotukset

Pyydä yhdessä skeemavalidoidussa mallikutsussa muokattava käyntimerkintäluonnos ja lista kliinisistä rakenteistamisehdotuksista. Jos malli ei tue natiivia skeemavastausta, käytä JSON-validointia ja enintään rajattua korjausyritystä. Rikkinäinen vastaus ei pääse tallennuspolkuun.

Luonnoksessa on käynnin syy, esitiedot, nykytila/havainnot, keskustelussa ilmaistu arvio sekä suunnitelma. Erottele potilaan kertoma tieto, mitattu havainto ja ammattilaisen arvio. Älä lisää hoito-ohjeita tai päätelmiä, joita keskustelussa ei ole ilmaistu.

Jokaisella ehdotuksella on vähintään:

| Kenttä | Tarkoitus |
| --- | --- |
| `proposalId`, `type`, `value` | Ehdotuksen tunniste, sisältölaji ja arvo. |
| `source` | Litteraattiversio, tarkka lähdekohta ja puhujarooli, jos tiedossa. |
| `certainty`, `issues` | Suoraan ilmaistu / tulkinnanvarainen / ristiriitainen sekä selitys. |
| `subject`, `negation`, `temporality` | Kenen tieto, onko se kielletty ja milloin se koskee. |
| `codingCandidate`, `targetResourceType` | Tarkistettava koodiehdotus ja mahdollinen FHIR-kohde. |
| `reviewStatus` | Tarkistamatta, hyväksytty tai hylätty. |

Älä näytä keksittyä numeerista luottamusprosenttia. Käytä laadullista epävarmuutta ja lähdeperustelua. Mallin ehdottama koodi vahvistetaan tunnetusta koodistosta tai jätetään pois; epävarma koodi ei saa muuttua varmaksi diagnoosikoodiksi.

Ensivaiheen poiminnat kattavat käynnin syyn, oireen, sijainnin ja alun/keston, keskeiset mittaukset, lääkitystä ja allergioita koskevat maininnat, aiemmat toimenpiteet, ilmaistun arvion ja jatkosuunnitelman. Skeema on laajennettavissa. Mainitsemattomasta tiedosta ei muodosteta negatiivista löydöstä. Sovellus ei väitä THL-yhteensopivuutta ilman erillistä määrittelyä ja tarkistusta.

## 9. Tarkistettu sisältö → FHIR R4

Muodosta FHIR-resurssit sovelluksen omilla tyypitetyillä rakentajilla. Mallivastaukseen ei luoteta valmiina tallennus-Bundlena.

| Hyväksytty sisältö | Ensimmäisen version toteutus |
| --- | --- |
| Verenpaine, lämpö ja muut tuetut mittaukset | `Observation`; tarkistetut yksiköt, potilasviite ja kontaktiviite. |
| Ammattilaisen hyväksymä oire, ongelma tai diagnoosiepäily | `Condition`; oikea varmistusaste, tarvittaessa pelkkä tekstikuvaus. |
| Käyntimerkintä | `DocumentReference`; tekstisisältö attachmentissa, subject ja context.encounter. |
| Lääkitys- ja allergiamaininnat | Tarkistettava kirjaamissisältö; v1 ei tee automaattisia lääkemääräyksiä tai allergialistan päivityksiä. |
| Suunnitelma ja jatkotoimet | Käyntimerkintään; varsinaiset tilausresurssit myöhemmässä vaiheessa. |

`Condition.verificationStatus` säilyttää diagnoosiepäilyn epävarmuuden: ammattilaisen hyväksyntä ei yksin tarkoita kliinisesti varmistettua diagnoosia. `DocumentReference.status` voi olla `current` ja `docStatus` tässä demossa `preliminary`, sillä demo ei toteuta varsinaista allekirjoitusprosessia. Älä keksi Practitioner-tunnistetta.

Säilytä ehdotuksen ja tallennetun resurssin välinen jäljitettävyys sovelluksessa. FHIR-resurssiin ei lisätä vapaita, standardiin kuulumattomia JSON-kenttiä. Mahdolliset myöhemmät extensionit määritellään erikseen.

## 10. Hyväksyntä ja tallennus

Näytä ennen lähettämistä valittu potilas ja kontakti, hyväksytyt sisällöt sekä avattava FHIR-esikatselu. Käyttäjä käynnistää tallennuksen erillisellä ”Tallenna hyväksytyt HAPIin” -toiminnolla. Tarkista palvelinpuolella uudelleen potilasviitteet, Encounterin potilas, hyväksynnät, lähdeversio ja resurssirakenteet.

Muokkaus peruuttaa muuttuneen sisällön hyväksynnän. Jos litteraatti, potilas tai kontakti vaihtuu, siihen perustuvat ehdotukset ja hyväksynnät vanhentuvat. Tallennus koskee täsmälleen tarkistettua tilannevedosta.

Jos palvelin tukee transactionia, tallenna hyväksytyt resurssit `Bundle.type=transaction` -pyynnöllä palvelimen juureen. Tarkista transaction-vastauksen entrykohtaiset tulokset. Käytä omia pysyviä identifier-arvoja ja palvelimen tukemaa conditional create -menettelyä (`ifNoneExist`) duplikaattien ehkäisyyn. Jos tarvittava tuki puuttuu, estä tämän polun kirjoitus ja selitä puute; älä esitä erillisiä POST-pyyntöjä atomisena tallennuksena.

Tallenna palautetut resurssiviitteet ja lue resurssit takaisin. Näytä erikseen ”Tallennus hyväksytty palvelimella” ja ”Takaisinluku varmistettu”. Takaisinluvun virhe ei merkitse, että tallennus epäonnistui. Aikakatkaisun jälkeen tilanne voi olla tuntematon; tarkista identifierien avulla ennen uusintaa.

## 11. Suojaukset, jotka kuuluvat tähän demoon

- Valittu potilaskonteksti tarkistetaan myös palautetuista resursseista ja seurattavista viitteistä. Toisen potilaan tiedot eivät saa päätyä vastaukseen tai tallennukseen.
- FHIR-tekstisisällöt ja litteraatti käsitellään datana. Niissä olevat ohjeet eivät saa muuttaa mallin työkaluja, potilasta, tallennusta tai palvelinosoitetta.
- Renderöi ulkoiset tekstisisällöt turvallisesti. Älä suorita niiden HTML:ää tai skriptejä sellaisenaan.
- Liitetiedostojen ulkoisia osoitteita ei haeta automaattisesti. Ensimmäisen version lausunnot käyttävät fixtureiden tekstisisältöä tai tarkistettuja saman palvelimen resursseja.
- Kirjoitukset käyttävät erillistä palvelinpuolen tarkistuspolkua; hakusuunnittelija ja vastausmalli eivät voi käynnistää niitä.
- Älä tallenna kokonaisia ääniä, litteraatteja, avaimia tai kliinisiä payload-rakenteita tavallisiin debug-lokeihin.

## 12. Toteutusjärjestys

1. Tutki repo ja kirjaa lyhyesti nykytilanne. Toteuta HAPI-adapteri, yhteystarkistus, fixturet ja potilas-/kontaktivalinta.
2. Toteuta yksi oikea hakupolku verenpaineisiin ja lähteiden näyttöön. Lisää skeemavalidoitu mallin tuottama tiedontarve sekä muut rajatut hakuintentiot.
3. Toteuta litteraatin syöttö, kirjaamisluonnos, ehdotustaulukko ja hyväksyntä. Lisää mikrofoni ja litterointiadapteri niin, että mahdollinen puuttuva palveluasetus näkyy rehellisesti.
4. Toteuta hyväksyttyjen Observation-, Condition- ja DocumentReference-resurssien validointi, transaction-tallennus ja takaisinluku.
5. Testaa alla olevat käyttötapaukset, korjaa virheet ja kirjoita README sekä lyhyt jatkokehityslista.

Pidä toteutus koossa. Valmis pystysuora käyttökulku on ensimmäinen tavoite; reaaliaikainen puhevirta ja usean EHR:n adapterit lisätään sen päälle.

## 13. Hyväksymiskriteerit

Tee merkitykselliset automatisoidut testit hakurakentajille, skeemavalidoinnille, resurssirakentajille ja hyväksynnän vanhenemiselle. Testaa käyttöliittymässä keskeinen käyttökulku. Tavalliset testit eivät kirjoita julkiseen HAPIin; oikeaa integraatiota varten käytä erillistä, selvästi käynnistettävää synteettistä smoke-testiä.

| Testitapaus | Odotettu tulos |
| --- | --- |
| ”Näytä viimeisimmät verenpaineet” | Oikean potilaan arvo, yksikkö, mittausaika ja lähde. |
| Potilaalla ei ole verenpainemittauksia | Kerrotaan tietopuutteesta; arvoja ei keksitä. |
| ”RR 148/92, syke 78, lämpö 37,4” | Tarkistettavat mittausehdotukset ja oikeat FHIR-rakenteet. |
| ”Ei kuumetta. Epäilen appendisiittia.” | Ei keksittyä lämpöarvoa; diagnoosiepäily säilyy epävarmana. |
| ”Verenpaine oli ensin 160/100, uusintamittauksessa 145/90” | Molemmat mittaukset lähteineen; aikaa ei keksitä. |
| Keskustelussa puhutaan potilaan isän diabeteksesta | Ei potilaan diabetesdiagnoosia. |
| Potilas vaihtuu haku- tai mallikutsun aikana | Vanha vastaus hylätään eikä vanhaa ehdotusta voi tallentaa uudelle potilaalle. |
| Ehdotusta tai litteraattia muokataan hyväksynnän jälkeen | Muuttuneen ehdotuksen hyväksyntä vanhenee. |
| FHIR-tekstissä on ”ignore instructions” -ohje | Se jää tietosisällöksi eikä muuta toimintaa. |
| HAPI palauttaa OperationOutcomen, sivutusraja täyttyy tai yhteys katkeaa | Eri tilanteet näkyvät oikein, ilman näennäistä onnistumista. |
| Tallennus lähetetään kahdesti samalla identifierillä | Ei uusia duplikaatteja. |
| Tallennus onnistuu ja resurssit luetaan takaisin | Potilas-, kontakti- ja sisältöviitteet täsmäävät hyväksyttyyn esikatseluun. |
| Jev- tai litterointiasetukset puuttuvat | Demo toimii fixtureillä ja tekstisyötöllä; oikean mallin tai ambientin valmiutta ei väitetä. |

Suorita projektin tyyppitarkistus, relevantit testit ja tuotantobuild. README kertoo käynnistyksen, asetukset, fixtureiden käytön, HAPI-tallennuksen, mallipalvelun/litteroinnin kytkemisen ja tiedossa olevat rajoitukset. Lopussa esittele toimiva käyttökulku ja raportoi testitulokset.

## 14. Toteutuksessa tarkistettavat ensisijaiset lähteet

Alla olevat lähteet varmistettiin tätä ohjetta laadittaessa. Tarkista lisäksi palvelimen todellinen CapabilityStatement toteutuksen ajankohtana.

- [HAPI-testipalvelin](https://hapi.fhir.org/) ja [yksityisyys sekä aineiston nollaus](https://hapi.fhir.org/about).
- [FHIR R4 CapabilityStatement](https://hl7.org/fhir/R4/capabilitystatement.html).
- [FHIR R4 Search](https://hl7.org/fhir/R4/search.html).
- [FHIR R4 HTTP: transaction ja conditional create](https://hl7.org/fhir/R4/http.html).
- [FHIR R4 Vital Signs](https://hl7.org/fhir/R4/observation-vitalsigns.html).
- [FHIR R4 DocumentReference](https://hl7.org/fhir/R4/documentreference.html).
- [FHIR R4 Condition](https://hl7.org/fhir/R4/condition.html).
- [FHIR R4 OperationOutcome](https://hl7.org/fhir/R4/operationoutcome.html).

Tämä ohje määrittelee demolle ehdotetun tuote- ja toteutusrakenteen. Se ei ole väite siitä, että nykyinen FHIR-demo, Jev-yhteys tai puhepalvelu olisi jo toteutettu tai testattu.
