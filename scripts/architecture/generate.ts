// Generoi alustavan arkkitehtuurikuvauksen mallista (scripts/architecture/model.ts):
//   docs/architecture/super_ambient-architecture.xml   ArchiMate Open Group Exchange Format (3.x)
//   docs/architecture/views/*.svg                      yksinkertaistetut näkymäkuvat
//   docs/architecture/super_ambient-architecture.pdf   dokumentti (HTML → PDF Firefoxilla)
//
// Käyttö: bun run architecture:build [-- --no-pdf]
// Valinnainen XSD-validointi: ARCHIMATE_XSD_DIR=<hakemisto, jossa archimate3_Diagram.xsd ja sen riippuvuudet>
//
// Generaattori epäonnistuu, jos malli on epäjohdonmukainen: tuntematon elementti, virheellinen
// relaatiopari, puuttuva lähdetiedosto, piirrettävää relaatiota ei ole mallissa tai elementti puuttuu kaikista näkymistä.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { ELEMENTS, LAYER_OF, RELATIONS, VIEWS, type El, type ElementType, type Layer, type Rel, type RelType, type Status, type ViewSpec } from "./model";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "docs/architecture");
const BASENAME = "super_ambient-architecture";

// ---------------------------------------------------------------------------------------------
// Validointi
// ---------------------------------------------------------------------------------------------

/** ArchiMate 3.1:n suhdetaulukosta vain varmasti sallitut parit; Association on aina sallittu. */
const VALID: Record<Exclude<RelType, "Association">, [ElementType, ElementType][]> = {
  Assignment: [["BusinessActor", "BusinessRole"], ["BusinessRole", "BusinessProcess"], ["Node", "Artifact"]],
  Composition: [["ApplicationComponent", "ApplicationComponent"], ["ApplicationComponent", "ApplicationInterface"], ["Node", "SystemSoftware"]],
  Realization: [["ApplicationComponent", "ApplicationService"], ["DataObject", "BusinessObject"], ["BusinessProcess", "BusinessService"], ["Artifact", "ApplicationComponent"], ["Requirement", "Goal"], ["Node", "TechnologyService"]],
  Serving: [["ApplicationService", "BusinessProcess"], ["ApplicationService", "ApplicationComponent"], ["ApplicationComponent", "BusinessProcess"], ["TechnologyService", "ApplicationComponent"], ["BusinessService", "BusinessRole"], ["ApplicationInterface", "ApplicationComponent"]],
  Access: [["ApplicationComponent", "DataObject"], ["BusinessProcess", "BusinessObject"]],
  Influence: [["Driver", "Goal"], ["Principle", "Goal"]],
  Triggering: [["BusinessProcess", "BusinessProcess"], ["WorkPackage", "WorkPackage"], ["Plateau", "Plateau"]],
  Flow: [["ApplicationComponent", "ApplicationComponent"], ["Node", "Node"]],
};

const byId = new Map<string, El>(ELEMENTS.map((x) => [x.id, x]));

function validateModel(): { orphans: string[] } {
  const errors: string[] = [];
  if (byId.size !== ELEMENTS.length) errors.push("Elementtien tunnisteet eivät ole yksilöllisiä.");
  for (const el of ELEMENTS) {
    for (const p of el.source ?? []) if (!fs.existsSync(path.join(ROOT, p))) errors.push(`Lähdepolkua ei ole: ${p} (${el.id})`);
  }
  const seen = new Set<string>();
  for (const rel of RELATIONS) {
    const s = byId.get(rel.source);
    const t = byId.get(rel.target);
    const key = `${rel.type}:${rel.source}>${rel.target}`;
    if (seen.has(key)) errors.push(`Kaksoiskappale: ${key}`);
    seen.add(key);
    if (!s || !t) {
      errors.push(`Tuntematon päätepiste: ${key}`);
      continue;
    }
    if (rel.type !== "Association" && !VALID[rel.type].some(([a, b]) => a === s.type && b === t.type)) {
      errors.push(`Ei sallittu relaatiopari: ${rel.type} ${s.type} → ${t.type} (${key})`);
    }
  }
  const placed = new Set<string>();
  for (const v of VIEWS) {
    const inView = new Set<string>();
    for (const n of v.nodes) {
      for (const id of [n.id, ...(n.kids?.ids ?? [])]) {
        if (!byId.has(id)) errors.push(`Näkymä ${v.id}: tuntematon elementti ${id}`);
        if (inView.has(id)) errors.push(`Näkymä ${v.id}: ${id} kahteen kertaan`);
        inView.add(id);
        placed.add(id);
      }
    }
    for (const spec of v.edges) {
      const rel = findRel(spec);
      if (!rel) errors.push(`Näkymä ${v.id}: relaatiota ei ole mallissa: ${spec}`);
      else if (!inView.has(rel.source) || !inView.has(rel.target)) errors.push(`Näkymä ${v.id}: relaation päätepiste ei ole näkymässä: ${spec}`);
    }
  }
  const orphans = ELEMENTS.filter((x) => !placed.has(x.id)).map((x) => x.id);
  if (orphans.length) errors.push(`Elementit puuttuvat kaikista näkymistä: ${orphans.join(", ")}`);
  if (errors.length) throw new Error(`Mallin validointi epäonnistui:\n - ${errors.join("\n - ")}`);
  return { orphans };
}

function findRel(spec: string): Rel | undefined {
  const m = /^(\w+):([^>]+)>(.+)$/.exec(spec);
  if (!m) return undefined;
  return RELATIONS.find((r) => r.type === m[1] && r.source === m[2] && r.target === m[3]);
}

// ---------------------------------------------------------------------------------------------
// Asettelu
// ---------------------------------------------------------------------------------------------

const BW = 156;
const BH = 62;
const GX = 26;
const GY = 30;
const COL = BW + GX;
const ROW = BH + GY;
const MARGIN = 20;
const KGAP = 14;
const PAD = 14;
const HEAD = 50;

interface Box {
  id: string;
  x: number; // absoluuttinen (SVG)
  y: number;
  w: number;
  h: number;
  /** Suhteellinen sijainti vanhempaan (Exchange-XML); ylätasolla = absoluuttinen. */
  rx: number;
  ry: number;
  kids: Box[];
}

interface Layout {
  boxes: Box[];
  all: Map<string, Box>;
  width: number;
  height: number;
}

