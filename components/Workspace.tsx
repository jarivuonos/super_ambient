"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEMO_TAG_CODE, DEMO_TAG_SYSTEM } from "@/lib/fhir/search-builders";
import type { Encounter, Patient } from "@/lib/fhir/types";
import { api, encounterLabel, patientName, type ApiResult, type EncounterSearch, type PatientSearch, type SeedPreview, type SeedResult, type StatusResponse } from "./api";
import { AskView } from "./AskView";
import { RecordView } from "./RecordView";
import { Badge, Button, ErrorBox, formatTime, Section } from "./ui";

/** Suorittaa pyynnön nykyisessä potilas-/kontaktikontekstissa; palauttaa null, jos konteksti vaihtui. */
export type Guard = <T>(fn: (signal: AbortSignal) => Promise<ApiResult<T>>) => Promise<ApiResult<T> | null>;

const isDemo = (p: Patient | null) => !!p?.meta?.tag?.some((t) => t.system === DEMO_TAG_SYSTEM && t.code === DEMO_TAG_CODE);

function StatusPanel({ status, error, onRefresh, refreshing }: { status: StatusResponse | null; error: string | null; onRefresh: () => void; refreshing: boolean }) {
  const check = status?.fhir.check;
  return (
    <Section title="Yhteys ja palvelut" actions={<Button onClick={onRefresh} disabled={refreshing}>{refreshing ? "Tarkistetaan…" : "Tarkista yhteys"}</Button>}>
      {error && <ErrorBox title="Tilaa ei saatu" message={error} />}
      {status && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-zinc-500">FHIR</dt>
          <dd>
            {check?.ok ? <Badge tone="good">yhteys OK</Badge> : <Badge tone="bad">yhteys epäonnistui</Badge>} <span className="break-all">{status.fhir.baseUrl}</span>
          </dd>
          {check?.ok ? (
            <>
              <dt className="text-zinc-500">Palvelin</dt>
              <dd>
                FHIR {check.summary.fhirVersion} · {check.summary.software}
              </dd>
              <dt className="text-zinc-500">Kirjoitus</dt>
              <dd>
                transaction: {check.summary.transaction ? "tuettu" : "ei tuettu"} · conditional create:{" "}
                {["Observation", "Condition", "DocumentReference"].every((r) => check.summary.resources[r]?.conditionalCreate) ? "tuettu" : "puutteellinen"}
              </dd>
            </>
          ) : (
            check && (
              <>
                <dt className="text-zinc-500">Virhe</dt>
                <dd>
                  {check.error.message}
                  <details>
                    <summary className="cursor-pointer text-zinc-500">Tekniset lisätiedot</summary>
                    <code>{check.error.kind} {check.error.status ?? ""}</code>
                  </details>
                </dd>
              </>
            )
          )}
          <dt className="text-zinc-500">Viimeisin onnistunut</dt>
          <dd>{formatTime(status.fhir.lastSuccessAt)}</dd>
          <dt className="text-zinc-500">Kielimalli</dt>
          <dd>
            <Badge tone={status.language.kind === "mock" ? "warn" : status.language.kind === "model" ? "good" : "bad"}>{status.language.kind === "mock" ? "MOCK" : status.language.kind === "model" ? "käytössä" : "ei käytössä"}</Badge> {status.language.description}
          </dd>
          <dt className="text-zinc-500">Litterointi</dt>
          <dd>
            <Badge tone={status.transcription.configured ? "good" : "bad"}>{status.transcription.configured ? "käytössä" : "ei käytössä"}</Badge> {status.transcription.configured ? status.transcription.name : "liitä litteraatti käsin"}
          </dd>
        </dl>
      )}
      <p className="mt-2 text-[11px] text-zinc-500">Julkinen HAPI-testipalvelin: ei yksityisyyttä, sisältö nollataan ajoittain. Käytä vain synteettistä aineistoa.</p>
    </Section>
  );
}

function SeedPanel({ onSeeded }: { onSeeded: () => void }) {
  const [preview, setPreview] = useState<SeedPreview | null>(null);
  const [result, setResult] = useState<SeedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: unknown } | null>(null);

  async function load() {
    setError(null);
    const res = await api<SeedPreview>("/api/seed");
    if (res.ok) setPreview(res.data);
    else setError(res.error);
  }
  async function send() {
    setBusy(true);
    setError(null);
    const res = await api<SeedResult>("/api/seed", { method: "POST" });
    setBusy(false);
    if (!res.ok) setError({ message: res.error.message, detail: res.error.detail });
    else {
      setResult(res.data);
      setPreview(null);
      onSeeded();
    }
  }

  return (
    <Section title="Harjoitusaineisto">
      {!preview && (
        <Button onClick={() => void load()} className="w-full">
          Luo harjoitusaineisto HAPIin…
        </Button>
      )}
      {preview && (
        <div className="space-y-2 text-xs">
          <p className="text-zinc-700">Lähetetään vain nämä sovelluksen omat synteettiset fixturet ({preview.items.length} resurssia) yhtenä transactionina. Olemassa olevat tunnistetaan identifierillä (ei duplikaatteja).</p>
          <ul className="max-h-48 list-disc overflow-auto pl-4 text-zinc-700">
            {preview.items.map((i) => (
              <li key={i.key}>{i.summary}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void send()} disabled={busy}>
              {busy ? "Lähetetään…" : "Lähetä HAPIin"}
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)} disabled={busy}>
              Peru
            </Button>
          </div>
        </div>
      )}
      {result?.ok && (
        <p className="mt-2 text-xs text-emerald-800">
          Valmis: {result.entries?.filter((e) => !e.existing).length} uutta, {result.entries?.filter((e) => e.existing).length} oli jo olemassa.
        </p>
      )}
      {error && (
        <div className="mt-2">
          <ErrorBox title="Aineiston luonti epäonnistui" message={error.message} detail={error.detail} />
        </div>
      )}
    </Section>
  );
}

