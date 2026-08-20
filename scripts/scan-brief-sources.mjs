import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const archiveDir = path.resolve(scriptDir, "..");
const workspaceDir = path.resolve(archiveDir, "..", "..");
const registry = JSON.parse(fs.readFileSync(path.join(archiveDir, "config", "brief-sources.json"), "utf8"));
const date = process.argv.find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || new Date().toISOString().slice(0, 10);
const limitArg = process.argv.find(arg => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const includeWeekly = process.argv.includes("--include-weekly") || new Date(`${date}T00:00:00+08:00`).getDay() === 6;
const selected = registry.sources.filter(source => source.priority === "daily" || includeWeekly).slice(0, limit);
const aiPattern = /\b(ai|agent|agentic|llm|language model|benchmark|eval|reasoning|inference|coding|mcp|openai|anthropic|claude|gpt|gemini)\b/i;

function decode(input) {
  return String(input || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function first(block, tags) {
  for (const tag of tags) {
    const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) return decode(match[1]);
  }
  return "";
}

function summarizeFeed(body) {
  const blocks = body.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) || [];
  return {
    itemCount: blocks.length,
    items: blocks.slice(0, 10).map(block => ({
      title: first(block, ["title"]),
      publishedAt: first(block, ["pubDate", "published", "updated"]),
      url: (block.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || first(block, ["link", "guid", "id"]),
    })).filter(item => item.title),
  };
}

async function fetchText(url, timeoutMs = 16000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Rhythm-AI-Agent-Brief/1.0 (+source-audit)" },
    });
    const body = (await response.text()).slice(0, 2_000_000);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function summarizeHackerNews(body) {
  const ids = JSON.parse(body).slice(0, 40);
  const stories = await Promise.all(ids.map(async id => {
    try {
      const { response, body: itemBody } = await fetchText(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 8000);
      return response.ok ? JSON.parse(itemBody) : null;
    } catch {
      return null;
    }
  }));
  const relevant = stories.filter(item => item && aiPattern.test(`${item.title || ""} ${item.text || ""}`));
  return {
    itemCount: ids.length,
    items: relevant.slice(0, 12).map(item => ({
      id: item.id,
      title: decode(item.title),
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      discussionUrl: `https://news.ycombinator.com/item?id=${item.id}`,
      publishedAt: new Date(item.time * 1000).toISOString(),
      score: item.score || 0,
      comments: item.descendants || 0,
    })),
  };
}

function summarizeJson(body) {
  const value = JSON.parse(body);
  const items = Array.isArray(value) ? value : value.items || value.results || [];
  return {
    itemCount: items.length,
    items: items.slice(0, 10).map(item => ({
      title: item.title || item.name || item.tag_name || item.commit?.message?.split("\n")[0] || item.full_name || "",
      url: item.html_url || item.url || item.paper?.url || "",
      publishedAt: item.published_at || item.created_at || item.updated_at || item.commit?.author?.date || "",
    })).filter(item => item.title),
  };
}

async function scan(source) {
  const checkedAt = new Date().toISOString();
  try {
    const { response, body } = await fetchText(source.url);
    let summary = { itemCount: 0, items: [] };
    if (response.ok && source.extractor === "hn-list") summary = await summarizeHackerNews(body);
    else if (response.ok && ["rss", "atom"].includes(source.extractor)) summary = summarizeFeed(body);
    else if (response.ok && source.extractor === "json") summary = summarizeJson(body);
    else if (response.ok) {
      summary.items = [{ title: decode((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) }].filter(item => item.title);
      summary.itemCount = summary.items.length;
    }
    return {
      sourceId: source.id,
      family: source.family,
      authority: source.authority,
      checkedAt,
      status: response.ok ? "reachable" : "http-error",
      httpStatus: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type") || "",
      lastModified: response.headers.get("last-modified") || "",
      bytesSampled: Buffer.byteLength(body),
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      ...summary,
    };
  } catch (error) {
    return {
      sourceId: source.id,
      family: source.family,
      authority: source.authority,
      checkedAt,
      status: "inaccessible",
      error: error instanceof Error ? error.message : String(error),
      itemCount: 0,
      items: [],
    };
  }
}

const results = [];
for (let index = 0; index < selected.length; index += 6) {
  results.push(...await Promise.all(selected.slice(index, index + 6).map(scan)));
}

const outputDir = path.join(workspaceDir, "tmp");
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, `brief-source-scan-${date}.json`);
const payload = {
  version: 1,
  date,
  generatedAt: new Date().toISOString(),
  registryVersion: registry.version,
  requestedSources: selected.length,
  reachableSources: results.filter(item => item.status === "reachable").length,
  families: [...new Set(results.map(item => item.family))],
  results,
};
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, requested: payload.requestedSources, reachable: payload.reachableSources, families: payload.families.length }));