function layoutView(v: ViewSpec): Layout {
  const all = new Map<string, Box>();
  const boxes: Box[] = [];
  for (const n of v.nodes) {
    const x = Math.round(MARGIN + n.col * COL);
    const y = Math.round(MARGIN + n.row * ROW);
    const el = byId.get(n.id)!;
    if (n.kids) {
      const rows = Math.ceil(n.kids.ids.length / n.kids.cols);
      const w = 2 * PAD + n.kids.cols * BW + (n.kids.cols - 1) * KGAP;
      const h = HEAD + rows * BH + (rows - 1) * KGAP + PAD;
      const parent: Box = { id: n.id, x, y, w, h, rx: x, ry: y, kids: [] };
      n.kids.ids.forEach((kid, i) => {
        const rx = PAD + (i % n.kids!.cols) * (BW + KGAP);
        const ry = HEAD + Math.floor(i / n.kids!.cols) * (BH + KGAP);
        const kb: Box = { id: kid, x: x + rx, y: y + ry, w: BW, h: BH, rx, ry, kids: [] };
        parent.kids.push(kb);
        all.set(kid, kb);
      });
      boxes.push(parent);
      all.set(n.id, parent);
    } else {
      const w = el.type === "CommunicationNetwork" ? Math.round(4.6 * COL) : BW;
      const h = el.type === "CommunicationNetwork" ? 40 : BH;
      const b: Box = { id: n.id, x, y, w, h, rx: x, ry: y, kids: [] };
      boxes.push(b);
      all.set(n.id, b);
    }
  }
  const width = Math.max(...[...all.values()].map((b) => b.x + b.w)) + MARGIN;
  const height = Math.max(...[...all.values()].map((b) => b.y + b.h)) + MARGIN;
  return { boxes, all, width, height };
}

// ---------------------------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------------------------

const FILL: Record<Layer, string> = {
  Motivation: "#ccccff",
  Business: "#ffffb5",
  Application: "#b5ffff",
  Technology: "#c9e7b7",
  "Implementation and migration": "#ffe0e0",
};

