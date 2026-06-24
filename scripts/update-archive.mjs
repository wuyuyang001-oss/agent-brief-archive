import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const archiveDir = path.resolve(scriptDir, "..");
const workspaceDir = path.resolve(archiveDir, "..", "..");
const briefsDir = path.join(archiveDir, "briefs");
const overviewsDir = path.join(archiveDir, "overviews");
const dataDir = path.join(archiveDir, "data");

const now = new Date();
const generatedAt = now.toISOString();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function decodeEntities(input) {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(input) {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const escapeXml = escapeHtml;

function truncate(input, max = 130) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function dateFromFile(fileName) {
  const match = fileName.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function weekdayName(dateText) {
  const date = new Date(`${dateText}T00:00:00+08:00`);
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
}

function firstMatch(html, regex) {
  const match = html.match(regex);
  return match ? stripTags(match[1]) : "";
}

function sectionAfterH2(html, headingText) {
  const headings = [...html.matchAll(/<h2[^>]*>[\s\S]*?<\/h2>/gi)];
  const heading = headings.find(match => stripTags(match[0]).includes(headingText));
  if (!heading) return html;
  const start = heading.index + heading[0].length;
  const next = headings.find(match => match.index > heading.index);
  const end = next ? next.index : html.length;
  return html.slice(start, end);
}

function numberFromText(input) {
  const match = String(input).match(/([+-]?\d[\d,]*(?:\.\d+)?)(?:\s*(k|K|万))?/);
  if (!match) return null;
  let value = Number(match[1].replace(/,/g, ""));
  if (match[2] === "k" || match[2] === "K") value *= 1000;
  if (match[2] === "万") value *= 10000;
  return Number.isFinite(value) ? value : null;
}

function extractGithubRows(html) {
  const rows = [];
  const tableRows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of tableRows) {
    const repoMatch = row.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
    if (!repoMatch) continue;
    const repo = repoMatch[1].replace(/["'<>\s].*$/, "");
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => stripTags(match[1]));
    const repoIndex = Math.max(0, cells.findIndex(cell => cell.includes(repo) || cell.toLowerCase().includes(repo.split("/")[1].toLowerCase())));
    const numericCells = cells.slice(repoIndex + 1).map(numberFromText).filter(value => value !== null && value > 0);
    const text = stripTags(row);
    const fallbackNumbers = [...text.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?(?:\s*(?:k|K|万))?/g)]
      .map(match => numberFromText(match[0]))
      .filter(value => value !== null && value > 0 && value < 1_000_000);
    rows.push({
      repo,
      label: cells[repoIndex] ? truncate(cells[repoIndex].replace(repo, "").trim() || repo, 42) : repo,
      value: numericCells[numericCells.length - 1] || fallbackNumbers[fallbackNumbers.length - 1] || 1,
      text: truncate(text, 120),
    });
  }
  return rows.filter((row, index, array) => array.findIndex(item => item.repo === row.repo) === index).slice(0, 8);
}

function extractPaperTitle(html, todaySection) {
  const h3Title = firstMatch(todaySection, /<h3[^>]*>([\s\S]*?)<\/h3>/i);
  const generic = /^(English overview|对应中文翻译|中文对应翻译|核心|方法|创新|结论|局限|论文全部图表)/i;
  if (h3Title && !generic.test(h3Title)) return h3Title;

  const h2Candidates = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map(match => stripTags(match[1]))
    .filter(text => text && !/(今日论文|GitHub|OpenAI|Anthropic|来源|方法|周报|过去三天|高 Star|官方动态|来源与方法)/i.test(text));
  return h2Candidates[0] || h3Title || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || "AI / Agent 晨间简报";
}

function extractBriefMetadata(fileName, html) {
  const date = dateFromFile(fileName);
  const isTest = fileName.includes("test");
  const todaySection = sectionAfterH2(html, "今日论文");
  const paperTitle = extractPaperTitle(html, todaySection);
  const reason = firstMatch(todaySection, /<p[^>]*class="[^"]*(?:note|callout)[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    || firstMatch(html, /<p[^>]*>([\s\S]*?)<\/p>/i)
    || "当日 AI/Agent 研究与工程动态摘要。";
  const githubRows = extractGithubRows(html);
  const githubRepos = [...new Set([...(html.matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g))].map(match => match[1].replace(/["'<>\s].*$/, "")))];
  const figureCount = (html.match(/<figure[\s>]/gi) || []).length;
  const tableCount = (html.match(/<table[\s>]/gi) || []).length;
  const linkCount = (html.match(/<a\s+[^>]*href=/gi) || []).length;
  const hasWeekly = /<h2[^>]*>[\s\S]*(本周周报|周报总结|Weekly)[\s\S]*<\/h2>/i.test(html);
  const officialNoUpdate = /未发现新发布内容/.test(stripTags(html));
  const officialLinks = (html.match(/https:\/\/(?:openai\.com|www\.anthropic\.com|anthropic\.com)[^"'<\s]*/gi) || []).length;
  const type = isTest ? "test" : "formal";
  const tags = [
    date,
    paperTitle,
    "AI Agent benchmark GitHub OpenAI Anthropic",
    hasWeekly ? "weekly 周报" : "",
    isTest ? "test 测试稿" : "formal 正式简报",
  ].join(" ");

  return {
    fileName,
    date,
    weekday: date ? weekdayName(date) : "",
    type,
    hasWeekly,
    title: paperTitle,
    summary: truncate(reason, 155),
    source: `briefs/${fileName}`,
    overview: `overviews/${fileName.replace(/\.html$/i, ".svg")}`,
    githubRows,
    githubRepoCount: githubRepos.length,
    figureCount,
    tableCount,
    linkCount,
    officialStatus: officialNoUpdate ? "未发现新发布内容" : `${officialLinks || "若干"} 条官方链接/动态`,
    tags,
  };
}

function wrapLines(text, maxUnits, maxLines) {
  const chars = Array.from(String(text || "").replace(/\s+/g, " ").trim());
  const lines = [];
  let current = "";
  let units = 0;
  for (const char of chars) {
    const unit = /[\u4e00-\u9fff]/.test(char) ? 2 : 1;
    if (units + unit > maxUnits && current) {
      lines.push(current.trim());
      current = "";
      units = 0;
      if (lines.length === maxLines) break;
    }
    current += char;
    units += unit;
  }
  if (current && lines.length < maxLines) lines.push(current.trim());
  if (lines.length === maxLines && chars.length > lines.join("").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/…$/, "")}…`;
  }
  return lines;
}

function svgTextBlock(text, x, y, options = {}) {
  const {
    maxUnits = 56,
    maxLines = 3,
    lineHeight = 28,
    size = 22,
    weight = 500,
    fill = "#243447",
  } = options;
  return wrapLines(text, maxUnits, maxLines).map((line, index) =>
    `<text x="${x}" y="${y + index * lineHeight}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`,
  ).join("\n");
}

function generateOverviewSvg(brief) {
  const bars = (brief.githubRows.length ? brief.githubRows : [
    { repo: "GitHub candidates", value: brief.githubRepoCount || 1 },
    { repo: "Figures", value: brief.figureCount || 1 },
    { repo: "Tables", value: brief.tableCount || 1 },
  ]).slice(0, 5);
  const maxValue = Math.max(...bars.map(item => item.value), 1);
  const barMarkup = bars.map((item, index) => {
    const y = 438 + index * 38;
    const width = Math.max(34, Math.round((item.value / maxValue) * 330));
    const label = truncate(item.repo, 34);
    const valueLabel = item.value >= 1000 ? Math.round(item.value).toLocaleString("en-US") : String(Math.round(item.value));
    return `
      <text x="690" y="${y + 17}" font-size="17" font-weight="650" fill="#233246">${escapeXml(label)}</text>
      <rect x="910" y="${y}" width="330" height="18" rx="9" fill="#e8eef6"/>
      <rect x="910" y="${y}" width="${width}" height="18" rx="9" fill="url(#barGradient)"/>
      <text x="${925 + width}" y="${y + 15}" font-size="13" font-weight="700" fill="#0b5f91">${escapeXml(valueLabel)}</text>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="${escapeXml(brief.date)} AI Agent 晨间简报概览">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a67a3"/>
      <stop offset="52%" stop-color="#4f46e5"/>
      <stop offset="100%" stop-color="#087f5b"/>
    </linearGradient>
    <linearGradient id="barGradient" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#0a67a3"/>
      <stop offset="100%" stop-color="#21a67a"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#102030" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="1280" height="720" fill="#f7faff"/>
  <circle cx="1088" cy="72" r="230" fill="#dfefff" opacity="0.78"/>
  <circle cx="82" cy="620" r="260" fill="#e7f8ef" opacity="0.72"/>
  <path d="M0 124 C220 74 360 176 552 124 C790 60 980 96 1280 34 L1280 0 L0 0 Z" fill="#eef6ff"/>
  <rect x="42" y="42" width="1196" height="636" rx="34" fill="white" filter="url(#shadow)"/>
  <rect x="42" y="42" width="1196" height="636" rx="34" fill="none" stroke="#d8e5f2"/>

  <text x="82" y="96" font-size="18" font-weight="800" letter-spacing="3" fill="#0a67a3">AI / AGENT MORNING BRIEF</text>
  <text x="82" y="148" font-size="54" font-weight="850" letter-spacing="-2.2" fill="#122033">${escapeXml(brief.date || "Morning Brief")}</text>
  <text x="82" y="184" font-size="21" font-weight="650" fill="#5d7186">${escapeXml(brief.weekday)} · 自动生成概览图 · ${brief.hasWeekly ? "含周报" : "日报"}</text>

  <rect x="82" y="224" width="548" height="204" rx="24" fill="#f7fbff" stroke="#d8e5f2"/>
  <text x="110" y="266" font-size="20" font-weight="800" fill="#087f5b">当日核心摘要</text>
  ${svgTextBlock(brief.title, 110, 311, { maxUnits: 46, maxLines: 2, lineHeight: 34, size: 27, weight: 850, fill: "#132334" })}
  ${svgTextBlock(brief.summary, 110, 378, { maxUnits: 68, maxLines: 2, lineHeight: 27, size: 18, weight: 500, fill: "#4d6176" })}

  <g>
    <rect x="82" y="460" width="130" height="106" rx="20" fill="#f3f8ff" stroke="#d8e5f2"/>
    <text x="110" y="503" font-size="38" font-weight="850" fill="#0a67a3">${brief.githubRepoCount}</text>
    <text x="110" y="536" font-size="15" font-weight="700" fill="#5f7184">GitHub 仓库</text>
    <rect x="224" y="460" width="130" height="106" rx="20" fill="#f3fbf6" stroke="#d8e5f2"/>
    <text x="252" y="503" font-size="38" font-weight="850" fill="#087f5b">${brief.figureCount}</text>
    <text x="252" y="536" font-size="15" font-weight="700" fill="#5f7184">论文图表</text>
    <rect x="366" y="460" width="130" height="106" rx="20" fill="#fff8ed" stroke="#d8e5f2"/>
    <text x="394" y="503" font-size="38" font-weight="850" fill="#a15c00">${brief.tableCount}</text>
    <text x="394" y="536" font-size="15" font-weight="700" fill="#5f7184">HTML 表格</text>
    <rect x="508" y="460" width="122" height="106" rx="20" fill="#f7f4ff" stroke="#d8e5f2"/>
    <text x="536" y="503" font-size="38" font-weight="850" fill="#4f46e5">${brief.linkCount}</text>
    <text x="536" y="536" font-size="15" font-weight="700" fill="#5f7184">来源链接</text>
  </g>

  <rect x="674" y="224" width="524" height="366" rx="24" fill="#fbfdff" stroke="#d8e5f2"/>
  <text x="706" y="268" font-size="20" font-weight="850" fill="#132334">关键数据与趋势可视化</text>
  <text x="706" y="301" font-size="16" font-weight="600" fill="#66798d">GitHub 项目关注度/增长代理，按日报原表顺序抽取</text>
  <path d="M706 338 H1166" stroke="#dbe6f0"/>
  ${barMarkup}

  <rect x="82" y="596" width="1116" height="42" rx="21" fill="url(#accent)" opacity="0.10"/>
  <text x="110" y="623" font-size="16" font-weight="750" fill="#183247">官方动态：${escapeXml(brief.officialStatus)} · 生成时间：${escapeXml(generatedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC"))}</text>
</svg>`;
}

function renderIndex(briefs) {
  const formalCount = briefs.filter(item => item.type === "formal").length;
  const testCount = briefs.filter(item => item.type === "test").length;
  const weeklyCount = briefs.filter(item => item.hasWeekly).length;
  const latest = briefs[0];
  const totalGithub = briefs.reduce((sum, item) => sum + item.githubRepoCount, 0);
  const totalFigures = briefs.reduce((sum, item) => sum + item.figureCount, 0);
  const timelineMax = Math.max(...briefs.map(item => item.githubRepoCount), 1);
  const timeline = briefs.slice().reverse().map(item => {
    const height = Math.max(14, Math.round((item.githubRepoCount / timelineMax) * 112));
    return `<div class="timeline-bar" title="${escapeHtml(item.date)} · ${item.githubRepoCount} GitHub repos"><span style="height:${height}px"></span><small>${escapeHtml(item.date.slice(5))}</small></div>`;
  }).join("");
  const cards = briefs.map((brief, index) => {
    const type = `${brief.type}${brief.hasWeekly ? " weekly" : ""}`;
    const badges = [
      `<span class="badge paper">论文</span>`,
      `<span class="badge">GitHub</span>`,
      brief.hasWeekly ? `<span class="badge weekly">周报</span>` : "",
      brief.type === "test" ? `<span class="badge test">测试稿</span>` : "",
    ].filter(Boolean).join("");
    return `
          <article class="archive-card${index === 0 ? " active" : ""}" tabindex="0" data-type="${type}" data-tags="${escapeHtml(brief.tags)}" data-src="${escapeHtml(brief.source)}" data-title="${escapeHtml(`${brief.date} · ${brief.title}`)}" data-overview="${escapeHtml(brief.overview)}">
            <img class="overview-thumb" src="${escapeHtml(brief.overview)}" alt="${escapeHtml(brief.date)} 简报概览图" loading="lazy">
            <div class="card-body">
              <div class="card-top">
                <div class="date">${escapeHtml(brief.date)}<small>${escapeHtml(brief.weekday || (brief.type === "test" ? "测试" : ""))}</small></div>
                <div class="badge-row">${badges}</div>
              </div>
              <h3>${escapeHtml(brief.title)}</h3>
              <p>${escapeHtml(brief.summary)}</p>
              <div class="meta-row">
                <span class="badge">${brief.githubRepoCount} GitHub repos</span>
                <span class="badge">${brief.figureCount} figures</span>
                <span class="badge">${brief.tableCount} tables</span>
              </div>
              <div class="card-actions">
                <a class="text-link" href="${escapeHtml(brief.source)}" target="_blank" rel="noopener">打开原文</a>
                <a class="text-link soft" href="${escapeHtml(brief.overview)}" target="_blank" rel="noopener">打开概览图</a>
              </div>
            </div>
          </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI / Agent 晨间简报档案站</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --paper: #ffffff;
      --panel: #f8fbff;
      --ink: #132334;
      --muted: #607184;
      --faint: #8ba0b4;
      --line: #d8e4ef;
      --blue: #0a67a3;
      --green: #087f5b;
      --violet: #4f46e5;
      --amber: #a15c00;
      --red: #b42355;
      --shadow: 0 18px 48px rgba(19, 35, 52, .10);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans SC", sans-serif;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        radial-gradient(circle at 16% 0%, rgba(10,103,163,.10), transparent 34rem),
        radial-gradient(circle at 90% 10%, rgba(8,127,91,.08), transparent 32rem),
        linear-gradient(180deg, #f7faff 0%, #eef5fb 46%, #f8fafc 100%);
    }
    a { color: inherit; text-decoration: none; }
    .shell { width: min(1480px, calc(100% - 40px)); margin: 0 auto; padding: 34px 0 52px; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.12fr) minmax(360px, .88fr);
      gap: 20px;
      align-items: stretch;
      margin-bottom: 20px;
    }
    .hero-main, .signal-panel, .toolbar, .archive-card, .reader, .method-card {
      border: 1px solid var(--line);
      background: rgba(255,255,255,.92);
      box-shadow: var(--shadow);
    }
    .hero-main {
      position: relative;
      overflow: hidden;
      min-height: 330px;
      border-radius: 30px;
      padding: 34px;
    }
    .hero-main::after {
      content: "";
      position: absolute;
      right: -170px;
      top: -190px;
      width: 470px;
      height: 470px;
      border-radius: 50%;
      background: conic-gradient(from 120deg, rgba(10,103,163,.20), rgba(79,70,229,.16), rgba(8,127,91,.16), rgba(10,103,163,.20));
      border: 1px solid rgba(10,103,163,.18);
      opacity: .82;
    }
    .eyebrow {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--blue);
      letter-spacing: .18em;
      text-transform: uppercase;
      font-size: 12px;
      font-weight: 800;
    }
    .eyebrow::before {
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 18px rgba(8,127,91,.35);
    }
    h1 {
      position: relative;
      max-width: 820px;
      margin: 24px 0 18px;
      font-size: clamp(42px, 6vw, 78px);
      line-height: .96;
      letter-spacing: -.075em;
    }
    .hero p {
      position: relative;
      max-width: 760px;
      margin: 0;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.74;
    }
    .hero-actions { position: relative; display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 0 17px;
      border: 1px solid rgba(10,103,163,.22);
      border-radius: 999px;
      background: rgba(10,103,163,.08);
      color: #084d7a;
      font-size: 14px;
      font-weight: 800;
    }
    .button.secondary { color: var(--muted); border-color: var(--line); background: #fff; }
    .signal-panel { border-radius: 30px; padding: 22px; display: grid; gap: 18px; }
    .stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .stat { min-height: 112px; border: 1px solid var(--line); border-radius: 20px; padding: 16px; background: var(--panel); }
    .stat strong { display: block; color: var(--blue); font-size: 34px; letter-spacing: -.04em; }
    .stat span { display: block; margin-top: 7px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .latest { border: 1px solid rgba(8,127,91,.18); border-radius: 22px; padding: 18px; background: linear-gradient(135deg, rgba(8,127,91,.07), rgba(10,103,163,.05)); }
    .latest .label { color: var(--green); font-size: 12px; font-weight: 850; letter-spacing: .16em; text-transform: uppercase; }
    .latest h2 { margin: 10px 0 9px; font-size: 22px; line-height: 1.2; letter-spacing: -.03em; }
    .latest p { font-size: 14px; line-height: 1.62; }
    .mini-timeline { display: grid; grid-template-columns: repeat(${Math.max(briefs.length, 1)}, 1fr); gap: 7px; align-items: end; margin-top: 14px; min-height: 148px; }
    .timeline-bar { display: grid; gap: 7px; align-items: end; justify-items: center; color: var(--faint); font-size: 11px; }
    .timeline-bar span { width: 100%; max-width: 34px; border-radius: 999px 999px 8px 8px; background: linear-gradient(180deg, var(--blue), var(--green)); }
    .toolbar { position: sticky; top: 14px; z-index: 4; display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; margin: 20px 0; padding: 14px; border-radius: 22px; }
    .search { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 0 15px; border: 1px solid var(--line); border-radius: 16px; background: #fff; }
    .search span { color: var(--blue); font-size: 12px; letter-spacing: .18em; text-transform: uppercase; font-weight: 800; }
    input[type="search"] { width: 100%; border: 0; outline: 0; color: var(--ink); background: transparent; font: inherit; }
    input[type="search"]::placeholder { color: var(--faint); }
    .filters { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .filter { border: 1px solid var(--line); border-radius: 999px; padding: 10px 13px; background: #fff; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
    .filter[aria-pressed="true"] { color: #fff; background: var(--blue); border-color: var(--blue); }
    .layout { display: grid; grid-template-columns: minmax(430px, .46fr) minmax(0, .54fr); gap: 20px; align-items: start; }
    .archive-grid { display: grid; gap: 14px; }
    .archive-card { overflow: hidden; display: grid; grid-template-columns: 180px 1fr; gap: 15px; border-radius: 24px; padding: 14px; transition: transform .18s ease, border-color .18s ease; cursor: pointer; }
    .archive-card:hover, .archive-card.active { transform: translateY(-2px); border-color: rgba(10,103,163,.45); }
    .overview-thumb { width: 180px; aspect-ratio: 16 / 9; border: 1px solid var(--line); border-radius: 16px; background: #fff; object-fit: cover; }
    .card-body { display: grid; gap: 10px; min-width: 0; }
    .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .date { display: flex; flex-direction: column; gap: 2px; color: var(--blue); font-weight: 850; letter-spacing: -.01em; }
    .date small { color: var(--faint); font-size: 12px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
    .badge-row, .meta-row { display: flex; flex-wrap: wrap; gap: 7px; }
    .badge { display: inline-flex; align-items: center; min-height: 25px; padding: 0 9px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: #fff; font-size: 12px; font-weight: 750; }
    .badge.paper { color: var(--green); border-color: rgba(8,127,91,.22); }
    .badge.weekly { color: var(--amber); border-color: rgba(161,92,0,.22); }
    .badge.test { color: var(--red); border-color: rgba(180,35,85,.22); }
    .archive-card h3 { margin: 0; font-size: 19px; line-height: 1.32; letter-spacing: -.035em; }
    .archive-card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.62; }
    .card-actions { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
    .text-link { display: inline-flex; align-items: center; min-height: 34px; padding: 0 11px; border-radius: 999px; color: var(--blue); background: rgba(10,103,163,.08); font-size: 13px; font-weight: 850; }
    .text-link.soft { color: var(--green); background: rgba(8,127,91,.08); }
    .reader { position: sticky; top: 104px; overflow: hidden; border-radius: 28px; min-height: calc(100vh - 126px); }
    .reader-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 18px; border-bottom: 1px solid var(--line); background: #fbfdff; }
    .reader-title { min-width: 0; }
    .reader-title strong { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 14px; letter-spacing: .02em; }
    .reader-title span { display: block; margin-top: 3px; color: var(--faint); font-size: 12px; }
    .overview-preview { display: block; width: 100%; background: #fff; border-bottom: 1px solid var(--line); }
    .overview-preview img { display: block; width: 100%; height: auto; }
    .reader iframe { display: block; width: 100%; height: calc(100vh - 500px); min-height: 460px; border: 0; background: #fff; }
    .method { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 22px; }
    .method-card { border-radius: 24px; padding: 20px; }
    .method-card h2, .method-card h3 { margin: 0 0 10px; font-size: 17px; letter-spacing: -.02em; }
    .method-card p, .method-card li { color: var(--muted); font-size: 14px; line-height: 1.7; }
    .method-card p { margin: 0; }
    .method-card ul { margin: 0; padding-left: 18px; }
    .empty { display: none; border: 1px dashed rgba(10,103,163,.28); border-radius: 24px; padding: 28px; color: var(--muted); text-align: center; background: rgba(255,255,255,.64); }
    code { padding: 2px 5px; border-radius: 6px; background: #eef3f8; color: #19354c; }
    @media (max-width: 1120px) {
      .hero, .layout, .method { grid-template-columns: 1fr; }
      .reader { position: relative; top: 0; }
      .toolbar { position: relative; top: 0; grid-template-columns: 1fr; }
      .filters { justify-content: flex-start; }
      .reader iframe { height: 72vh; }
    }
    @media (max-width: 720px) {
      .shell { width: min(100% - 22px, 1480px); padding-top: 18px; }
      .hero-main, .signal-panel { border-radius: 22px; padding: 22px; }
      .stat-grid { grid-template-columns: 1fr; }
      .archive-card { grid-template-columns: 1fr; }
      .overview-thumb { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero" aria-labelledby="site-title">
      <div class="hero-main">
        <div class="eyebrow">Rhythm Research Console</div>
        <h1 id="site-title">AI / Agent 晨间简报档案站</h1>
        <p>每天的日报会自动汇入同一个主 HTML：左侧检索与切换历史简报，右侧预览原文；每期同时生成一张概览图，汇总当日核心摘要、关键数据与 GitHub 趋势可视化。</p>
        <div class="hero-actions">
          <a class="button" href="#archive">浏览全部简报</a>
          <a class="button secondary" href="${escapeHtml(latest.source)}" target="_blank" rel="noopener">打开最新一期</a>
          <a class="button secondary" href="${escapeHtml(latest.overview)}" target="_blank" rel="noopener">查看最新概览图</a>
        </div>
      </div>

      <aside class="signal-panel" aria-label="站点统计">
        <div class="stat-grid">
          <div class="stat"><strong>${formalCount}</strong><span>正式晨间简报</span></div>
          <div class="stat"><strong>${testCount}</strong><span>测试稿保留入口</span></div>
          <div class="stat"><strong>${totalGithub}</strong><span>历史简报中出现过的 GitHub 仓库链接</span></div>
          <div class="stat"><strong>${weeklyCount}</strong><span>已生成周报/含周报日期</span></div>
        </div>
        <div class="latest">
          <div class="label">Latest Signal</div>
          <h2>${escapeHtml(latest.title)}</h2>
          <p>${escapeHtml(latest.summary)}</p>
          <div class="mini-timeline" aria-label="GitHub 仓库覆盖趋势">${timeline}</div>
        </div>
      </aside>
    </section>

    <section class="toolbar" aria-label="检索与筛选">
      <label class="search">
        <span>Search</span>
        <input id="searchInput" type="search" placeholder="搜索日期、论文、GitHub、OpenAI、Anthropic..." autocomplete="off">
      </label>
      <div class="filters" role="group" aria-label="筛选">
        <button class="filter" type="button" data-filter="all" aria-pressed="true">全部</button>
        <button class="filter" type="button" data-filter="formal" aria-pressed="false">正式简报</button>
        <button class="filter" type="button" data-filter="weekly" aria-pressed="false">含周报</button>
        <button class="filter" type="button" data-filter="test" aria-pressed="false">测试稿</button>
      </div>
    </section>

    <section id="archive" class="layout">
      <div>
        <div id="archiveGrid" class="archive-grid">
${cards}
        </div>
        <div id="emptyState" class="empty">没有匹配的简报。换一个关键词，或者切回“全部”。</div>
      </div>

      <aside class="reader" aria-label="简报预览">
        <div class="reader-head">
          <div class="reader-title">
            <strong id="readerTitle">${escapeHtml(`${latest.date} · ${latest.title}`)}</strong>
            <span>上方为自动概览图，下方为内嵌原文预览</span>
          </div>
          <div class="card-actions">
            <a id="overviewOpen" class="text-link soft" href="${escapeHtml(latest.overview)}" target="_blank" rel="noopener">概览图</a>
            <a id="readerOpen" class="text-link" href="${escapeHtml(latest.source)}" target="_blank" rel="noopener">打开原文</a>
          </div>
        </div>
        <a id="overviewPreviewLink" class="overview-preview" href="${escapeHtml(latest.overview)}" target="_blank" rel="noopener">
          <img id="overviewPreview" src="${escapeHtml(latest.overview)}" alt="${escapeHtml(latest.date)} 简报概览图">
        </a>
        <iframe id="readerFrame" title="简报预览" src="${escapeHtml(latest.source)}" loading="lazy"></iframe>
      </aside>
    </section>

    <section id="deploy" class="method" aria-label="上线说明与自动化方法">
      <article class="method-card">
        <h2>每日更新流程</h2>
        <p>生成新的 <code>morning-brief-YYYY-MM-DD.html</code> 后，运行 <code>node scripts/update-archive.mjs</code>，脚本会复制日报、同步 assets、生成概览 SVG，并重建本页。</p>
      </article>
      <article class="method-card">
        <h3>概览图内容</h3>
        <ul>
          <li>当日论文标题与核心摘要。</li>
          <li>GitHub 仓库、论文图表、表格、来源链接等关键数据。</li>
          <li>从日报 GitHub 表格抽取的项目关注度/增长代理条形图。</li>
        </ul>
      </article>
      <article class="method-card">
        <h3>当前数据</h3>
        <p>正式简报：${formalCount} 份；测试稿：${testCount} 份；论文图表合计：${totalFigures} 个；最近整理时间：${escapeHtml(generatedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC"))}。</p>
      </article>
    </section>
  </main>

  <script>
    const cards = Array.from(document.querySelectorAll(".archive-card"));
    const frame = document.getElementById("readerFrame");
    const readerTitle = document.getElementById("readerTitle");
    const readerOpen = document.getElementById("readerOpen");
    const overviewOpen = document.getElementById("overviewOpen");
    const overviewPreview = document.getElementById("overviewPreview");
    const overviewPreviewLink = document.getElementById("overviewPreviewLink");
    const searchInput = document.getElementById("searchInput");
    const filters = Array.from(document.querySelectorAll(".filter"));
    const emptyState = document.getElementById("emptyState");
    let activeFilter = "all";

    function selectCard(card) {
      cards.forEach(item => item.classList.toggle("active", item === card));
      const src = card.dataset.src;
      const overview = card.dataset.overview;
      frame.src = src;
      readerTitle.textContent = card.dataset.title;
      readerOpen.href = src;
      overviewOpen.href = overview;
      overviewPreview.src = overview;
      overviewPreview.alt = card.dataset.title + " 概览图";
      overviewPreviewLink.href = overview;
    }

    function matchesFilter(card) {
      if (activeFilter === "all") return true;
      return card.dataset.type.split(" ").includes(activeFilter);
    }

    function matchesSearch(card) {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) return true;
      return \`\${card.dataset.tags} \${card.textContent}\`.toLowerCase().includes(query);
    }

    function applyFilters() {
      let visibleCount = 0;
      cards.forEach(card => {
        const visible = matchesFilter(card) && matchesSearch(card);
        card.style.display = visible ? "grid" : "none";
        if (visible) visibleCount += 1;
      });
      emptyState.style.display = visibleCount === 0 ? "block" : "none";
      const activeVisible = cards.some(card => card.classList.contains("active") && card.style.display !== "none");
      if (!activeVisible) {
        const firstVisible = cards.find(card => card.style.display !== "none");
        if (firstVisible) selectCard(firstVisible);
      }
    }

    cards.forEach(card => {
      card.addEventListener("click", event => {
        if (event.target.closest("a")) return;
        selectCard(card);
      });
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectCard(card);
        }
      });
    });

    filters.forEach(button => {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filter;
        filters.forEach(item => item.setAttribute("aria-pressed", String(item === button)));
        applyFilters();
      });
    });

    searchInput.addEventListener("input", applyFilters);
  </script>
</body>
</html>`;
}

function main() {
  ensureDir(briefsDir);
  ensureDir(overviewsDir);
  ensureDir(dataDir);

  const sourceFiles = fs.readdirSync(workspaceDir)
    .filter(file => /^morning-brief.*\.html$/i.test(file))
    .sort();
  if (sourceFiles.length === 0) {
    throw new Error(`No morning-brief*.html files found in ${workspaceDir}`);
  }

  const briefs = [];
  for (const fileName of sourceFiles) {
    const src = path.join(workspaceDir, fileName);
    const dest = path.join(briefsDir, fileName);
    const html = fs.readFileSync(src, "utf8");
    fs.copyFileSync(src, dest);

    const assetDirs = new Set();
    for (const match of html.matchAll(/(?:src|href)=["']([^"']*assets[^"']*)["']/gi)) {
      const assetDir = match[1].split("/")[0];
      if (assetDir && !assetDir.startsWith("http")) assetDirs.add(assetDir);
    }
    const conventionalDir = fileName.replace(/\.html$/i, "-assets");
    if (fs.existsSync(path.join(workspaceDir, conventionalDir))) assetDirs.add(conventionalDir);
    if (fileName.includes("test") && fs.existsSync(path.join(workspaceDir, "morning-brief-test-assets"))) {
      assetDirs.add("morning-brief-test-assets");
    }
    for (const assetDir of assetDirs) {
      copyRecursive(path.join(workspaceDir, assetDir), path.join(briefsDir, assetDir));
    }

    const metadata = extractBriefMetadata(fileName, html);
    fs.writeFileSync(path.join(archiveDir, metadata.overview), generateOverviewSvg(metadata));
    briefs.push(metadata);
  }

  briefs.sort((a, b) => {
    const dateCompare = String(b.date).localeCompare(String(a.date));
    if (dateCompare !== 0) return dateCompare;
    return a.type === "formal" ? -1 : 1;
  });

  fs.writeFileSync(path.join(dataDir, "briefs.json"), `${JSON.stringify({ generatedAt, briefs }, null, 2)}\n`);
  fs.writeFileSync(path.join(archiveDir, "index.html"), renderIndex(briefs));
  console.log(`Updated ${briefs.length} briefs, ${briefs.length} overview images, and index.html`);
}

main();
