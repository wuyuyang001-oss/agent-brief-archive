import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const archiveDir = path.resolve(scriptDir, "..");
const registry = JSON.parse(fs.readFileSync(path.join(archiveDir, "config", "brief-sources.json"), "utf8"));
const [htmlArg, auditArg] = process.argv.slice(2);
if (!htmlArg || !auditArg) throw new Error("Usage: node scripts/validate-source-coverage.mjs BRIEF.html BRIEF-sources.json");

const htmlPath = path.resolve(htmlArg);
const auditPath = path.resolve(auditArg);
const html = fs.readFileSync(htmlPath, "utf8");
const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
const errors = [];
const policy = registry.policy;
const sourceMap = new Map(registry.sources.map(source => [source.id, source]));
const allowedStatuses = new Set(["selected", "reviewed", "no-update", "inaccessible"]);
const allowedFactTypes = new Set(["verified-fact", "author-claim", "editorial-inference", "community-signal", "podcast-view"]);
const allowedConfidence = new Set(["high", "medium", "low"]);
const dateFromFile = path.basename(htmlPath).match(/\d{4}-\d{2}-\d{2}/)?.[0];

if (audit.version !== 1) errors.push("source audit version must be 1");
if (!dateFromFile || audit.date !== dateFromFile) errors.push("audit date must match brief filename");
if (!audit.generatedAt || !audit.cutoffAt) errors.push("generatedAt and cutoffAt are required");
if (!Array.isArray(audit.scans) || !audit.scans.length) errors.push("scans must be a non-empty array");
if (!Array.isArray(audit.signals) || !audit.signals.length) errors.push("signals must be a non-empty array");
if (!html.includes("多源信号雷达")) errors.push("HTML is missing 多源信号雷达");
if (!html.includes("来源覆盖与证据链")) errors.push("HTML is missing 来源覆盖与证据链");

const scans = Array.isArray(audit.scans) ? audit.scans : [];
const uniqueScans = new Map();
for (const scan of scans) {
  if (!sourceMap.has(scan.sourceId)) errors.push(`unknown sourceId: ${scan.sourceId}`);
  if (uniqueScans.has(scan.sourceId)) errors.push(`duplicate source scan: ${scan.sourceId}`);
  uniqueScans.set(scan.sourceId, scan);
  if (!allowedStatuses.has(scan.status)) errors.push(`invalid status for ${scan.sourceId}`);
  if (!scan.checkedAt) errors.push(`missing checkedAt for ${scan.sourceId}`);
  if (!Number.isInteger(scan.itemsReviewed) || scan.itemsReviewed < 0) errors.push(`invalid itemsReviewed for ${scan.sourceId}`);
  if (!Number.isInteger(scan.selectedItems) || scan.selectedItems < 0) errors.push(`invalid selectedItems for ${scan.sourceId}`);
  if (scan.status === "inaccessible" && !scan.limitation) errors.push(`inaccessible source lacks limitation: ${scan.sourceId}`);
}

const scannedSources = [...uniqueScans.keys()].map(id => sourceMap.get(id)).filter(Boolean);
const reachableSources = scans.filter(scan => scan.status !== "inaccessible").length;
const families = new Set(scannedSources.map(source => source.family));
const domains = new Set(scannedSources.map(source => new URL(source.url).hostname.replace(/^www\./, "")));
const podcastScans = scannedSources.filter(source => source.family === "podcast").length;
const communityScans = scannedSources.filter(source => source.family === "community").length;
const exception = String(audit.editorialException || "").trim();
const scanFloor = exception ? 18 : policy.minimumScannedSources;
const signalFloor = exception ? policy.hardMinimumPublishedSignals : policy.minimumPublishedSignals;