const STATUS_LABEL: Partial<Record<Status, string>> = {
  planned: "planned",
  parked: "parked",
  "opt-in": "opt-in",
  "not-configured": "not configured",
  external: "external",
  "dev-tooling": "dev tooling",
};
const DASHED: Status[] = ["planned", "parked", "not-configured"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const typeTag = (t: ElementType) => `«${t.replace(/([a-z])([A-Z])/g, "$1 $2")}»`;

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= max) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function clipToRect(b: Box, tx: number, ty: number, gap = 2): [number, number] {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Infinity : (b.w / 2 + gap) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (b.h / 2 + gap) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

function boxSvg(b: Box): string {
  const el = byId.get(b.id)!;
  const layer = LAYER_OF[el.type];
  const dashed = DASHED.includes(el.status);
  const fill = FILL[layer];
  const stroke = el.status === "external" ? "#555" : "#333";
  const isParent = b.kids.length > 0;
  const parts: string[] = [];
  parts.push(
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${isParent ? 8 : 6}" fill="${fill}" fill-opacity="${dashed ? 0.55 : isParent ? 0.7 : 1}" stroke="${stroke}" stroke-width="${isParent ? 1.4 : 1}"${dashed ? ' stroke-dasharray="5 3"' : ""}/>`,
  );
  const status = STATUS_LABEL[el.status];
  if (isParent) {
    const maxP = Math.floor((b.w - 20) / 6.6);
    let nameLines = wrap(el.name, maxP);
    if (nameLines.length > 2) nameLines = [nameLines[0], nameLines[1].slice(0, maxP - 1) + "…"];
    nameLines.forEach((ln, i) => parts.push(`<text x="${b.x + 10}" y="${b.y + 17 + i * 14}" font-size="11.5" font-weight="700" fill="#111">${esc(ln)}</text>`));
    parts.push(`<text x="${b.x + 10}" y="${b.y + 17 + nameLines.length * 14 - 2}" font-size="8" fill="#444">${esc(typeTag(el.type))}${status ? " · " + esc(status) : ""}</text>`);
  } else {
    const max = Math.floor((b.w - 14) / 5.7);
    let lines = wrap(el.name, max);
    if (lines.length > 3) lines = [...lines.slice(0, 2), lines[2].slice(0, max - 1) + "…"];
    const startY = b.y + (b.h - 12) / 2 - ((lines.length - 1) * 13) / 2 + (el.type === "CommunicationNetwork" ? 6 : 2);
    lines.forEach((ln, i) => parts.push(`<text x="${b.x + b.w / 2}" y="${startY + i * 13}" font-size="11" text-anchor="middle" fill="#111">${esc(ln)}</text>`));
    if (el.type !== "CommunicationNetwork") {
      parts.push(`<text x="${b.x + b.w / 2}" y="${b.y + b.h - 6}" font-size="7.5" text-anchor="middle" fill="#555">${esc(typeTag(el.type))}${status ? " · " + esc(status) : ""}</text>`);
    }
  }
  return parts.join("\n");
}

const MARKERS = `
<defs>
  <marker id="open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="#333" stroke-width="1.3"/></marker>
  <marker id="filled" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 Z" fill="#333" stroke="#333"/></marker>
  <marker id="hollow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M1 1 L11 6 L1 11 Z" fill="#fff" stroke="#333" stroke-width="1.2"/></marker>
  <marker id="dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7"><circle cx="5" cy="5" r="3.5" fill="#333"/></marker>
  <marker id="diamond" viewBox="0 0 14 10" refX="1" refY="5" markerWidth="13" markerHeight="9" orient="auto-start-reverse"><path d="M1 5 L7 1 L13 5 L7 9 Z" fill="#333" stroke="#333"/></marker>
</defs>`;

/** Suhteen piirtogeometria. Viestintäverkko (pitkä palkki) yhdistetään pystysuoralla viivalla muuhun elementtiin. */
function edgeGeom(rel: Rel, lay: Layout): [number, number, number, number] {
  const a = lay.all.get(rel.source)!;
  const b = lay.all.get(rel.target)!;
  const isNet = (id: string) => byId.get(id)?.type === "CommunicationNetwork";
  if (isNet(rel.source) || isNet(rel.target)) {
    const net = isNet(rel.source) ? a : b;
    const other = net === a ? b : a;
    const x = Math.min(Math.max(other.x + other.w / 2, net.x + 8), net.x + net.w - 8);
    const above = other.y + other.h <= net.y;
    const [ox, oy] = [x, above ? other.y + other.h : other.y];
    const [nx, ny] = [x, above ? net.y : net.y + net.h];
    return net === a ? [nx, ny, ox, oy] : [ox, oy, nx, ny];
  }
  const [x1, y1] = clipToRect(a, b.x + b.w / 2, b.y + b.h / 2);
  const [x2, y2] = clipToRect(b, a.x + a.w / 2, a.y + a.h / 2);
  return [x1, y1, x2, y2];
}

/** Liang–Barsky: leikkaako jana suorakulmion (sisennettynä)? */
function segmentHitsRect(x1: number, y1: number, x2: number, y2: number, b: Box, inset = 2): boolean {
  const xmin = b.x + inset;
  const xmax = b.x + b.w - inset;
  const ymin = b.y + inset;
  const ymax = b.y + b.h - inset;
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - xmin, xmax - x1, y1 - ymin, ymax - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** Palauttaa piirretyt viivat, jotka leikkaavat muun kuin päätepisteen (tai sen säiliön) laatikkoa. */
function findCrossings(v: ViewSpec, lay: Layout): string[] {
  const parentOf = new Map<string, string>();
  for (const b of lay.boxes) for (const k of b.kids) parentOf.set(k.id, b.id);
  const allBoxes = [...lay.all.values()];
  const problems: string[] = [];
  for (const spec of v.edges) {
    const rel = findRel(spec)!;
    const [x1, y1, x2, y2] = edgeGeom(rel, lay);
    const skip = new Set<string>([rel.source, rel.target]);
    for (const id of [rel.source, rel.target]) if (parentOf.has(id)) skip.add(parentOf.get(id)!);
    for (const b of allBoxes) {
      if (skip.has(b.id)) continue;
      if (segmentHitsRect(x1, y1, x2, y2, b)) problems.push(`${v.id}: ${spec} kulkee elementin ${b.id} läpi`);
    }
  }
  return problems;
}

function edgeSvg(rel: Rel, lay: Layout): string {
  const [x1, y1, x2, y2] = edgeGeom(rel, lay);
  let dash = "";
  let start = "";
  let end = "";
  switch (rel.type) {
    case "Serving": end = "open"; break;
    case "Triggering": end = "filled"; break;
    case "Flow": dash = "6 3"; end = "filled"; break;
    case "Realization": dash = "3 3"; end = "hollow"; break;
    case "Assignment": start = "dot"; end = "filled"; break;
    case "Composition": start = "diamond"; break;
    case "Influence": dash = "6 3"; end = "open"; break;
    case "Access":
      dash = "2 2";
      if (rel.access === "Read") start = "open";
      else if (rel.access === "ReadWrite") { start = "open"; end = "open"; } else end = "open";
      break;
    case "Association": break;
  }
  const attrs = [dash ? `stroke-dasharray="${dash}"` : "", start ? `marker-start="url(#${start})"` : "", end ? `marker-end="url(#${end})"` : ""].filter(Boolean).join(" ");
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#333" stroke-width="1.1" ${attrs}/>`;
}

function viewSvg(v: ViewSpec, lay: Layout): string {
  const parents = lay.boxes.filter((b) => b.kids.length);
  const body = [
    ...lay.boxes.map((b) => boxSvg(b)),
    ...parents.flatMap((p) => p.kids.map((k) => boxSvg(k))),
  ];
  const edges = v.edges.map((s) => edgeSvg(findRel(s)!, lay));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lay.width} ${lay.height}" width="${lay.width}" height="${lay.height}" font-family="'Noto Sans','DejaVu Sans',Arial,sans-serif" role="img" aria-label="${esc(v.name)}">
<title>${esc(v.name)}</title>${MARKERS}
<rect width="100%" height="100%" fill="#fff"/>
${body.join("\n")}
${edges.join("\n")}
</svg>`;
}

const LEGEND_SVG = (() => {
  const items: { label: string; fill: string }[] = Object.entries(FILL).map(([l, f]) => ({ label: l, fill: f }));
  const rects = items.map((it, i) => `<rect x="${10 + i * 150}" y="10" width="14" height="14" rx="3" fill="${it.fill}" stroke="#333"/><text x="${30 + i * 150}" y="21" font-size="9">${esc(it.label)}</text>`).join("");
  const lines: [string, string, string][] = [
    ["Serving", "", 'marker-end="url(#open)"'],
    ["Flow", 'stroke-dasharray="6 3"', 'marker-end="url(#filled)"'],
    ["Triggering", "", 'marker-end="url(#filled)"'],
    ["Realization", 'stroke-dasharray="3 3"', 'marker-end="url(#hollow)"'],
    ["Assignment", "", 'marker-start="url(#dot)" marker-end="url(#filled)"'],
    ["Composition", "", 'marker-start="url(#diamond)"'],
    ["Access (read/write)", 'stroke-dasharray="2 2"', 'marker-end="url(#open)"'],
    ["Influence", 'stroke-dasharray="6 3"', 'marker-end="url(#open)"'],
    ["Association", "", ""],
  ];
  const ls = lines.map(([lab, d, m], i) => {
    const x = 10 + (i % 5) * 150;
    const y = 52 + Math.floor(i / 5) * 24;
    return `<line x1="${x}" y1="${y}" x2="${x + 34}" y2="${y}" stroke="#333" stroke-width="1.1" ${d} ${m}/><text x="${x + 42}" y="${y + 3}" font-size="9">${esc(lab)}</text>`;
  }).join("");
  const dashedBox = `<rect x="10" y="104" width="60" height="22" rx="5" fill="#b5ffff" fill-opacity=".55" stroke="#333" stroke-dasharray="5 3"/><text x="78" y="119" font-size="9">dashed border: planned, parked or not configured</text><rect x="380" y="104" width="60" height="22" rx="5" fill="#b5ffff" stroke="#555"/><text x="448" y="119" font-size="9">small grey tag: status such as external, opt-in, dev tooling</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 136" width="800" height="136" font-family="'Noto Sans','DejaVu Sans',Arial,sans-serif" role="img" aria-label="Legend">${MARKERS}<rect width="100%" height="100%" fill="#fff"/>${rects}${ls}${dashedBox}</svg>`;
})();

// ---------------------------------------------------------------------------------------------
// ArchiMate Exchange Format
// ---------------------------------------------------------------------------------------------

const xesc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Provenance {
  commit: string;
  dirty: boolean;
  date: string;
}

function provenance(): Provenance {
  let commit = "unknown";
  let dirty = false;
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
    dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim().length > 0;
  } catch {
    /* ei git-repoa */
  }
  return { commit, dirty, date: new Date().toISOString().slice(0, 10) };
}

