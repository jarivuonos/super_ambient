// Muistinvarainen FHIR-palvelimen jäljitelmä testejä varten. Ei verkkoliikennettä.

import type { Bundle, BundleEntry, Resource } from "../lib/fhir/types";

export const BASE = "https://fake.fhir.test/baseR4";

type Hook = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

export class FakeFhir {
  store = new Map<string, Resource>();
  private seq = 1;
  calls: { method: string; url: string }[] = [];
  hooks: Hook[] = [];
  transaction = true;

  json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/fhir+json", ...headers } });
  }

  put(r: Resource): Resource {
    const id = r.id ?? String(this.seq++);
    const stored = { ...r, id, meta: { ...(r.meta ?? {}), versionId: "1", lastUpdated: "2026-10-07T10:00:00Z" } };
    this.store.set(`${r.resourceType}/${id}`, stored);
    return stored;
  }

  all(type: string): Resource[] {
    return [...this.store.values()].filter((r) => r.resourceType === type);
  }

  private matches(r: Resource, key: string, value: string): boolean {
    const ref = (x: unknown) => (x as { reference?: string } | undefined)?.reference;
    switch (key) {
      case "patient":
        return (ref(r.subject) ?? ref(r.patient)) === `Patient/${value}`;
      case "encounter":
        return ref(r.encounter) === `Encounter/${value}`;
      case "_id":
        return r.id === value;
      case "identifier": {
        const [sys, val] = value.includes("|") ? value.split("|") : [undefined, value];
        return !!r.identifier?.some((i) => (sys === undefined || i.system === sys) && i.value === val);
      }
      case "_tag": {
        const [sys, code] = value.split("|");
        return !!r.meta?.tag?.some((t) => t.system === sys && t.code === code);
      }
      case "code": {
        const codes = value.split(",").map((v) => v.split("|"));
        const cc = r.code as { coding?: { system?: string; code?: string }[] } | undefined;
        return codes.some(([s, c]) => cc?.coding?.some((x) => x.system === s && x.code === c));
      }
      case "category": {
        const cats = (r.category as { coding?: { code?: string }[] }[] | undefined) ?? [];
        return cats.some((c) => c.coding?.some((x) => x.code === value));
      }
      case "name":
        return JSON.stringify(r.name ?? "").toLowerCase().includes(value.toLowerCase());
      case "date":
        return true;
      default:
        return true;
    }
  }

  search(type: string, params: URLSearchParams): Resource[] {
    let out = this.all(type);
    for (const [k, v] of params) {
      if (k.startsWith("_") && !["_id", "_tag"].includes(k)) continue;
      out = out.filter((r) => this.matches(r, k, v));
    }
    return out;
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? "GET";
    this.calls.push({ method, url: url.href });
    for (const h of this.hooks) {
      const r = await h(url, init);
      if (r) return r;
    }
    const path = url.pathname.replace(/^\/baseR4\/?/, "");
    if (method === "GET" && path === "metadata") return this.json(200, this.capability());
    if (method === "POST" && path === "") return this.handleTransaction(JSON.parse(String(init.body)));
    if (method === "POST" && path.endsWith("/$validate")) return this.json(200, { resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: "ok" }] });
    const parts = path.split("/");
    if (method === "GET" && parts.length === 2) {
      const r = this.store.get(path);
      return r ? this.json(200, r) : this.json(404, { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-found", diagnostics: "Resource not found" }] });
    }
    if (method === "GET" && parts.length === 1) {
      const all = this.search(parts[0], url.searchParams);
      const count = Number(url.searchParams.get("_count") ?? 20);
      const offset = Number(url.searchParams.get("_getpagesoffset") ?? 0);
      const page = all.slice(offset, offset + count);
      const bundle: Bundle = {
        resourceType: "Bundle",
        type: "searchset",
        total: all.length,
        entry: page.map((r) => ({ fullUrl: `${BASE}/${r.resourceType}/${r.id}`, resource: r, search: { mode: "match" } })),
        link: [],
      };
      if (offset + count < all.length) {
        const next = new URL(url.href);
        next.searchParams.set("_getpagesoffset", String(offset + count));
        bundle.link!.push({ relation: "next", url: next.href });
      }
      return this.json(200, bundle);
    }
    return this.json(400, { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "not-supported", diagnostics: "unsupported" }] });
  };

  capability() {
    const types = ["Patient", "Encounter", "Observation", "Condition", "DocumentReference", "MedicationRequest", "MedicationStatement", "AllergyIntolerance", "DiagnosticReport"];
    return {
      resourceType: "CapabilityStatement",
      fhirVersion: "4.0.1",
      software: { name: "Fake", version: "1" },
      rest: [
        {
          mode: "server",
          interaction: this.transaction ? [{ code: "transaction" }] : [],
          resource: types.map((t) => ({ type: t, conditionalCreate: true, interaction: ["read", "search-type", "create"].map((code) => ({ code })), searchParam: ["patient", "identifier", "code", "category", "date", "encounter", "name", "subject"].map((name) => ({ name })) })),
        },
      ],
    };
  }

  handleTransaction(bundle: Bundle): Response {
    if (bundle.type !== "transaction") return this.json(400, { resourceType: "OperationOutcome", issue: [{ severity: "error", code: "invalid" }] });
    const resolved = new Map<string, string>();
    const results: BundleEntry[] = [];
    const pending: { entry: BundleEntry; existing?: Resource }[] = [];
    for (const e of bundle.entry ?? []) {
      let existing: Resource | undefined;
      if (e.request?.ifNoneExist) {
        const params = new URLSearchParams(e.request.ifNoneExist);
        existing = this.search(e.request.url, params)[0];
      }
      if (existing && e.fullUrl) resolved.set(e.fullUrl, `${existing.resourceType}/${existing.id}`);
      pending.push({ entry: e, existing });
    }
    // Varataan id:t ensin, jotta urn:uuid-viitteet voidaan ratkaista.
    const ids = pending.map((p) => (p.existing ? p.existing.id! : String(this.seq++)));
    pending.forEach((p, i) => p.entry.fullUrl && !p.existing && resolved.set(p.entry.fullUrl, `${p.entry.resource!.resourceType}/${ids[i]}`));
    const fix = (o: unknown): unknown => {
      if (Array.isArray(o)) return o.map(fix);
      if (o && typeof o === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o)) out[k] = k === "reference" && typeof v === "string" && resolved.has(v) ? resolved.get(v) : fix(v);
        return out;
      }
      return o;
    };
    pending.forEach((p, i) => {
      if (p.existing) {
        results.push({ response: { status: "200 OK", location: `${p.existing.resourceType}/${p.existing.id}/_history/1` } });
      } else {
        const r = this.put({ ...(fix(p.entry.resource) as Resource), id: ids[i] });
        results.push({ response: { status: "201 Created", location: `${r.resourceType}/${r.id}/_history/1` } });
      }
    });
    return this.json(200, { resourceType: "Bundle", type: "transaction-response", entry: results });
  }
}