if (scannedSources.length < scanFloor) errors.push(`scanned ${scannedSources.length} sources; need ${scanFloor}`);
if (reachableSources < Math.min(policy.minimumReachableSources, scanFloor)) errors.push(`only ${reachableSources} sources were reachable/reviewed`);
if (families.size < policy.minimumFamilies) errors.push(`covered ${families.size} source families; need ${policy.minimumFamilies}`);
if (domains.size < Math.min(policy.minimumDistinctDomains, scanFloor)) errors.push(`covered ${domains.size} distinct domains`);
if (podcastScans < 4) errors.push("scan at least four podcast feeds");
if (communityScans < 3) errors.push("scan at least three community sources");
if (!Number.isInteger(audit.candidatePoolSize) || audit.candidatePoolSize < (exception ? 12 : policy.minimumCandidateItems)) {
  errors.push(`candidatePoolSize is below the required floor${exception ? " with exception" : ""}`);
}

const signals = Array.isArray(audit.signals) ? audit.signals : [];
if (signals.length < signalFloor) errors.push(`published ${signals.length} signals; need ${signalFloor}`);
let primaryBacked = 0;
for (const signal of signals) {
  if (!signal.id || !signal.title) errors.push("every signal needs id and title");
  if (!allowedFactTypes.has(signal.factType)) errors.push(`invalid factType for ${signal.id || "unknown signal"}`);
  if (!allowedConfidence.has(signal.confidence)) errors.push(`invalid confidence for ${signal.id || "unknown signal"}`);
  for (const field of ["difference", "productImpact", "action", "limitations"]) {
    if (!String(signal[field] || "").trim()) errors.push(`${signal.id || "signal"} is missing ${field}`);
  }
  if (!Array.isArray(signal.sourceUrls) || !signal.sourceUrls.length) errors.push(`${signal.id || "signal"} has no sourceUrls`);
  const primaryUrls = Array.isArray(signal.primarySourceUrls) ? signal.primarySourceUrls : [];
  if (primaryUrls.length) primaryBacked += 1;
  if (["verified-fact", "author-claim"].includes(signal.factType) && !primaryUrls.length) {
    errors.push(`${signal.id || "signal"} requires a primary source`);
  }
  if (signal.factType === "community-signal" && (!signal.originalUrl || !primaryUrls.length)) {
    errors.push(`${signal.id || "signal"} must link both community discussion and original primary material`);
  }
  if (signal.factType === "podcast-view") {
    for (const field of ["speaker", "episodeTitle", "episodeUrl", "publishedAt", "verificationMode", "attribution"]) {
      if (!String(signal[field] || "").trim()) errors.push(`${signal.id || "podcast signal"} is missing ${field}`);
    }
    if (!["transcript", "official-show-notes", "audio-timestamp"].includes(signal.verificationMode)) {
      errors.push(`${signal.id || "podcast signal"} has invalid verificationMode`);
    }
    if (signal.verificationMode === "audio-timestamp" && (!Array.isArray(signal.timestamps) || !signal.timestamps.length)) {
      errors.push(`${signal.id || "podcast signal"} needs timestamps`);
    }
  }
  for (const url of signal.sourceUrls || []) {
    if (!html.includes(url.replace(/&/g, "&amp;")) && !html.includes(url)) errors.push(`${signal.id || "signal"} source is not linked in HTML: ${url}`);
  }
}
if (primaryBacked < Math.min(policy.minimumPrimaryBackedSignals, signals.length)) {
  errors.push(`only ${primaryBacked} signals are backed by primary sources`);
}
if (exception && exception.length < 30) errors.push("editorialException must explain the low-signal or access constraint in detail");

if (errors.length) throw new Error(`${path.basename(htmlPath)} source coverage failed:\n- ${errors.join("\n- ")}`);
console.log(JSON.stringify({
  file: htmlPath,
  audit: auditPath,
  scannedSources: scannedSources.length,
  reachableSources,
  families: families.size,
  domains: domains.size,
  candidatePoolSize: audit.candidatePoolSize,
  signals: signals.length,
  primaryBacked,
  mode: "static-no-browser",
}));