function buildXml(p: Provenance, layouts: Map<string, Layout>): string {
  const L = (s: string, tag: string) => `<${tag} xml:lang="en">${xesc(s)}</${tag}>`;
  const prop = (ref: string, value: string) => `<property propertyDefinitionRef="${ref}"><value xml:lang="en">${xesc(value)}</value></property>`;
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengroup.org/xsd/archimate/3.0/ http://www.opengroup.org/xsd/archimate/3.1/archimate3_Diagram.xsd" identifier="id-model-super-ambient">`);
  out.push(`  ${L("super_ambient: preliminary architecture", "name")}`);
  out.push(`  ${L("Preliminary ArchiMate model of the super_ambient demo (synthetic-data FHIR patient workspace with ambient documentation and Jev classification). Generated from the code; not reviewed. See the accompanying PDF for the narrative.", "documentation")}`);
  out.push(`  <properties>`);
  out.push(`    ${prop("id-pd-gen", `commit ${p.commit}${p.dirty ? " plus uncommitted changes" : ""}, generated ${p.date}`)}`);
  out.push(`    ${prop("id-pd-review", "preliminary, not reviewed")}`);
  out.push(`  </properties>`);

  out.push(`  <elements>`);
  for (const el of ELEMENTS) {
    out.push(`    <element identifier="id-${el.id}" xsi:type="${el.type}">`);
    out.push(`      ${L(el.name, "name")}`);
    out.push(`      ${L(el.doc, "documentation")}`);
    out.push(`      <properties>`);
    out.push(`        ${prop("id-pd-status", el.status)}`);
    for (const s of el.source ?? []) out.push(`        ${prop("id-pd-source", s)}`);
    out.push(`      </properties>`);
    out.push(`    </element>`);
  }
  out.push(`  </elements>`);

  const relIds = new Map<Rel, string>();
  out.push(`  <relationships>`);
  RELATIONS.forEach((rel, i) => {
    const id = `id-rel-${i + 1}`;
    relIds.set(rel, id);
    const attrs = rel.type === "Access" ? ` accessType="${rel.access ?? "Write"}"` : rel.type === "Association" ? ` isDirected="false"` : "";
    const hasStatus = rel.status && rel.status !== "implemented";
    if (hasStatus) {
      out.push(`    <relationship identifier="${id}" source="id-${rel.source}" target="id-${rel.target}" xsi:type="${rel.type}"${attrs}>`);
      out.push(`      <properties>${prop("id-pd-status", rel.status!)}</properties>`);
      out.push(`    </relationship>`);
    } else {
      out.push(`    <relationship identifier="${id}" source="id-${rel.source}" target="id-${rel.target}" xsi:type="${rel.type}"${attrs}/>`);
    }
  });
  out.push(`  </relationships>`);

  out.push(`  <propertyDefinitions>`);
  out.push(`    <propertyDefinition identifier="id-pd-status" type="string">${L("Status", "name")}</propertyDefinition>`);
  out.push(`    <propertyDefinition identifier="id-pd-source" type="string">${L("Source", "name")}</propertyDefinition>`);
  out.push(`    <propertyDefinition identifier="id-pd-gen" type="string">${L("Generated from", "name")}</propertyDefinition>`);
  out.push(`    <propertyDefinition identifier="id-pd-review" type="string">${L("Review status", "name")}</propertyDefinition>`);
  out.push(`  </propertyDefinitions>`);

  out.push(`  <views>`);
  out.push(`    <diagrams>`);
  for (const v of VIEWS) {
    const lay = layouts.get(v.id)!;
    out.push(`      <view identifier="id-${v.id}">`);
    out.push(`        ${L(v.name, "name")}`);
    out.push(`        ${L(v.description, "documentation")}`);
    const nodeId = (id: string) => `id-${v.id}-${id}`;
    const nodeXml = (b: Box, depth: number): string[] => {
      const pad = "        ".concat("  ".repeat(depth));
      const open = `${pad}<node identifier="${nodeId(b.id)}" elementRef="id-${b.id}" xsi:type="Element" x="${Math.round(b.rx)}" y="${Math.round(b.ry)}" w="${b.w}" h="${b.h}"`;
      if (!b.kids.length) return [`${open}/>`];
      return [`${open}>`, ...b.kids.flatMap((k) => nodeXml(k, depth + 1)), `${pad}</node>`];
    };
    for (const b of lay.boxes) out.push(...nodeXml(b, 0));
    v.edges.forEach((spec, i) => {
      const rel = findRel(spec)!;
      out.push(`        <connection identifier="id-${v.id}-c${i + 1}" relationshipRef="${relIds.get(rel)}" xsi:type="Relationship" source="${nodeId(rel.source)}" target="${nodeId(rel.target)}"/>`);
    });
    out.push(`      </view>`);
  }
  out.push(`    </diagrams>`);
  out.push(`  </views>`);
  out.push(`</model>`);
  return out.join("\n") + "\n";
}