export function Workspace() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState("");
  const [demoOnly, setDemoOnly] = useState(true);
  const [patients, setPatients] = useState<PatientSearch | null>(null);
  const [patientError, setPatientError] = useState<{ message: string; detail?: unknown } | null>(null);
  const [searching, setSearching] = useState(false);

  const [patient, setPatient] = useState<Patient | null>(null);
  const [encounters, setEncounters] = useState<EncounterSearch | null>(null);
  const [encounterError, setEncounterError] = useState<string | null>(null);
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [tab, setTab] = useState<"ask" | "record">("ask");

  const genRef = useRef(0);
  const abortRef = useRef<AbortController>(new AbortController());
  const dirtyRef = useRef(false);
  const searchAbort = useRef<AbortController | null>(null);

  const loadStatus = useCallback(async (refresh: boolean) => {
    setRefreshing(true);
    const res = await api<StatusResponse>(`/api/status${refresh ? "?refresh=1" : ""}`);
    setRefreshing(false);
    if (res.ok) {
      setStatus(res.data);
      setStatusError(null);
    } else setStatusError(res.error.message);
  }, []);

  useEffect(() => {
    // Tilan haku käynnistyksessä on lukuoperaatio (GET /metadata); mitään ei kirjoiteta.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStatus(false);
  }, [loadStatus]);

  const guard: Guard = useCallback(async (fn) => {
    const gen = genRef.current;
    const res = await fn(abortRef.current.signal);
    return genRef.current === gen ? res : null;
  }, []);

  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);

  function resetContext() {
    genRef.current++;
    abortRef.current.abort();
    abortRef.current = new AbortController();
    dirtyRef.current = false;
  }

  function confirmLeave(): boolean {
    return !dirtyRef.current || window.confirm("Tallentamaton kirjaustyö hylätään. Jatketaanko?");
  }

  async function searchPatients(q = query, demo = demoOnly) {
    searchAbort.current?.abort();
    const ctrl = new AbortController();
    searchAbort.current = ctrl;
    setSearching(true);
    setPatientError(null);
    const res = await api<PatientSearch>("/api/patients", { json: { query: q, demoOnly: demo }, signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    setSearching(false);
    if (!res.ok) setPatientError({ message: res.error.message, detail: res.error.detail });
    else setPatients(res.data);
  }

  async function selectPatient(p: Patient) {
    if (p.id === patient?.id) return;
    if (!confirmLeave()) return;
    resetContext();
    setPatient(p);
    setEncounter(null);
    setEncounters(null);
    setEncounterError(null);
    const res = await guard((signal) => api<EncounterSearch>("/api/encounters", { json: { patientId: p.id }, signal }));
    if (res === null) return;
    if (!res.ok) setEncounterError(res.error.message);
    else setEncounters(res.data);
  }

  function selectEncounter(id: string) {
    const e = encounters?.resources.find((x) => x.id === id) ?? null;
    if (e?.id === encounter?.id) return;
    if (!confirmLeave()) return;
    resetContext();
    setEncounter(e);
  }

  const ctxKey = `${patient?.id ?? "-"}|${encounter?.id ?? "-"}`;
  const fhirBase = status?.fhir.baseUrl ?? "…";

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      {/* Pysyvä kontekstipalkki */}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/95 px-4 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span className="font-semibold text-teal-800">Potilastyötila · demo</span>
          <span>
            <span className="text-zinc-500">Potilas: </span>
            {patient ? (
              <>
                <b>{patientName(patient)}</b> <code className="text-xs text-zinc-600">Patient/{patient.id}</code> {isDemo(patient) && <Badge tone="info">synteettinen demo</Badge>}
              </>
            ) : (
              <i className="text-zinc-500">ei valittu</i>
            )}
          </span>
          <span>
            <span className="text-zinc-500">Kontakti: </span>
            {encounter ? (
              <>
                {encounterLabel(encounter)} <code className="text-xs text-zinc-600">Encounter/{encounter.id}</code>
              </>
            ) : (
              <i className="text-zinc-500">ei valittu</i>
            )}
          </span>
          <span className="text-xs text-zinc-500">
            FHIR: <span className="break-all">{fhirBase}</span>
          </span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-4">
          <Section title="Potilas">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void searchPatients();
              }}
            >
              <input aria-label="Potilashaku" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nimi, id tai system|value" className="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm" />
              <Button type="submit" disabled={searching}>
                Hae
              </Button>
            </form>
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700">
              <input type="checkbox" checked={demoOnly} onChange={(e) => setDemoOnly(e.target.checked)} />
              Vain sovelluksen demoaineisto
            </label>
            <Button variant="ghost" className="mt-1 w-full text-xs" onClick={() => void searchPatients("", true)}>
              Näytä demopotilaat
            </Button>
            {patientError && <ErrorBox title="Potilashaku epäonnistui" message={patientError.message} detail={patientError.detail} />}
            {patients && (
              <div className="mt-2">
                {patients.state === "error" ? (
                  <ErrorBox title="Potilashaku epäonnistui" message={patients.error?.message} detail={patients.error} />
                ) : patients.resources.length === 0 ? (
                  <p className="text-xs text-zinc-600">Ei osumia. {demoOnly && "Luo tarvittaessa harjoitusaineisto alta."}</p>
                ) : (
                  <ul className="space-y-1">
                    {patients.resources.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => void selectPatient(p)} className={`w-full rounded-md border px-2 py-1.5 text-left text-sm ${p.id === patient?.id ? "border-teal-600 bg-teal-50" : "border-zinc-200 hover:bg-zinc-50"}`}>
                          <span className="font-medium">{patientName(p)}</span>
                          <span className="block text-[11px] text-zinc-500">
                            {p.birthDate ?? "syntymäaika ?"} · Patient/{p.id} {isDemo(p) ? "· demo" : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {patients.truncated && <p className="mt-1 text-[11px] text-amber-800">Näytetään enintään 20 osumaa; tarkenna hakua.</p>}
                {patients.warnings.map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-800">
                    {w}
                  </p>
                ))}
              </div>
            )}
          </Section>

          {patient && (
            <Section title="Palvelukontakti">
              {encounterError && <ErrorBox title="Kontaktihaku epäonnistui" message={encounterError} />}
              {!encounters && !encounterError && <p className="text-xs text-zinc-500">Haetaan…</p>}
              {encounters && encounters.resources.length === 0 && <p className="text-xs text-zinc-600">{encounters.state === "error" ? "Haku epäonnistui." : "Potilaalta ei löytynyt kontakteja tästä hausta."}</p>}
              {encounters && encounters.resources.length > 0 && (
                <select aria-label="Palvelukontakti" value={encounter?.id ?? ""} onChange={(e) => selectEncounter(e.target.value)} className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm">
                  <option value="">– valitse kontakti –</option>
                  {encounters.resources.map((e) => (
                    <option key={e.id} value={e.id}>
                      {encounterLabel(e)} · {e.id}
                    </option>
                  ))}
                </select>
              )}
            </Section>
          )}

          <StatusPanel status={status} error={statusError} onRefresh={() => void loadStatus(true)} refreshing={refreshing} />
          <SeedPanel onSeeded={() => void searchPatients("", true)} />
        </aside>

        <main className="min-w-0 space-y-4">
          {!patient ? (
            <Section title="Aloita">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-700">
                <li>Luo tarvittaessa harjoitusaineisto HAPIin (vasemmalla alhaalla).</li>
                <li>Hae ja valitse synteettinen potilas sekä palvelukontakti.</li>
                <li>Kysy potilastiedoista tai kirjaa harjoitusvastaanotto.</li>
              </ol>
              <p className="mt-3 text-xs text-zinc-500">Sovellus tukee tiedonhakua, yhteenvetoa ja kirjaamista. Se ei tee itsenäisiä hoitopäätöksiä.</p>
            </Section>
          ) : (
            <>
              <div role="tablist" className="flex gap-1 border-b border-zinc-300">
                {(
                  [
                    ["ask", "Kysy potilastiedoista"],
                    ["record", "Vastaanotto ja kirjaaminen"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={`-mb-px rounded-t-md border px-4 py-2 text-sm font-medium ${tab === k ? "border-zinc-300 border-b-white bg-white text-teal-800" : "border-transparent text-zinc-600 hover:text-zinc-900"}`}>
                    {label}
                  </button>
                ))}
              </div>
              {/* key: potilaan/kontaktin vaihto nollaa näkymien tilan. */}
              <div key={ctxKey}>
                <div hidden={tab !== "ask"}>
                  <AskView patientId={patient.id!} encounterId={encounter?.id ?? null} guard={guard} languageKind={status?.language.kind} />
                </div>
                <div hidden={tab !== "record"}>
                  <RecordView patientId={patient.id!} encounterId={encounter?.id ?? null} isDemoPatient={isDemo(patient)} guard={guard} status={status} onDirtyChange={onDirtyChange} />
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
