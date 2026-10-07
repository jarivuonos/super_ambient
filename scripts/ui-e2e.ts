// Selainpohjainen läpikäynti keskeisestä käyttökulusta (Firefox + puppeteer-core).
// Käyttää oikeaa HAPI-palvelinta ja KIRJOITTAA sinne synteettisen testitallennuksen.
// Edellyttää käynnissä olevaa sovellusta ja demoaineistoa.
// Käynnistys: SMOKE_HAPI=1 APP_URL=http://localhost:3000 bun run e2e:ui

import puppeteer, { type Page } from "puppeteer-core";

if (process.env.SMOKE_HAPI !== "1") {
  console.error("Tämä testi kirjoittaa julkiseen HAPI-palvelimeen. Käynnistä: SMOKE_HAPI=1 bun run e2e:ui");
  process.exit(2);
}
const APP = process.env.APP_URL ?? "http://localhost:3000";
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${msg}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  browser: "firefox",
  executablePath: process.env.FIREFOX_PATH ?? "/usr/bin/firefox",
  headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
page.on("dialog", (d) => void d.accept());

const bodyText = (p: Page) => p.evaluate(() => document.body.innerText);
async function waitText(text: string, timeout = 60000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout, polling: 250 }, text);
}
async function clickButton(text: string, scope?: string) {
  const ok = await page.evaluate(
    (t, s) => {
      const root: ParentNode = s ? ([...document.querySelectorAll("tr")].find((tr) => tr.innerText.includes(s)) ?? document) : document;
      const b = [...root.querySelectorAll("button")].find((x) => x.innerText.trim() === t && !x.disabled && x.offsetParent !== null);
      b?.click();
      return !!b;
    },
    text,
    scope ?? null,
  );
  if (!ok) throw new Error(`Painiketta ei löytynyt tai se oli poissa käytöstä: ${text}${scope ? ` (${scope})` : ""}`);
}
const rowText = (contains: string) => page.evaluate((c) => [...document.querySelectorAll("tr")].find((tr) => tr.innerText.includes(c))?.innerText ?? "", contains);

try {
  await page.goto(APP, { waitUntil: "load" });
  await waitText("yhteys OK");
  check(true, "yhteystarkistus näkyy (yhteys OK)");

  await clickButton("Näytä demopotilaat");
  await waitText("Aino Demolainen");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.startsWith("Aino Demolainen"))!.click());
  await page.waitForSelector('select[aria-label="Palvelukontakti"]', { timeout: 60000 });
  const encValue = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>('select[aria-label="Palvelukontakti"] option')].find((o) => o.text.includes("vatsakipu"))?.value ?? "");
  await page.select('select[aria-label="Palvelukontakti"]', encValue);
  await waitText(`Encounter/${encValue}`);
  const header = await page.evaluate(() => document.querySelector("header")!.innerText);
  check(/Aino Demolainen/.test(header) && /Patient\/\d+/.test(header) && header.includes(`Encounter/${encValue}`) && header.includes("hapi.fhir.org"), "kontekstipalkki: potilas, Patient-id, kontakti, Encounter-id, palvelin");

  await clickButton("Näytä viimeisimmät verenpaineet");
  await waitText("Viimeisin verenpainetieto");
  const t1 = await bodyText(page);
  check(t1.includes("138/88 mmHg") && t1.includes("Lähdehavainnot") && /Observation\/\d+/.test(t1), "kysymys verenpaineista: arvo, lähteet ja resurssiviite");

  await clickButton("Vastaanotto ja kirjaaminen");
  await clickButton("Lataa esimerkkikeskustelu");
  await clickButton("Muodosta käyntimerkintäluonnos");
  await waitText("Rakenteiset ehdotukset");
  check((await bodyText(page)).includes("MOCK-tila"), "mock-tila merkitty selvästi");

  const bp = "Verenpaine 160/100 mmHg";
  check((await rowText(bp)).includes("tarkistamatta"), "ehdotus alkaa tarkistamattomana");
  await clickButton("Hyväksy", bp);
  check((await rowText(bp)).includes("hyväksytty"), "Hyväksy merkitsee ehdotuksen hyväksytyksi");

  // Muokkaus hyväksynnän jälkeen peruu hyväksynnän.
  await clickButton("Muokkaa", bp);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Systolinen"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "162");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickButton("Valmis");
  const edited = "Verenpaine 162/100 mmHg";
  await waitText(edited);
  check((await rowText(edited)).includes("tarkistamatta"), "muokkaus peruu hyväksynnän");
  await clickButton("Hyväksy", edited);
  await clickButton("Hyväksy", "Appendisiitti (epäily)");
  await clickButton("Hyväksy käyntimerkintä");
  check((await bodyText(page)).includes("Käyntimerkintä hyväksytty"), "käyntimerkintä hyväksytty");

  await clickButton("Esikatsele tallennus");
  await waitText("Esikatselu valmis");
  check((await bodyText(page)).includes("FHIR-esikatselu (transaction-Bundle)"), "esikatselu: FHIR-Bundle näkyvissä");
  await clickButton("Tallenna hyväksytyt HAPIin");
  await waitText("Tallennus hyväksytty palvelimella", 90000);
  await waitText("Takaisinluku varmistettu", 30000);
  const saved = await bodyText(page);
  check(saved.includes("Takaisinluku varmistettu"), "tallennus ja takaisinluku näytetään erikseen");
  check(/tallennettu: Observation\/\d+/.test(saved), "ehdotukseen liitetty tallennetun resurssin viite");

  // Potilaan vaihto kesken haun: vanha vastaus ei saa ilmestyä.
  await clickButton("Kysy potilastiedoista");
  await clickButton("Mitä lääkitystietoja löytyy?");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.startsWith("Veikko Testinen"))!.click());
  await waitText("Patient/");
  await new Promise((r) => setTimeout(r, 8000));
  const after = await bodyText(page);
  const hdr = await page.evaluate(() => document.querySelector("header")!.innerText);
  check(/Veikko Testinen/.test(hdr) && !after.includes("Amlodipiini") && !after.includes("Vastauksen lähde"), "potilaan vaihdon jälkeen vanhan potilaan vastaus ei ilmesty");
  check(!after.includes("Rakenteiset ehdotukset"), "vanhan potilaan ehdotukset tyhjennetty");

  await page.screenshot({ path: process.env.SCREENSHOT ?? "ui-e2e.png", fullPage: false });
} catch (e) {
  failures++;
  console.log(`FAIL ${(e as Error).message}`);
  await page.screenshot({ path: "ui-e2e-failure.png" }).catch(() => {});
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} tarkistusta epäonnistui.` : "\nKaikki UI-tarkistukset onnistuivat.");
process.exit(failures ? 1 : 0);
