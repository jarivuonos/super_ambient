"use client";

import { useState } from "react";
import { formatDate, type Fact } from "@/lib/clinical/facts";
import { api, type AskResult, type StatusResponse } from "./api";
import { Badge, Button, ErrorBox, JsonDetails, Section } from "./ui";
import type { Guard } from "./Workspace";

const EXAMPLES = [
  "Näytä viimeisimmät verenpaineet",
  "Mitä lääkitystietoja löytyy?",
  "Näytä viimeisin kuvantamislausunto",
  "Mitä keskeisiä ongelmia ja viimeaikaisia muutoksia potilaan tiedoissa näkyy?",
];

const STATE_LABEL: Record<string, { text: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  ok: { text: "Haku onnistui", tone: "good" },
  empty: { text: "Tietoa ei löytynyt", tone: "warn" },
  partial: { text: "Haku jäi osittaiseksi", tone: "warn" },
  error: { text: "Haku epäonnistui", tone: "bad" },
  clarify: { text: "Tarkennus tarvitaan", tone: "info" },
  "service-unavailable": { text: "Mallipalvelu ei ole käytettävissä", tone: "bad" },
};

function FactRow({ f }: { f: Fact }) {
  return (
    <li className="rounded border border-zinc-200 p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="text-xs text-zinc-500">{f.label}</span>
          <p className="font-medium text-zinc-900">{f.text}</p>
        </div>
        <div className="text-right text-xs text-zinc-600">
          <div>
            {f.dateLabel}: <span className="font-medium">{formatDate(f.date)}</span>
          </div>
          <code className="text-[11px] text-zinc-500">
            {f.source.resourceType}/{f.source.id}
          </code>
        </div>
      </div>
      {f.flags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {f.flags.map((x, i) => (
            <Badge key={i} tone={/viitealue|Tulkinta|vanha|puuttuu|odottamaton/i.test(x) ? "warn" : "neutral"}>
              {x}
            </Badge>
          ))}
        </div>
      )}
      <p className="mt-1 text-[11px] text-zinc-500">Kentät: {f.source.fields.join(", ") || "–"}</p>
      {f.attachedText && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-zinc-700">Näytä lähteen teksti (näytetään tietona, ei ohjeina)</summary>
          {/* Ulkoinen teksti renderöidään pelkkänä tekstinä. */}
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-zinc-50 p-2 text-xs text-zinc-800">{f.attachedText}</pre>
        </details>
      )}
    </li>
  );
}