function validateXsd(xmlPath: string): string {
  const dir = process.env.ARCHIMATE_XSD_DIR;
  if (!dir) return "not performed (ARCHIMATE_XSD_DIR not set)";
  try {
    execFileSync("xmllint", ["--noout", "--schema", path.join(dir, "archimate3_Diagram.xsd"), xmlPath], { stdio: "pipe" });
    return "passed (xmllint against the Open Group archimate3_Diagram.xsd, ArchiMate 3.1 exchange schema)";
  } catch (err) {
    const msg = String((err as { stderr?: Buffer }).stderr ?? err).split("\n").slice(0, 6).join("\n");
    throw new Error(`XSD-validointi epäonnistui:\n${msg}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Dokumentti (HTML → PDF)
// ---------------------------------------------------------------------------------------------

const h = esc;
const statusBadge = (s: Status) => `<span class="st st-${s}">${h(STATUS_LABEL[s] ?? s)}</span>`;
const nameOf = (id: string) => byId.get(id)?.name ?? id;

function elementTable(types: ElementType[], withSource = true): string {
  const rows = ELEMENTS.filter((x) => types.includes(x.type));
  return `<table><thead><tr><th>Element</th><th>Type</th><th>Status</th><th>Responsibility${withSource ? " and source" : ""}</th></tr></thead><tbody>${rows
    .map(
      (x) =>
        `<tr><td>${h(x.name)}</td><td>${h(typeTag(x.type))}</td><td>${statusBadge(x.status)}</td><td>${h(x.doc)}${withSource && x.source?.length ? `<div class="src">${x.source.map((s) => `<code>${h(s)}</code>`).join(" ")}</div>` : ""}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function buildHtml(p: Provenance, svgs: Map<string, string>, xsdResult: string): string {
  const fig = (v: ViewSpec, n: string) => `<figure><div class="fig">${svgs.get(v.id)!}</div><figcaption><b>Figure ${n}. ${h(v.name.replace(/^\d+ /, ""))}.</b> ${h(v.description)}</figcaption></figure>`;
  const V = Object.fromEntries(VIEWS.map((v) => [v.id, v])) as Record<string, ViewSpec>;
  const layerCount = (l: Layer) => ELEMENTS.filter((x) => LAYER_OF[x.type] === l).length;
  const relCount = (t: RelType) => RELATIONS.filter((x) => x.type === t).length;

  const config = [
    ["FHIR_BASE_URL", "https://hapi.fhir.org/baseR4", "FHIR server; https assumed; paging links are checked against this origin and path."],
    ["FHIR_TIMEOUT_MS", "20000", "Per request timeout; GET retried twice, POST never retried automatically."],
    ["EPIC_CLIENT_ID", "unset", "Epic sandbox client id (not secret, kept in the environment). Without it the Epic source shows a message and login is unavailable."],
    ["LLM_PROVIDER", "mock", "mock, jev or none. Jev without a key is reported as unavailable, never guessed."],
    ["LLM_STRUCTURING", "mock", "jev sends transcript sentences (no identifiers) to Typesafe. Only effective when LLM_PROVIDER=jev."],
    ["TYPESAFE_API_KEY (LLM_API_KEY fallback)", "unset", "Server-side secret; never exposed to the browser or in errors."],
    ["LLM_ENDPOINT / LLM_MODEL", "https://api.typesafe.ai/v1/systemone / jev-latest", "Endpoint must be https."],
    ["JEV_CONCURRENCY", "1", "1 to 8 parallel Jev requests; 1 suits the entry plan."],
    ["TRANSCRIPTION_PROVIDER", "none", "No provider is implemented; the transcript is pasted by hand."],
  ];

  const integrations = [
    ["Browser to application server", "HTTPS, JSON, /api/*", "Questions, transcripts, proposals, save requests", "Boundary 1. No authentication in the demo; protect the deployment (e.g. Vercel Deployment Protection)."],
    ["Server to HAPI FHIR R4", "HTTPS REST, application/fhir+json", "Searches, reads, $validate, one write transaction", "Boundary 2. Public, shared server: synthetic data only. Writes only for demo-tagged patients."],
    ["Browser to Epic login", "HTTPS redirect (authorize), then redirect back to /api/auth/epic/callback", "OAuth code flow with PKCE; the user types credentials on Epic's page only", "Boundary 2b. The app never sees the credentials. The registered redirect URI must match exactly."],
    ["Server to Epic on FHIR", "HTTPS REST (Bearer token); token request to the OAuth endpoint", "Reads for the selected patient; code exchange with the PKCE verifier", "Boundary 2c. Read-only; synthetic sandbox data. Token kept in an httpOnly cookie, about one hour; no refresh."],
    ["Server to Typesafe Jev", "HTTPS POST /v1/systemone, Bearer key", "Question text; with LLM_STRUCTURING=jev also transcript sentences and two previous turns", "Boundary 3. Third-party processing; terms not yet checked. Responses are typed answers only."],
    ["Browser to microphone", "MediaRecorder, local", "Rehearsal audio, kept in browser memory", "Never sent to HAPI; sent to a transcription service only on an explicit action (none is configured)."],
    ["Server to ICD-API (parked)", "HTTP, local service", "Not wired in this repository", "Would be local-only; unreachable from Vercel."],
    ["Dev tooling to HAPI / Typesafe", "smoke:hapi, e2e:ui (writes), eval --jev (sends text)", "Synthetic data", "Permission-gated; the owner runs the live evaluations."],
  ];

  const qualities = [
    ["Safety", "Human approval; edits revoke approval; server re-checks snapshot, patient and encounter; conservative targets (no FHIR target unless the model's judgement is decisive)."],
    ["Traceability", "Facts carry resource id and field; proposals carry an exact transcript quote and speaker; saved resources keep a proposal-derived identifier."],
    ["Privacy and security", "Server-side keys, strict request schemas, plain-text rendering, no automatic attachment fetching, minimal logging. Epic login uses PKCE, the token stays in an httpOnly cookie and is never logged or put in errors. The application itself has no login or audit trail yet."],
    ["Adaptability", "Three adapter boundaries (EHR, language, transcription) and a source registry; Epic was added as a second source without a new code path, but another EHR may still need its own search variants and compatibility tests."],
    ["Testability", "200 deterministic tests against an in-memory FHIR fake and a scripted Jev; separate live evaluations. No UI or route-handler tests."],
    ["Performance", "Jev calls about 275 to 310 ms each (measured in evaluations); structuring is one call per sentence or clause. No load testing."],
    ["Availability", "Failures are shown, not hidden; the mock fallback is an explicit per-question choice. Capability cache is per server instance."],
  ];

  const decisions = [
    ["D1", "Adapter boundaries (EhrAdapter, ClinicalLanguageAdapter, TranscriptionAdapter)", "Swap EHR, model or speech service without touching UI or workflow logic."],
    ["D2", "Treat Jev as a classifier, not a generator", "Jev returns typed decisions only, so the app keeps extraction, quotes and values in code and uses Jev for judgement. Hallucinated values become impossible by construction."],
    ["D3", "Human approval and staleness before any write", "Clinical content must be reviewed; any edit or context change invalidates earlier approvals."],
    ["D4", "Mock mode by default and visible labelling", "The demo works without keys; mock is never presented as a language model."],
    ["D5", "FHIR built only by the application", "Typed builders and strict schemas; model output never becomes a bundle."],
    ["D6", "Opt-in for sending transcript text to a third party", "Question text and transcript sentences have different privacy weight."],
    ["D7", "Public HAPI with self-created synthetic fixtures", "Reproducible demo data; conditional create prevents duplicates; seeding is user-triggered."],
    ["D8", "ICD-11 suggestions parked", "Nice-to-have for the demo; production would need ICD-10 and Finnish coverage that ICD-11 MMS lacks."],
    ["D9", "Vercel now, employer Azure tenant later", "Nothing in the code is host-specific; endpoints, keys and timeouts are configuration."],
    ["D10", "Source registry; the browser sends only a source id", "Addresses, login type and write permission cannot be chosen by the client. A new source is a registry entry; a read-only source refuses writes on the server."],
    ["D11", "Access token in an httpOnly cookie, no server-side session", "Works on serverless hosts without shared memory or a session secret, and keeps the token away from page scripts. Cost: about an hour of validity, no refresh, a new adapter instance per request."],
    ["D12", "Epic is read-only", "The sandbox is not ours to write to, and the demo-tag rule that protects HAPI does not apply there. A registry test requires that writable sources need no login."],
  ];

  const risks = [
    ["R1", "UI components and route handlers have no unit tests; the browser walkthrough covers one desktop size in mock mode; the Jev UI path was verified manually once.", "Add route tests and a Jev-mode walkthrough with a scripted server."],
    ["R2", "Evaluation sets and thresholds were written and tuned by an AI on the same data; reported accuracy is optimistic.", "Held-out, doctor-written transcripts, run once without tuning."],
    ["R3", "The demo has no authentication. A public URL could spend the Jev quota and write demo data.", "Deployment protection now; proper identity on Azure."],
    ["R4", "Two write paths (clinical save and demo seeding) plus permission-gated scripts.", "Keep the documented invariant; add tests around the seed route."],
    ["R5", "Third-party processing at Typesafe is unreviewed; transcript sentences leave the system when opted in.", "Check terms and region before any non-synthetic use."],
    ["R6", "Structuring latency about 300 ms per unit at concurrency 1; hosting time limits may bite.", "Progress indication, higher concurrency, streaming."],
    ["R7", "Short replies ('Ei.') are not interpreted; clause splitting only at mutta, vaikka and semicolons.", "Question-and-answer pair handling."],
    ["R8", "The public HAPI is shared and wiped; non-demo patients can be read (read-only).", "Re-seed on demand; consider a private FHIR server."],
    ["R9", "No CI; checks run manually.", "Propose CI as a separate change."],
    ["R10", "No audit trail or structured logging; one console.error only.", "Required before any real use."],
    ["R11", "Per-instance caches on serverless hosts give inconsistent status and skipped parameter checks until the first capability check. Epic adapters are built per request and never run the parameter check.", "Check capabilities on first use per instance or cache externally."],
    ["R12", "Epic reads are verified by hand for a few sandbox patients: login, patient search, encounters and questions on blood pressure, labs, allergies, medications, conditions, imaging reports and documents work. The overview question is untried, and nothing can be tested automatically because the login needs a browser.", "Try the overview question by hand; add Epic-specific search variants where Epic rejects ours."],
    ["R13", "Epic access tokens last about an hour and are not refreshed. Every new hostname (preview deployments, a custom domain, the Azure tenant) needs its callback URI registered at Epic first, and Epic compares it literally.", "Register each origin before use; consider a refresh token only if the one-hour limit gets in the way."],
    ["R14", "Epic's patient search finds by name only together with a birth date; the exact accepted combinations are not documented in what was read.", "Test more combinations; prefer identifier lookup or launch context for real use."],
  ];

  const questions = [
    "Should adjacent separate systolic and diastolic Observations ever be shown or stored as one reading? (A doctor will decide.)",
    "Which code system is needed first in a real setting (ICD-10 is expected), and who maintains the Finnish term mapping?",
    "What does the employer's Azure tenant require: region, data-processing terms for Typesafe, identity (Entra ID?), network rules and secrets storage?",
    "Which real EHR and FHIR profile are the target, and what authentication and write permissions apply? Epic's sandbox is read-only here; would clinician apps launch from inside the EHR (EHR launch) instead of a standalone login?",
    "Retention and handling of audio and transcripts, and who may see Jev responses.",
    "Which concurrency does the Typesafe plan allow, and what is the acceptable wait for structuring?",
  ];

  const relRows = RELATIONS.map((rel) => `<tr><td>${h(nameOf(rel.source))}</td><td>${h(rel.type)}${rel.access ? ` (${h(rel.access)})` : ""}</td><td>${h(nameOf(rel.target))}</td></tr>`).join("");

  const css = `
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
body { font-family: 'Noto Sans','DejaVu Sans',Arial,sans-serif; font-size: 9.6pt; line-height: 1.42; color: #1b1b1b; }
h1 { font-size: 24pt; margin: 0 0 4px; } h2 { font-size: 15pt; margin: 22px 0 6px; border-bottom: 2px solid #1f4e79; padding-bottom: 3px; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 14px 0 4px; break-after: avoid; } p { margin: 5px 0 7px; } ul, ol { margin: 4px 0 8px 18px; padding: 0; } li { margin: 2px 0; }
.cover { padding-top: 40mm; } .cover .sub { font-size: 13pt; color: #333; margin-bottom: 18px; }
.box { border: 1px solid #b9c7d6; background: #f3f7fb; padding: 8px 12px; border-radius: 6px; margin: 10px 0; break-inside: avoid; }
.warn { border-color: #e0b94a; background: #fff8e1; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 8.4pt; } th, td { border: 1px solid #c8c8c8; padding: 3px 6px; vertical-align: top; text-align: left; }
th { background: #e9eef4; } thead { display: table-header-group; } thead tr { break-after: avoid; } tr { break-inside: avoid; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 7.6pt; background: #f0f0f0; padding: 0 2px; border-radius: 2px; } .src { margin-top: 2px; line-height: 1.6; }
figure { margin: 10px 0 14px; break-inside: avoid; } .fig svg { width: 100%; height: auto; border: 1px solid #d8d8d8; } figcaption { font-size: 8.6pt; color: #333; margin-top: 3px; }
.st { font-size: 7.4pt; padding: 0 5px; border-radius: 8px; border: 1px solid #999; white-space: nowrap; background: #f4f4f4; }
.st-planned, .st-parked, .st-not-configured { border-style: dashed; background: #fff3e0; } .st-implemented { background: #e6f4ea; border-color: #7fb88b; } .st-opt-in { background: #e8eefc; border-color: #8aa2e0; }
.pb { break-before: page; } .small { font-size: 8.4pt; color: #444; }
`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>super_ambient: preliminary architecture description</title><style>${css}</style></head><body>

<section class="cover">
<h1>super_ambient</h1>
<div class="sub">Preliminary architecture description (ArchiMate 3.1)</div>
<div class="box warn"><b>Status: preliminary, generated from the code, not reviewed.</b><br>Derived from commit <code>${h(p.commit)}</code>${p.dirty ? " plus uncommitted changes" : ""} on ${h(p.date)}. It describes what the repository contains, not what a deployment guarantees, and it is not a security or quality audit.</div>
<table><tbody>
<tr><th>Model</th><td>${ELEMENTS.length} elements, ${RELATIONS.length} relationships, ${VIEWS.length} views (motivation ${layerCount("Motivation")}, business ${layerCount("Business")}, application ${layerCount("Application")}, technology ${layerCount("Technology")}, implementation and migration ${layerCount("Implementation and migration")})</td></tr>
<tr><th>Machine-readable model</th><td><code>${BASENAME}.xml</code> (ArchiMate Open Group Exchange Format; opens in Archi via File, Import, Open Exchange XML Model)</td></tr>
<tr><th>Schema validation</th><td>${h(xsdResult)}</td></tr>
<tr><th>Archi import</th><td>NOT CHECKED. Archi was not available when this was generated. Relationship pairs were restricted to a conservative subset of the ArchiMate 3.1 relationship table.</td></tr>
<tr><th>Source of truth</th><td><code>scripts/architecture/model.ts</code>; regenerate with <code>bun run architecture:build</code></td></tr>
</tbody></table>
</section>

<section class="pb">
<h2>1 Purpose, scope and method</h2>
<p>super_ambient is a local-first demo of a patient workspace on a public FHIR R4 test server. A clinician selects a <i>synthetic</i> patient and encounter, asks questions in Finnish and gets source-grounded answers, and turns a rehearsal conversation into a visit-note draft and structured proposals that are reviewed, approved and saved back as FHIR resources. Jev, a classification model from Typesafe, is used inside strict boundaries.</p>
<p>This document gives a first architecture view for discussion and for planning the move to an employer's Azure tenant. It was written from the repository: file layout, module boundaries, configuration defaults, tests and the decisions recorded in the project instructions. Every application component lists the files it is derived from, and the generator fails if a listed file does not exist.</p>
<ul>
<li><b>Status tags</b> separate implemented parts from <i>opt-in</i>, <i>not configured</i>, <i>parked</i>, <i>planned</i> and <i>external</i> ones. Planned things are never drawn as implemented.</li>
<li><b>Notation.</b> The figures are simplified renderings with layer colours and a type tag; standard ArchiMate notation is available by opening the XML in a modelling tool. Legend:</li>
</ul>
<figure><div class="fig">${LEGEND_SVG}</div></figure>
<p class="small">Relationship counts: ${(["Composition", "Assignment", "Realization", "Serving", "Access", "Influence", "Triggering", "Flow", "Association"] as RelType[]).map((t) => `${t} ${relCount(t)}`).join(", ")}.</p>
</section>

<section>
<h2>2 Motivation</h2>
<p>The driver is the documentation workload and patient data scattered across resources. The design is shaped less by features than by a handful of principles: nothing is saved without human approval, every answer and proposal is traceable to a source, the application and not a model builds FHIR, and secrets stay on the server. Two constraints bound the demo: only synthetic data on a public, unauthenticated server, and opt-in before transcript text goes to a third party.</p>
${fig(V["v-motivation"], "1")}
${elementTable(["Principle", "Requirement", "Constraint"], true)}
</section>

<section class="pb">
<h2>3 Business layer</h2>
<p>One role, four processes. <i>Ask about patient data</i> and <i>Record and document a consultation</i> are independent entry points; recording leads to <i>Review and approve proposals</i> and then <i>Save approved content to the EHR</i>. The application services and the recording view support the processes; the business objects are the visit note and the patient record.</p>
${fig(V["v-business"], "2")}
</section>

<section>
<h2>4 Application layer</h2>
<h3>4.1 Structure</h3>
<p>The application is a single Next.js project. The browser holds the React client; all FHIR access, model calls and secrets live in the server-side modules behind one internal REST interface. Business logic is separated from external connections by three adapter boundaries (EHR, language model, transcription), so the question-answering and structuring logic never touch HTTP or keys directly.</p>
${fig(V["v-app-structure"], "3")}
<h3>4.2 Cooperation</h3>
<p>A question flows from the UI through the API layer to question answering, which asks the language adapter to interpret it (Jev or the keyword mock), runs allow-listed read searches through the EHR adapter, extracts facts and composes the answer in code. Structuring takes a transcript, optionally classifies sentences through Jev, and hands proposals to the review engine. Saving runs only through the save service, which re-checks approvals, patient and encounter before one transaction.</p>
${fig(V["v-app-coop"], "4")}
<h3 class="pb">4.3 Information</h3>
<p>Information objects are short-lived application data (information need, facts, transcript, proposals, note draft, preview bundle). The only persistent data are the FHIR resources on the EHR server. A new Observation or Condition never carries a measurement time that was not stated, and the saved bundle carries per-resource identifiers derived from the previewed snapshot, so repeating a save creates no duplicates.</p>
${fig(V["v-information"], "5")}
<h3 class="pb">4.4 Components, interfaces and services</h3>
${elementTable(["ApplicationComponent", "ApplicationInterface", "ApplicationService"], true)}
<h3>4.5 Data objects</h3>
${elementTable(["DataObject"], true)}
<h3>4.6 Integration points and trust boundaries</h3>
<table><thead><tr><th>Connection</th><th>Protocol</th><th>Data</th><th>Notes</th></tr></thead><tbody>${integrations.map((r) => `<tr>${r.map((c) => `<td>${h(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
</section>

<section class="pb">
<h2>5 Technology and deployment</h2>
<p>The same build runs on a developer workstation (Bun), on Vercel today, and is intended for an Azure tenant later. The ICD-API service is a local systemd unit outside this repository and is unreachable from Vercel, which is why ICD-11 suggestions are parked. Configuration is environment-driven; defaults keep every external service off.</p>
${fig(V["v-technology"], "6")}
<h3>5.1 Configuration</h3>
<table><thead><tr><th>Setting</th><th>Default</th><th>Meaning</th></tr></thead><tbody>${config.map((r) => `<tr><td><code>${h(r[0])}</code></td><td>${h(r[1])}</td><td>${h(r[2])}</td></tr>`).join("")}</tbody></table>
<h3 class="pb">5.2 Technology elements</h3>
${elementTable(["Node", "SystemSoftware", "Artifact", "TechnologyService", "CommunicationNetwork"], false)}
</section>

<section>
<h2>6 Cross-cutting concerns</h2>
<h3>6.1 Quality attributes</h3>
<table><thead><tr><th>Attribute</th><th>How it is addressed today</th></tr></thead><tbody>${qualities.map((r) => `<tr><td>${h(r[0])}</td><td>${h(r[1])}</td></tr>`).join("")}</tbody></table>
<h3>6.2 Key decisions</h3>
<table><thead><tr><th>#</th><th>Decision</th><th>Rationale</th></tr></thead><tbody>${decisions.map((r) => `<tr><td>${h(r[0])}</td><td>${h(r[1])}</td><td>${h(r[2])}</td></tr>`).join("")}</tbody></table>
</section>

<section class="pb">
<h2>7 Roadmap, risks and open questions</h2>
${fig(V["v-roadmap"], "7")}
${elementTable(["WorkPackage", "Plateau"], true)}
<h3>7.1 Risks and technical debt</h3>
<table><thead><tr><th>#</th><th>Observation</th><th>Suggested response</th></tr></thead><tbody>${risks.map((r) => `<tr><td>${h(r[0])}</td><td>${h(r[1])}</td><td>${h(r[2])}</td></tr>`).join("")}</tbody></table>
<h3>7.2 Open questions</h3>
<ol>${questions.map((q) => `<li>${h(q)}</li>`).join("")}</ol>
</section>

<section class="pb">
<h2>Appendix A: Motivation and business elements</h2>
${elementTable(["Stakeholder", "Driver", "Goal", "BusinessActor", "BusinessRole", "BusinessProcess", "BusinessService", "BusinessObject"], false)}
</section>

<section class="pb">
<h2>Appendix B: All relationships</h2>
<p class="small">Complete list, including the relationships that are not drawn in a figure. Composition between the Web UI, the application server and their parts is shown by nesting in Figure 3.</p>
<table><thead><tr><th>Source</th><th>Relationship</th><th>Target</th></tr></thead><tbody>${relRows}</tbody></table>
</section>

<section>
<h2>Appendix C: Using and regenerating the model</h2>
<ul>
<li><b>Open in Archi:</b> File, Import, Open Exchange XML Model, then choose <code>${BASENAME}.xml</code>. Other tools that read the Open Group exchange format can import the same file. The views come with positions; elements carry <code>Status</code> and <code>Source</code> properties.</li>
<li><b>Regenerate:</b> edit <code>scripts/architecture/model.ts</code> and run <code>bun run architecture:build</code>. Validation fails on unknown elements, relationship pairs outside the allowed subset, missing source files, undrawable edges and elements that appear in no view.</li>
<li><b>Schema check (optional):</b> set <code>ARCHIMATE_XSD_DIR</code> to a folder with the Open Group ArchiMate 3.1 XSD files and <code>xml.xsd</code> to validate with <code>xmllint</code> during generation.</li>
<li><b>Known limits:</b> relationship validity was checked against a conservative subset, not the complete ArchiMate relationship table; the file has not been opened in a modelling tool; the figures are simplified renderings.</li>
</ul>
</section>
</body></html>`;
}

/**
 * Firefox ei tulosta sivunumeroita (ei footer-mallia eikä @page-marginaalilaatikoita), joten ne leimataan
 * jälkikäteen Ghostscriptillä. Jos gs puuttuu tai jokin menee pieleen, jätetään alkuperäinen PDF ennalleen.
 */
function stampPageNumbers(pdf: string): string {
  const tmp = `${pdf}.stamped`;
  try {
    const total = Number(execFileSync("gs", ["-q", "-dNODISPLAY", "-dNOSAFER", "-c", `(${pdf}) (r) file runpdfbegin pdfpagecount = quit`], { stdio: "pipe" }).toString().trim());
    if (!Number.isInteger(total) || total < 1) throw new Error("sivumäärää ei saatu");
    const ps =
      `/TOTAL ${total} def << /EndPage { /r exch def /c exch def r 2 ne { gsave /Helvetica findfont 8 scalefont setfont 0.35 setgray 40 22 moveto ` +
      `(super_ambient preliminary architecture - page ) show c 1 add 8 string cvs show ( / ) show TOTAL 8 string cvs show grestore true } { false } ifelse } >> setpagedevice`;
    execFileSync("gs", ["-q", "-dBATCH", "-dNOPAUSE", "-dSAFER", "-sDEVICE=pdfwrite", `-sOutputFile=${tmp}`, "-c", ps, "-f", pdf], { stdio: "pipe" });
    const after = Number(execFileSync("gs", ["-q", "-dNODISPLAY", "-dNOSAFER", "-c", `(${tmp}) (r) file runpdfbegin pdfpagecount = quit`], { stdio: "pipe" }).toString().trim());
    if (after !== total) throw new Error(`sivumäärä muuttui (${total} → ${after})`);
    fs.renameSync(tmp, pdf);
    return `page numbers stamped, ${total} pages`;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return `page numbers NOT stamped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Ajo
// ---------------------------------------------------------------------------------------------

async function main() {
  const noPdf = process.argv.includes("--no-pdf");
  validateModel();
  const prov = provenance();
  fs.mkdirSync(path.join(OUT, "views"), { recursive: true });

  const layouts = new Map<string, Layout>();
  const svgs = new Map<string, string>();
  const crossings: string[] = [];
  for (const v of VIEWS) {
    const lay = layoutView(v);
    crossings.push(...findCrossings(v, lay));
    layouts.set(v.id, lay);
    const svg = viewSvg(v, lay);
    svgs.set(v.id, svg);
    fs.writeFileSync(path.join(OUT, "views", `${v.id}.svg`), svg);
  }

  if (crossings.length) throw new Error(`Näkymän viiva kulkee muun elementin läpi:\n - ${crossings.join("\n - ")}`);

  const xmlPath = path.join(OUT, `${BASENAME}.xml`);
  fs.writeFileSync(xmlPath, buildXml(prov, layouts));
  const xsd = validateXsd(xmlPath);
  console.log(`XML: ${path.relative(ROOT, xmlPath)} (${ELEMENTS.length} elements, ${RELATIONS.length} relationships, ${VIEWS.length} views); schema validation: ${xsd}`);

  const html = buildHtml(prov, svgs, xsd);
  fs.writeFileSync(path.join(OUT, `${BASENAME}.html`), html);
  if (noPdf) {
    console.log("PDF skipped (--no-pdf); HTML written.");
    return;
  }
  const browser = await puppeteer.launch({ browser: "firefox", executablePath: process.env.FIREFOX_PATH ?? "/usr/bin/firefox", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({
      path: path.join(OUT, `${BASENAME}.pdf`),
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
    });
  } finally {
    await browser.close();
  }
  fs.rmSync(path.join(OUT, `${BASENAME}.html`), { force: true });
  const pdfPath = path.join(OUT, `${BASENAME}.pdf`);
  const stamped = stampPageNumbers(pdfPath);
  console.log(`PDF: ${path.relative(ROOT, pdfPath)} (${stamped})`);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
