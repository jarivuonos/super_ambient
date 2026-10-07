import { buildFixtureBundle } from "../lib/fhir/fixtures";
import { HapiR4Adapter } from "../lib/fhir/hapi-adapter";
import { DEMO_IDENTIFIER_SYSTEM } from "../lib/fhir/search-builders";
import { BASE, FakeFhir } from "./fake-fhir";

export function setup(opts: { seed?: boolean } = {}) {
  const fake = new FakeFhir();
  const ehr = new HapiR4Adapter({ baseUrl: BASE, fetchImpl: fake.fetch as typeof fetch, retryDelayMs: 0, timeoutMs: 2000 });
  if (opts.seed !== false) fake.handleTransaction(buildFixtureBundle().bundle);
  const idOf = (type: string, key: string) =>
    fake.all(type).find((r) => r.identifier?.some((i) => i.system === DEMO_IDENTIFIER_SYSTEM && i.value === key))?.id ?? "";
  return { fake, ehr, idOf };
}