export function AskView({
  patientId,
  encounterId,
  sourceId,
  guard,
  language,
}: {
  patientId: string;
  encounterId: string | null;
  sourceId: string;
  guard: Guard;
  language?: StatusResponse["language"];
}) {
  const [result, setResult] = useState<AskResult | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: unknown } | null>(null);

  async function ask(q: string, interpreter?: "mock") {
    if (!q.trim()) return;
    setQuestion(q);
    setLoading(true);
    setError(null);
    const res = await guard((signal) => api<AskResult>("/api/ask", { json: { question: q, patientId, encounterId, interpreter, sourceId }, signal }));
    if (res === null) return; // potilas vaihtui: vanha vastaus hylätään
    setLoading(false);
    if (!res.ok) {
      if (!res.error.aborted) setError({ message: res.error.message, detail: res.error.detail ?? res.error.status });
      return;
    }
    // Varmistetaan vielä, että vastaus koskee valittua potilasta.
    if (res.data.patientId !== patientId) return;
    setResult(res.data);
  }

  const st = result ? STATE_LABEL[result.state] : null;

  return (
    <div className="space-y-4">
      <Section title="Kysy potilastiedoista">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <input
            aria-label="Kysymys"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            placeholder="Esim. Näytä viimeisimmät verenpaineet"
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <Button type="submit" variant="primary" disabled={loading || !question.trim()}>
            {loading ? "Haetaan…" : "Kysy"}
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((q) => (
            <button key={q} type="button" onClick={() => void ask(q)} disabled={loading} className="rounded-full border border-zinc-300 bg-zinc-50 px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
        {language?.capabilities.interpretQuestion === "mock" && (
          <p className="mt-2 text-xs text-zinc-500">Kysymyksen tulkinta tehdään mock-tilassa avainsanoilla (ei kielimallia). Vastaus kootaan suoraan haetuista resursseista.</p>
        )}
        {language?.capabilities.interpretQuestion === "model" && (
          <p className="mt-2 text-xs text-zinc-500">
            Kysymyksen tulkinta: {language.name}. Palveluun lähetetään vain kysymysteksti, ei potilastietoja. Vastaus kootaan suoraan haetuista resursseista (ei kielimallia), ja lähteet näkyvät alla.
          </p>
        )}
      </Section>

      {error && <ErrorBox title="Kysymystä ei voitu käsitellä" message={error.message} detail={error.detail} />}

      {result && st && (
        <Section title="Vastaus" actions={<Badge tone={st.tone}>{st.text}</Badge>}>
          <p className="mb-1 text-xs text-zinc-500">Kysymys: {result.question}</p>
          <div className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-sm text-zinc-900">{result.answer}</div>
          <p className="mt-1 text-xs text-zinc-500">
            Kysymyksen tulkinta:{" "}
            {result.interpretedBy === "model" ? result.planSource : result.interpretedBy === "mock" ? "mock-säännöt (ei kielimalli)" : "ei käytössä"} · Vastauksen lähde:{" "}
            {result.answerSource === "model"
              ? result.planSource
              : result.answerSource === "mock" || result.answerSource === "deterministic"
                ? "koottu suoraan haetuista resursseista (ei kielimalli)"
                : "faktoista koottu varavastaus"}
          </p>
          {result.state === "service-unavailable" && result.interpretedBy !== "mock" && (
            <div className="mt-2">
              <Button onClick={() => void ask(result.question, "mock")} disabled={loading}>
                Käytä mock-tulkintaa tähän kysymykseen
              </Button>
              <p className="mt-1 text-xs text-zinc-500">Mock-tulkinta on sääntöpohjainen eikä kielimalli; se tunnistaa vain rajatun joukon ilmauksia.</p>
            </div>
          )}
          {result.notes.map((n, i) => (
            <ErrorBox key={i} tone="warn" title="Huomio" message={n} />
          ))}

          {result.facts.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold text-zinc-800">Lähdehavainnot ({result.facts.length})</h3>
              <ul className="space-y-2">
                {result.facts.slice(0, 40).map((f, i) => (
                  <FactRow key={`${f.source.id}-${i}`} f={f} />
                ))}
              </ul>
            </div>
          )}

          {result.missing.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">Puuttuva tai keskeneräinen tieto</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-zinc-700">
                {result.missing.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 space-y-2">
            <details className="rounded border border-zinc-200 px-2 py-1 text-sm">
              <summary className="cursor-pointer text-zinc-700">Hakusuunnitelma ja suoritetut haut</summary>
              {result.plan && (
                <p className="mt-2 text-xs text-zinc-600">
                  Tulkinta: <b>{result.plan.intent}</b> · laajuus: {result.plan.scope === "encounter" ? "valittu kontakti" : "koko potilas"}
                  {result.plan.timeRange?.since ? ` · alkaen ${formatDate(result.plan.timeRange.since)}` : ""} · {result.plan.rationale}
                </p>
              )}
              <ul className="mt-2 space-y-1">
                {result.searches.map((s, i) => (
                  <li key={i} className="rounded bg-zinc-50 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATE_LABEL[s.state]?.tone ?? "neutral"}>{STATE_LABEL[s.state]?.text ?? s.state}</Badge>
                      <span>{s.purpose}</span>
                      <span className="text-zinc-500">
                        {s.count} resurssia{typeof s.total === "number" ? ` (palvelimen ilmoittama yhteensä ${s.total})` : ""}
                      </span>
                      {s.truncated && <Badge tone="warn">raja täyttyi</Badge>}
                    </div>
                    <code className="mt-1 block break-all text-[11px] text-zinc-600">GET /{s.query}</code>
                    {s.warnings.map((w, j) => (
                      <p key={j} className="text-amber-800">
                        Varoitus: {w}
                      </p>
                    ))}
                    {s.error && <p className="text-red-800">Virhe: {s.error.message}</p>}
                  </li>
                ))}
              </ul>
              {result.plan && <JsonDetails summary="Tiedontarve (JSON)" value={result.plan} />}
              {result.interpretation && <JsonDetails summary="Mallin tulkinnan tekniset tiedot (todennäköisyydet, rajat)" value={result.interpretation} />}
            </details>
          </div>
        </Section>
      )}
    </div>
  );
}
