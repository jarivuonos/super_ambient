import type { Reference, Resource } from "./types";

/** Palauttaa viitteen muodossa `Type/id`, jos se osoittaa sallitulle palvelimelle tai on suhteellinen. */
export function normalizeReference(ref: string | undefined, baseUrl: string): string | undefined {
  if (!ref) return undefined;
  const base = baseUrl.replace(/\/+$/, "");
  let r = ref;
  if (/^https?:\/\//i.test(r)) {
    if (!r.startsWith(base + "/")) return undefined; // ulkopuolinen viite
    r = r.slice(base.length + 1);
  }
  const m = /^([A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[A-Za-z0-9\-.]+)?$/.exec(r);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Resurssin potilasviite resurssityypin mukaisesta kentästä. */
export function patientReferenceOf(resource: Resource): Reference | undefined {
  switch (resource.resourceType) {
    case "Patient":
      return { reference: `Patient/${resource.id}` };
    case "AllergyIntolerance":
      return resource.patient as Reference | undefined;
    default:
      return resource.subject as Reference | undefined;
  }
}

export function belongsToPatient(resource: Resource, patientId: string, baseUrl: string): boolean {
  const ref = normalizeReference(patientReferenceOf(resource)?.reference, baseUrl);
  return ref === `Patient/${patientId}`;
}

/**
 * Suodattaa pois resurssit, jotka eivät kuulu valitulle potilaalle.
 * Palauttaa myös poistettujen määrän, jotta käyttäjälle voidaan kertoa siitä.
 */
export function filterToPatient<T extends Resource>(
  resources: T[],
  patientId: string,
  baseUrl: string,
): { kept: T[]; rejected: number } {
  const kept: T[] = [];
  let rejected = 0;
  for (const r of resources) {
    if (belongsToPatient(r, patientId, baseUrl)) kept.push(r);
    else rejected++;
  }
  return { kept, rejected };
}
