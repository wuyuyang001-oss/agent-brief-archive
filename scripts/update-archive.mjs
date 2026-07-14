import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const archiveDir = path.resolve(scriptDir, "..");
const workspaceDir = path.resolve(archiveDir, "..", "..");
const briefsDir = path.join(archiveDir, "briefs");
const overviewsDir = path.join(archiveDir, "overviews");
const dataDir = path.join(archiveDir, "data");

let generatedAt = "";

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

function positiveDeltaFromText(input) {
  const match = String(input).match(/\+\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(k|K|万))?/);
  if (!match) return null;
  return numberFromText(`${match[1]}${match[2] || ""}`);
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
    const positiveDelta = positiveDeltaFromText(text);
    const fallbackNumbers = [...text.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?(?:\s*(?:k|K|万))?/g)]
      .map(match => numberFromText(match[0]))
      .filter(value => value !== null && value > 0 && value < 1_000_000 && value !== 2026);
    rows.push({
      repo,
      label: cells[repoIndex] ? truncate(cells[repoIndex].replace(repo, "").trim() || repo, 42) : repo,
      value: positiveDelta || numericCells.find(value => value !== 2026) || fallbackNumbers[0] || 1,
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

function extractLabeledPoint(section, labels, fallback = "") {
  for (const label of labels) {
    const paired = section.match(new RegExp(
      `<p[^>]*>\\s*<strong[^>]*>\\s*(?:${label})[：:]?\\s*<\\/strong>\\s*<\\/p>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>`,
      "i",
    ));
    if (paired) return truncate(stripTags(paired[1]), 180);
  }
  const blocks = section.match(/<(?:li|p)[^>]*>[\s\S]*?<\/(?:li|p)>/gi) || [];
  for (const block of blocks) {
    const text = stripTags(block);
    for (const label of labels) {
      const pattern = new RegExp(`^(?:${label})[：:]?\\s*`, "i");
      if (pattern.test(text)) return truncate(text.replace(pattern, ""), 180);
    }
  }
  return truncate(fallback, 180);
}

function extractSummarySignal(html) {
  const section = sectionAfterH2(html, "90 秒摘要");
  const article = section.match(/<article[^>]*class=["'][^"']*signal[^"']*["'][^>]*>[\s\S]*?<\/article>/i);
  if (!article) return "";
  const title = firstMatch(article[0], /<h3[^>]*>([\s\S]*?)<\/h3>/i);
  const core = firstMatch(article[0], /<dt[^>]*>\s*核心结论\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
  return truncate([title, core].filter(Boolean).join("："), 180);
}

function extractFirstSignal(section, domains, kind) {
  const rows = section.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const link = row.match(new RegExp(`href=["'](https:\\/\\/(?:${domains})[^"']*)["']`, "i"));
    if (!link) continue;
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => stripTags(match[1]));
    const host = new URL(link[1]).hostname.replace(/^www\./, "");
    const org = host.includes("openai") ? "OpenAI" : host.includes("anthropic") ? "Anthropic" : "前沿领头羊";
    return {
      kind,
      org,
      title: truncate(cells[0] || org, 110),
      summary: truncate(cells[cells.length - 1] || "查看原始发布了解完整上下文。", 175),
      url: link[1],
    };
  }
  return null;
}

function extractLeaderSignal(html) {
  const leaderSection = sectionAfterH2(html, "前沿领头羊信号");
  const leaderText = stripTags(leaderSection);
  if (
    /OpenAI[\s\S]*?官方发布\s*·\s*无新增/i.test(leaderText)
    && /Anthropic[\s\S]*?官方发布\s*·\s*无新增/i.test(leaderText)
  ) {
    return {
      kind: "官方核验",
      org: "OpenAI / Anthropic",
      title: "本窗口未发现新的官方技术发布",
      summary: /无可核验新增/.test(leaderText)
        ? "同时未发现可核验的关键负责人新原帖；聚合摘要未进入日报。"
        : "请以当期原文的官方动态板块为准。",
      url: "",
    };
  }
  const social = extractFirstSignal(leaderSection, "(?:x\\.com|twitter\\.com)", "个人公开观点");
  if (social) return social;

  const officialSection = sectionAfterH2(html, "OpenAI / Anthropic");
  return extractFirstSignal(
    officialSection,
    "(?:(?:www\\.)?openai\\.com|deploymentsafety\\.openai\\.com|(?:www\\.)?anthropic\\.com)",
    "官方发布",
  ) || {
    kind: "官方核验",
    org: "OpenAI / Anthropic",
    title: "本期未抽取到新的官方技术信号",
    summary: "历史简报可能明确记录为未发现更新；请以当期原文的官方动态板块为准。",
    url: "",
  };
}

function classifyBrief(text, title) {
  const haystack = `${title} ${text}`.toLowerCase();
  const tracks = ["architecture"];
  if (/(gpt|claude|gemini|model capability|模型能力|基础模型|backbone|reasoning|推理能力|multimodal)/i.test(haystack)) tracks.push("model");
  if (/(agent product|产品|chatgpt|claude code|copilot|computer[- ]use|coding agent|助手|工作台|workflow)/i.test(haystack)) tracks.push("product");
  if (/(benchmark|evaluation|evals?|评测|评估方法|swe-bench|browsecomp|accuracy|item f1)/i.test(haystack)) tracks.push("evaluation");

  let primaryTrack = "Agent 架构与工具";
  if (/(benchmark|evaluation|evals?|评测|评估方法|calibration|challenge|qanta|failure|trajector|reliability|audit)/i.test(title)) primaryTrack = "评测方法";
  else if (/(gpt|claude|gemini|模型|reasoning|推理)/i.test(title)) primaryTrack = "模型能力";
  else if (/(product|产品|chatgpt|copilot|computer[- ]use|coding agent)/i.test(title)) primaryTrack = "Agent 产品";
  return { tracks: [...new Set(tracks)], primaryTrack };
}

function optimizeBriefHtml(html) {
  return html.replace(/<img(?![^>]*\bloading=)([^>]*)>/gi, '<img loading="lazy" decoding="async"$1>');
}

function extractBriefMetadata(fileName, html) {
  const date = dateFromFile(fileName);
  const isTest = fileName.includes("test");
  const todaySection = sectionAfterH2(html, "今日论文");
  const paperTitle = extractPaperTitle(html, todaySection);
  const reason = firstMatch(todaySection, /<(?:p|div)[^>]*class="[^"]*(?:note|callout)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i)
    || firstMatch(html, /<p[^>]*>([\s\S]*?)<\/p>/i)
    || "当日 AI/Agent 研究与工程动态摘要。";
  const summarySignal = extractSummarySignal(html);
  const githubRows = extractGithubRows(html);
  const githubRepos = [...new Set([...(html.matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g))].map(match => match[1].replace(/["'<>\s].*$/, "")))];
  const figureCount = (html.match(/<figure[\s>]/gi) || []).length;
  const tableCount = (html.match(/<table[\s>]/gi) || []).length;
  const linkCount = (html.match(/<a\s+[^>]*href=/gi) || []).length;
  const hasWeekly = /<h2[^>]*>[\s\S]*(本周周报|周报总结|Weekly)[\s\S]*<\/h2>/i.test(html);
  const leaderSection = sectionAfterH2(html, "前沿领头羊信号");
  const leaderText = stripTags(leaderSection);
  const officialNoUpdate = /未发现新发布内容/.test(stripTags(html))
    || (
      /OpenAI[\s\S]*?官方发布\s*·\s*无新增/i.test(leaderText)
      && /Anthropic[\s\S]*?官方发布\s*·\s*无新增/i.test(leaderText)
    );
  const officialLinks = (html.match(/https:\/\/(?:openai\.com|www\.anthropic\.com|anthropic\.com)[^"'<\s]*/gi) || []).length;
  const type = isTest ? "test" : "formal";
  const plainText = stripTags(html);
  const classification = classifyBrief(plainText, paperTitle);
  const credibility = firstMatch(todaySection, /<div[^>]*class="[^"]*callout\s+warn[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const decisionAction = firstMatch(todaySection, /<div[^>]*class="[^"]*decision[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const problem = extractLabeledPoint(todaySection, ["选择理由", "此前遇到的问题", "此前问题", "问题"], reason);
  const method = extractLabeledPoint(todaySection, ["核心方法", "研究做法", "方法", "做法"], "查看当期论文方法与架构摘要。");
  const conclusion = extractLabeledPoint(todaySection, ["主要结果", "实验结论", "关键结论", "结论"], "查看当期实验结果与核心结论。");
  const difference = extractLabeledPoint(todaySection, ["与既有工作的差异", "创新点", "创新", "差异"], "查看当期创新点与既有工作的比较。");
  const limitation = extractLabeledPoint(todaySection, ["局限", "限制"], credibility || "仍需结合复现、成本和真实产品场景验证。");
  const hasOpenCode = /github\.com\//i.test(todaySection) && !/未发现[^。；]*(?:代码|仓库)/i.test(stripTags(todaySection));
  const evidence = /可信度[：:]?\s*中低/.test(credibility)
    ? "作者自报 · 可信度中低"
    : tableCount + figureCount > 0 ? "论文实验 · 待独立复现" : "来源汇总 · 证据待加强";
  const action = decisionAction
    ? truncate(decisionAction.replace(/^对产品的直接启发[：:]?\s*/, ""), 170)
    : hasOpenCode ? "核验代码与复现条件，安排小规模产品验证" : "持续追踪代码开放与后续复现，暂不直接接入";
  const leaderSignal = extractLeaderSignal(html);
  const tags = [
    date,
    paperTitle,
    githubRepos.join(" "),
    "AI Agent benchmark GitHub OpenAI Anthropic",
    classification.primaryTrack,
    classification.tracks.join(" "),
    hasWeekly ? "weekly 周报" : "",
    isTest ? "test 测试稿" : "formal 正式简报",
  ].join(" ");

  const declaredOfficialStatus = decodeEntities(
    (html.match(/data-official-status=["']([^"']+)["']/i) || [])[1] || "",
  ).trim();

  return {
    fileName,
    date,
    weekday: date ? weekdayName(date) : "",
    type,
    hasWeekly,
    title: paperTitle,
    summary: truncate(summarySignal || reason, 155),
    problem,
    method,
    conclusion,
    difference,
    limitation,
    evidence,
    action,
    primaryTrack: classification.primaryTrack,
    tracks: classification.tracks,
    leaderSignal,
    source: `briefs/${fileName}`,
    overview: `overviews/${fileName.replace(/\.html$/i, ".svg")}`,
    githubRows,
    githubRepoCount: githubRepos.length,
    figureCount,
    tableCount,
    linkCount,
    officialStatus: declaredOfficialStatus || (officialNoUpdate ? "未发现新发布内容" : `${officialLinks || "若干"} 条官方链接/动态`),
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
  <title>${escapeXml(brief.date)} AI Agent 晨间简报概览</title>
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
  const latest = briefs[0];
  const formalCount = briefs.filter(item => item.type === "formal").length;
  const weeklyCount = briefs.filter(item => item.hasWeekly).length;
  const trackedRepos = new Set(briefs.flatMap(item => item.githubRows.map(row => row.repo))).size;
  const trackLabel = {
    architecture: "架构与工具",
    model: "模型能力",
    product: "Agent 产品",
    evaluation: "评测方法",
  };
  const cards = briefs.map((brief, index) => {
    const trackChips = brief.tracks.slice(0, 3)
      .map(track => `<span class="micro-tag">${escapeHtml(trackLabel[track] || track)}</span>`)
      .join("");
    return `
          <article class="brief-row${index === 0 ? " active" : ""}" role="button" tabindex="0"
            aria-selected="${index === 0 ? "true" : "false"}" data-id="${escapeHtml(brief.fileName)}">
            <img class="brief-thumb" src="${escapeHtml(brief.overview)}" alt="" loading="lazy">
            <div class="brief-copy">
              <div class="brief-meta">
                <time datetime="${escapeHtml(brief.date)}">${escapeHtml(brief.date.slice(5))} · ${escapeHtml(brief.weekday)}</time>
                <span>${escapeHtml(brief.primaryTrack)}</span>
              </div>
              <h2>${escapeHtml(brief.title)}</h2>
              <p>${escapeHtml(brief.summary)}</p>
              <div class="brief-tags">${trackChips}<span class="feedback-mark" aria-label="已有私人反馈"></span></div>
            </div>
          </article>`;
  }).join("\n");
  const briefJson = JSON.stringify(briefs).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="description" content="面向 Agent 产品与评测产品的技术红利、模型能力、评测方法和工具趋势研究档案。">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23155eef'/%3E%3Cpath d='M17 43 29 17h7l12 26h-8l-2-6H27l-2 6Zm13-13h6l-3-8Z' fill='white'/%3E%3C/svg%3E">
  <title>Agent 技术红利与产品机会雷达</title>
  <style>
    :root {
      color-scheme: light;
      --canvas: #f4f7fb;
      --paper: #ffffff;
      --ink: #102033;
      --muted: #526176;
      --quiet: #6b7890;
      --line: #d9e1ec;
      --line-strong: #c6d1df;
      --blue: #155eef;
      --blue-soft: #eef4ff;
      --green: #087a5b;
      --green-soft: #eaf8f3;
      --amber: #9a5b00;
      --amber-soft: #fff6e8;
      --red: #b42318;
      --radius: 18px;
      --shadow: 0 14px 40px rgba(30, 50, 75, .08);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans SC", sans-serif;
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: var(--canvas); scroll-behavior: smooth; }
    [hidden] { display: none !important; }
    body { margin: 0; min-width: 0; overflow-x: hidden; color: var(--ink); background: var(--canvas); }
    button, input, textarea { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    a { color: inherit; text-decoration: none; }
    :focus-visible { outline: 3px solid rgba(21, 94, 239, .28); outline-offset: 2px; }
    .page {
      display: flex;
      flex-direction: column;
      width: min(1640px, 100%);
      height: 100dvh;
      margin: 0 auto;
      padding: 18px 22px 24px;
    }
    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: end;
      gap: 24px;
      padding: 8px 2px 15px;
      border-bottom: 1px solid var(--line-strong);
    }
    .brand-line { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 5px rgba(8, 122, 91, .10); }
    .kicker { color: var(--green); font-size: 11px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(25px, 3.2vw, 42px); line-height: 1.08; letter-spacing: -.045em; }
    .brand p { margin: 7px 0 0; max-width: 820px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .top-stats { display: flex; align-items: center; gap: 8px; color: var(--quiet); font-size: 12px; white-space: nowrap; }
    .top-stats span { padding: 7px 9px; border: 1px solid var(--line); border-radius: 9px; background: var(--paper); }
    .top-stats strong { color: var(--ink); }
    .track-tabs {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      margin: 0 -2px;
      padding: 11px 2px 10px;
      scrollbar-width: none;
    }
    .track-tabs::-webkit-scrollbar { display: none; }
    .track-tab {
      flex: 0 0 auto;
      min-height: 36px;
      padding: 0 13px;
      border: 1px solid transparent;
      border-radius: 10px;
      color: var(--muted);
      background: transparent;
      font-size: 13px;
      font-weight: 720;
      cursor: pointer;
    }
    .track-tab:hover { color: var(--blue); background: var(--blue-soft); }
    .track-tab[aria-pressed="true"] { color: #fff; background: var(--blue); border-color: var(--blue); }
    .workspace {
      display: grid;
      flex: 1;
      grid-template-columns: minmax(330px, 35%) minmax(0, 65%);
      gap: 14px;
      min-height: 0;
      height: auto;
    }
    .archive-panel, .reader-panel {
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      background: var(--paper);
      box-shadow: var(--shadow);
    }
    .archive-panel { display: flex; flex-direction: column; }
    .panel-tools {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 9px;
      padding: 11px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    .search-box { position: relative; min-width: 0; }
    .search-box svg { position: absolute; left: 11px; top: 50%; width: 16px; height: 16px; color: var(--quiet); transform: translateY(-50%); pointer-events: none; }
    .search-box input {
      width: 100%;
      height: 40px;
      padding: 0 12px 0 35px;
      border: 1px solid var(--line);
      border-radius: 11px;
      color: var(--ink);
      background: var(--paper);
      outline: 0;
    }
    .search-box input:focus { border-color: rgba(21, 94, 239, .55); box-shadow: 0 0 0 3px rgba(21, 94, 239, .08); }
    .result-count { min-width: 58px; color: var(--quiet); font-size: 12px; text-align: right; }
    .archive-list { min-height: 0; overflow-y: auto; padding: 7px; scrollbar-color: #c6d1df transparent; }
    .brief-row {
      display: grid;
      grid-template-columns: 108px minmax(0, 1fr);
      gap: 12px;
      min-width: 0;
      padding: 10px;
      border: 1px solid transparent;
      border-radius: 14px;
      cursor: pointer;
      transition: border-color .16s ease, background .16s ease, transform .16s ease;
    }
    .brief-row + .brief-row { margin-top: 3px; }
    .brief-row:hover { border-color: var(--line); background: #f9fbfe; transform: translateY(-1px); }
    .brief-row.active { border-color: rgba(21, 94, 239, .35); background: var(--blue-soft); }
    .brief-thumb { width: 108px; aspect-ratio: 16 / 9; align-self: start; border: 1px solid var(--line); border-radius: 10px; object-fit: cover; background: #fff; }
    .brief-copy { min-width: 0; }
    .brief-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--quiet); font-size: 10.5px; font-weight: 720; letter-spacing: .02em; }
    .brief-meta span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--green); }
    .brief-row h2 {
      display: -webkit-box;
      overflow: hidden;
      margin: 5px 0 4px;
      font-size: 14px;
      line-height: 1.32;
      letter-spacing: -.015em;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .brief-row p {
      display: -webkit-box;
      overflow: hidden;
      margin: 0;
      color: var(--muted);
      font-size: 11.5px;
      line-height: 1.42;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .brief-tags { display: flex; gap: 5px; align-items: center; margin-top: 7px; overflow: hidden; }
    .micro-tag {
      flex: 0 0 auto;
      padding: 2px 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--quiet);
      background: #fff;
      font-size: 9.5px;
      font-weight: 700;
    }
    .feedback-mark { display: none; width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
    .brief-row.has-feedback .feedback-mark { display: inline-block; }
    .empty-list { display: none; padding: 42px 22px; color: var(--muted); font-size: 13px; line-height: 1.6; text-align: center; }
    .reader-panel { display: flex; flex-direction: column; position: relative; }
    .reader-empty { display: none; place-items: center; height: 100%; padding: 30px; color: var(--muted); text-align: center; }
    .reader-panel.is-empty .reader-empty { display: grid; }
    .reader-panel.is-empty .reader-content { display: none; }
    .reader-content { display: flex; flex: 1; flex-direction: column; min-height: 0; }
    .reader-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      min-height: 56px;
      padding: 9px 13px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    .reader-heading { min-width: 0; }
    .reader-heading strong { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13.5px; }
    .reader-heading span { display: block; margin-top: 3px; color: var(--quiet); font-size: 10.5px; }
    .reader-actions { display: flex; align-items: center; gap: 6px; }
    .compact-link, .close-reader {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 9px;
      color: var(--muted);
      background: #fff;
      font-size: 11.5px;
      font-weight: 760;
      cursor: pointer;
    }
    .compact-link.primary { color: var(--blue); border-color: rgba(21, 94, 239, .24); background: var(--blue-soft); }
    .close-reader { display: none; width: 34px; padding: 0; font-size: 18px; }
    details { min-width: 0; }
    details > summary { list-style: none; cursor: pointer; }
    details > summary::-webkit-details-marker { display: none; }
    .decision { border-bottom: 1px solid var(--line); background: #fff; }
    .decision > summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 40px;
      padding: 7px 13px;
    }
    .summary-label { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; font-weight: 800; }
    .summary-label::before { content: "90s"; padding: 3px 6px; border-radius: 6px; color: var(--blue); background: var(--blue-soft); font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .summary-meta { overflow: hidden; color: var(--quiet); font-size: 10.5px; white-space: nowrap; text-overflow: ellipsis; }
    .decision > summary::after, .overview-fold > summary::after, .feedback-panel > summary::after { content: "＋"; flex: 0 0 auto; color: var(--quiet); font-size: 14px; }
    .decision[open] > summary::after, .overview-fold[open] > summary::after, .feedback-panel[open] > summary::after { content: "−"; }
    .decision-body { padding: 0 13px 11px; }
    .decision-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
    .decision-card { min-width: 0; min-height: 86px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; background: #fbfcfe; }
    .decision-card b { display: block; margin-bottom: 5px; color: var(--blue); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; }
    .decision-card p { display: -webkit-box; overflow: hidden; margin: 0; color: var(--muted); font-size: 10.5px; line-height: 1.43; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
    .decision-foot { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 7px; }
    .signal-chip { min-width: 0; padding: 7px 9px; border-radius: 9px; color: var(--muted); background: var(--green-soft); font-size: 10.5px; line-height: 1.4; }
    .signal-chip b { color: var(--green); }
    .signal-chip.action { background: var(--amber-soft); }
    .signal-chip.action b { color: var(--amber); }
    .leader-signal {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-height: 66px;
      padding: 8px 13px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(90deg, rgba(21, 94, 239, .035), transparent 58%);
    }
    .signal-kind { padding: 4px 7px; border: 1px solid rgba(8, 122, 91, .22); border-radius: 7px; color: var(--green); background: var(--green-soft); font-size: 9.5px; font-weight: 800; white-space: nowrap; }
    .leader-copy { min-width: 0; }
    .leader-copy strong { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11.5px; }
    .leader-copy p { display: block; overflow: hidden; margin: 3px 0 0; color: var(--muted); font-size: 10.5px; line-height: 1.35; white-space: nowrap; text-overflow: ellipsis; }
    .leader-source { color: var(--blue); font-size: 10.5px; font-weight: 760; white-space: nowrap; }
    .overview-fold { border-bottom: 1px solid var(--line); background: #fbfcfe; }
    .overview-fold > summary, .feedback-panel > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 36px;
      padding: 6px 13px;
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 760;
    }
    .overview-fold > summary span, .feedback-panel > summary span { margin-left: auto; color: var(--quiet); font-weight: 500; }
    .overview-image-link { display: block; max-height: 330px; overflow: auto; padding: 9px; border-top: 1px solid var(--line); background: #f3f6fa; }
    .overview-image-link img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
    .frame-wrap { flex: 1; min-height: 0; position: relative; background: #fff; }
    .frame-wrap iframe { display: block; width: 100%; height: 100%; min-height: 0; border: 0; background: #fff; }
    .feedback-panel { border-top: 1px solid var(--line); background: #fbfcfe; }
    .feedback-body { display: grid; grid-template-columns: auto minmax(180px, 1fr); gap: 8px; padding: 0 13px 10px; }
    .feedback-options { display: flex; flex-wrap: wrap; gap: 5px; }
    .feedback-button { min-height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: #fff; font-size: 10.5px; cursor: pointer; }
    .feedback-button.active { color: #fff; border-color: var(--green); background: var(--green); }
    .feedback-button[data-feedback="dismiss"].active { border-color: var(--red); background: var(--red); }
    .feedback-note { width: 100%; min-height: 30px; padding: 6px 9px; resize: vertical; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: #fff; font-size: 10.5px; outline: 0; }
    .privacy-note { color: var(--quiet); font-size: 9.5px; font-weight: 500; }
    @media (max-width: 1180px) {
      .workspace { grid-template-columns: minmax(300px, 38%) minmax(0, 62%); }
      .decision-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .decision-card { min-height: 70px; }
    }
    @media (max-width: 980px) {
      .page { min-height: 100dvh; height: auto; padding: 12px 12px 18px; }
      .topbar { grid-template-columns: 1fr; gap: 10px; padding-top: 2px; }
      .brand p { max-width: none; font-size: 12px; }
      .top-stats { overflow-x: auto; }
      .workspace { display: block; height: auto; min-height: 0; }
      .archive-panel { min-height: calc(100dvh - 174px); box-shadow: none; }
      .archive-list { overflow: visible; }
      .reader-panel {
        position: fixed;
        inset: 0;
        z-index: 20;
        height: 100dvh;
        min-height: 0;
        border: 0;
        border-radius: 0;
        transform: translateY(105%);
        transition: transform .24s ease;
      }
      .reader-panel.is-open { transform: translateY(0); }
      .reader-head { grid-template-columns: 34px minmax(0, 1fr) auto; }
      .close-reader { display: inline-flex; }
      .reader-head { padding-left: 10px; }
      .compact-link { white-space: nowrap; }
      .decision-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .frame-wrap iframe { min-height: 260px; }
      body.reader-open { overflow: hidden; }
    }
    @media (max-width: 560px) {
      h1 { font-size: 27px; }
      .brand p { display: none; }
      .top-stats span:nth-child(n+3) { display: none; }
      .track-tabs { padding-top: 9px; }
      .track-tab { min-height: 34px; padding: 0 11px; font-size: 12px; }
      .panel-tools { position: sticky; top: 0; z-index: 2; }
      .brief-row { grid-template-columns: 92px minmax(0, 1fr); padding: 9px; }
      .brief-thumb { width: 92px; }
      .brief-row p { -webkit-line-clamp: 1; }
      .reader-actions .compact-link:not(.primary) { display: none; }
      .reader-heading span { display: none; }
      .decision-grid { grid-template-columns: 1fr; }
      .decision-card { min-height: 0; }
      .decision-foot, .feedback-body { grid-template-columns: 1fr; }
      .leader-signal { grid-template-columns: auto minmax(0, 1fr); }
      .leader-source { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="topbar">
      <div class="brand">
        <div class="brand-line"><span class="pulse"></span><span class="kicker">Rhythm Research Console</span></div>
        <h1>Agent 技术红利与产品机会雷达</h1>
        <p>先看结论、可信度与行动，再决定是否深读。持续追踪模型能力、Agent 产品、架构工具、评测方法与领头羊关注方向。</p>
      </div>
      <div class="top-stats" aria-label="档案统计">
        <span><strong>${formalCount}</strong> 期日报</span>
        <span><strong>${trackedRepos}</strong> 个项目</span>
        <span><strong>${weeklyCount}</strong> 期周报</span>
        <span>更新 ${escapeHtml(generatedAt.slice(0, 10))}</span>
      </div>
    </header>

    <nav class="track-tabs" aria-label="研究主题">
      <button class="track-tab" type="button" data-track="latest" aria-pressed="true">今日信号</button>
      <button class="track-tab" type="button" data-track="model" aria-pressed="false">模型能力</button>
      <button class="track-tab" type="button" data-track="product" aria-pressed="false">Agent 产品</button>
      <button class="track-tab" type="button" data-track="evaluation" aria-pressed="false">评测方法</button>
      <button class="track-tab" type="button" data-track="architecture" aria-pressed="false">架构与工具</button>
      <button class="track-tab" type="button" data-track="all" aria-pressed="false">全部档案</button>
    </nav>

    <section class="workspace">
      <aside class="archive-panel" aria-label="简报档案">
        <div class="panel-tools">
          <label class="search-box">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m21 21-4.4-4.4m2.4-5.1a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z"/></svg>
            <input id="searchInput" type="search" placeholder="搜索论文、项目或机构" autocomplete="off">
          </label>
          <span id="resultCount" class="result-count" aria-live="polite">1 / ${briefs.length}</span>
        </div>
        <div id="archiveList" class="archive-list">
${cards}
          <div id="emptyList" class="empty-list">没有匹配结果。可以换一个项目名、论文关键词，或切换到“全部档案”。</div>
        </div>
      </aside>

      <section id="readerPanel" class="reader-panel" aria-label="简报阅读器">
        <div class="reader-empty"><div><strong>当前筛选没有可读简报</strong><br><span>调整搜索条件后，阅读区会自动载入第一条匹配结果。</span></div></div>
        <div class="reader-content">
          <header class="reader-head">
            <button id="closeReader" class="close-reader" type="button" aria-label="关闭阅读器">×</button>
            <div class="reader-heading">
              <strong id="readerTitle">${escapeHtml(latest.date)} · ${escapeHtml(latest.title)}</strong>
              <span id="readerSubline">${escapeHtml(latest.primaryTrack)} · ${escapeHtml(latest.evidence)}</span>
            </div>
            <div class="reader-actions">
              <a id="overviewOpen" class="compact-link" href="${escapeHtml(latest.overview)}" target="_blank" rel="noopener">概览图</a>
              <a id="readerOpen" class="compact-link primary" href="${escapeHtml(latest.source)}" target="_blank" rel="noopener">独立阅读</a>
            </div>
          </header>

          <details id="decisionPanel" class="decision">
            <summary><span class="summary-label">90 秒决策摘要</span><span id="summaryMeta" class="summary-meta">${escapeHtml(latest.primaryTrack)} · ${latest.githubRepoCount} 个项目</span></summary>
            <div class="decision-body">
              <div class="decision-grid">
                <article class="decision-card"><b>此前问题</b><p id="problemText">${escapeHtml(latest.problem)}</p></article>
                <article class="decision-card"><b>研究做法</b><p id="methodText">${escapeHtml(latest.method)}</p></article>
                <article class="decision-card"><b>关键结论</b><p id="conclusionText">${escapeHtml(latest.conclusion)}</p></article>
                <article class="decision-card"><b>差异与可信度</b><p id="differenceText">${escapeHtml(latest.difference)} · ${escapeHtml(latest.evidence)}</p></article>
              </div>
              <div class="decision-foot">
                <div class="signal-chip"><b>技术红利：</b><span id="radarText">${escapeHtml(latest.githubRows.slice(0, 3).map(row => row.repo).join(" · ") || latest.primaryTrack)}</span></div>
                <div class="signal-chip action"><b>建议动作：</b><span id="actionText">${escapeHtml(latest.action)}</span></div>
              </div>
            </div>
          </details>

          <a id="leaderLink" class="leader-signal" href="${escapeHtml(latest.leaderSignal.url || latest.source)}" target="_blank" rel="noopener">
            <span id="leaderKind" class="signal-kind">${escapeHtml(latest.leaderSignal.kind)}</span>
            <span class="leader-copy"><strong id="leaderTitle">${escapeHtml(latest.leaderSignal.org)} · ${escapeHtml(latest.leaderSignal.title)}</strong><p id="leaderSummary">${escapeHtml(latest.leaderSignal.summary)}</p></span>
            <span class="leader-source">查看原始信号 ↗</span>
          </a>

          <details class="overview-fold">
            <summary>当日概览图 <span>核心摘要、关键数据与 GitHub 趋势</span></summary>
            <a id="overviewPreviewLink" class="overview-image-link" href="${escapeHtml(latest.overview)}" target="_blank" rel="noopener">
              <img id="overviewPreview" src="${escapeHtml(latest.overview)}" alt="${escapeHtml(latest.date)} 简报概览图">
            </a>
          </details>

          <div class="frame-wrap">
            <iframe id="readerFrame" title="简报原文" src="${escapeHtml(latest.source)}"></iframe>
          </div>

          <details id="feedbackPanel" class="feedback-panel">
            <summary>私人反馈 <span id="feedbackSummary" class="privacy-note">仅保存在当前浏览器</span></summary>
            <div class="feedback-body">
              <div class="feedback-options" role="group" aria-label="简报反馈">
                <button class="feedback-button" type="button" data-feedback="interest">感兴趣</button>
                <button class="feedback-button" type="button" data-feedback="read">已读</button>
                <button class="feedback-button" type="button" data-feedback="try">准备试用</button>
                <button class="feedback-button" type="button" data-feedback="track">持续跟踪</button>
                <button class="feedback-button" type="button" data-feedback="dismiss">不再推荐</button>
              </div>
              <textarea id="feedbackNote" class="feedback-note" rows="1" maxlength="240" placeholder="记录一句产品判断、验证结果或创业线索"></textarea>
            </div>
          </details>
        </div>
      </section>
    </section>
  </main>

  <script>
    const briefs = ${briefJson};
    const feedbackKey = "agentBriefFeedback:v1";
    const rows = Array.from(document.querySelectorAll(".brief-row"));
    const trackButtons = Array.from(document.querySelectorAll(".track-tab"));
    const feedbackButtons = Array.from(document.querySelectorAll(".feedback-button"));
    const readerPanel = document.getElementById("readerPanel");
    const readerFrame = document.getElementById("readerFrame");
    const readerTitle = document.getElementById("readerTitle");
    const readerSubline = document.getElementById("readerSubline");
    const readerOpen = document.getElementById("readerOpen");
    const overviewOpen = document.getElementById("overviewOpen");
    const overviewPreview = document.getElementById("overviewPreview");
    const overviewPreviewLink = document.getElementById("overviewPreviewLink");
    const decisionPanel = document.getElementById("decisionPanel");
    const searchInput = document.getElementById("searchInput");
    const resultCount = document.getElementById("resultCount");
    const emptyList = document.getElementById("emptyList");
    const feedbackNote = document.getElementById("feedbackNote");
    const feedbackSummary = document.getElementById("feedbackSummary");
    let activeTrack = "latest";
    let selectedId = briefs[0].fileName;
    let feedbackState = {};
    let noteTimer = null;

    try { feedbackState = JSON.parse(localStorage.getItem(feedbackKey) || "{}"); } catch (_) { feedbackState = {}; }

    function isMobile() {
      return window.matchMedia("(max-width: 980px)").matches;
    }

    function briefById(id) {
      return briefs.find(item => item.fileName === id);
    }

    function setText(id, value) {
      document.getElementById(id).textContent = value || "当期未单独提炼，请查看原文。";
    }

    function saveFeedback() {
      localStorage.setItem(feedbackKey, JSON.stringify(feedbackState));
    }

    function feedbackFor(id) {
      return feedbackState[id] || { states: [], note: "" };
    }

    function renderFeedback(brief) {
      const entry = feedbackFor(brief.fileName);
      feedbackButtons.forEach(button => button.classList.toggle("active", entry.states.includes(button.dataset.feedback)));
      feedbackNote.value = entry.note || "";
      feedbackSummary.textContent = entry.states.length || entry.note ? "已记录 · 仅保存在当前浏览器" : "仅保存在当前浏览器";
      rows.forEach(row => {
        const value = feedbackFor(row.dataset.id);
        row.classList.toggle("has-feedback", Boolean(value.states.length || value.note));
      });
    }

    function selectBrief(brief, options) {
      const config = Object.assign({ openMobile: false, updateHash: true }, options || {});
      selectedId = brief.fileName;
      rows.forEach(row => {
        const active = row.dataset.id === brief.fileName;
        row.classList.toggle("active", active);
        row.setAttribute("aria-selected", String(active));
      });
      readerPanel.classList.remove("is-empty");
      readerTitle.textContent = brief.date + " · " + brief.title;
      readerSubline.textContent = brief.primaryTrack + " · " + brief.evidence;
      readerOpen.href = brief.source;
      overviewOpen.href = brief.overview;
      overviewPreview.src = brief.overview;
      overviewPreview.alt = brief.date + " 简报概览图";
      overviewPreviewLink.href = brief.overview;
      if (readerFrame.getAttribute("src") !== brief.source) readerFrame.src = brief.source;
      setText("summaryMeta", brief.primaryTrack + " · " + brief.githubRepoCount + " 个项目");
      setText("problemText", brief.problem);
      setText("methodText", brief.method);
      setText("conclusionText", brief.conclusion);
      setText("differenceText", brief.difference + " · " + brief.evidence);
      setText("radarText", brief.githubRows.slice(0, 3).map(row => row.repo).join(" · ") || brief.primaryTrack);
      setText("actionText", brief.action);
      setText("leaderKind", brief.leaderSignal.kind);
      setText("leaderTitle", brief.leaderSignal.org + " · " + brief.leaderSignal.title);
      setText("leaderSummary", brief.leaderSignal.summary);
      document.getElementById("leaderLink").href = brief.leaderSignal.url || brief.source;
      renderFeedback(brief);
      if (config.updateHash) history.replaceState(null, "", "#" + brief.fileName.replace(".html", ""));
      if (config.openMobile && isMobile()) {
        readerPanel.classList.add("is-open");
        document.body.classList.add("reader-open");
      }
    }

    function matchesTrack(brief, index) {
      if (activeTrack === "all") return true;
      if (activeTrack === "latest") return index === 0;
      return brief.tracks.includes(activeTrack);
    }

    function matchesSearch(brief) {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) return true;
      const haystack = [
        brief.tags,
        brief.summary,
        brief.problem,
        brief.method,
        brief.conclusion,
        brief.githubRows.map(row => row.repo).join(" "),
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    }

    function applyFilters() {
      const visible = [];
      briefs.forEach((brief, index) => {
        const show = matchesTrack(brief, index) && matchesSearch(brief);
        const row = rows.find(item => item.dataset.id === brief.fileName);
        row.hidden = !show;
        if (show) visible.push(brief);
      });
      resultCount.textContent = visible.length + " / " + briefs.length;
      emptyList.style.display = visible.length ? "none" : "block";
      if (!visible.length) {
        readerPanel.classList.add("is-empty");
        readerFrame.src = "about:blank";
        readerPanel.classList.remove("is-open");
        document.body.classList.remove("reader-open");
        return;
      }
      const selectedVisible = visible.some(brief => brief.fileName === selectedId);
      if (!selectedVisible) selectBrief(visible[0], { openMobile: false });
    }

    rows.forEach(row => {
      const activate = () => {
        const brief = briefById(row.dataset.id);
        if (brief) selectBrief(brief, { openMobile: true });
      };
      row.addEventListener("click", activate);
      row.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
    });

    trackButtons.forEach(button => {
      button.addEventListener("click", () => {
        activeTrack = button.dataset.track;
        trackButtons.forEach(item => item.setAttribute("aria-pressed", String(item === button)));
        applyFilters();
      });
    });

    feedbackButtons.forEach(button => {
      button.addEventListener("click", () => {
        const entry = feedbackFor(selectedId);
        const value = button.dataset.feedback;
        if (value === "dismiss") {
          entry.states = entry.states.includes("dismiss") ? [] : ["dismiss"];
        } else {
          entry.states = entry.states.filter(item => item !== "dismiss");
          entry.states = entry.states.includes(value) ? entry.states.filter(item => item !== value) : entry.states.concat(value);
        }
        feedbackState[selectedId] = entry;
        saveFeedback();
        renderFeedback(briefById(selectedId));
      });
    });

    feedbackNote.addEventListener("input", () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        const entry = feedbackFor(selectedId);
        entry.note = feedbackNote.value.trim();
        feedbackState[selectedId] = entry;
        saveFeedback();
        renderFeedback(briefById(selectedId));
      }, 250);
    });

    searchInput.addEventListener("input", applyFilters);
    document.getElementById("closeReader").addEventListener("click", () => {
      readerPanel.classList.remove("is-open");
      document.body.classList.remove("reader-open");
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        readerPanel.classList.remove("is-open");
        document.body.classList.remove("reader-open");
      }
    });

    const deepLink = decodeURIComponent(location.hash.replace(/^#/, ""));
    const linkedBrief = briefs.find(brief => brief.fileName.replace(".html", "") === deepLink);
    if (linkedBrief) selectBrief(linkedBrief, { openMobile: isMobile(), updateHash: false });
    else selectBrief(briefs[0], { openMobile: false, updateHash: false });
    if (isMobile()) decisionPanel.removeAttribute("open");
    applyFilters();
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
  const latestSourceMtime = Math.max(...sourceFiles.map(file => fs.statSync(path.join(workspaceDir, file)).mtimeMs));
  generatedAt = process.env.ARCHIVE_GENERATED_AT || new Date(latestSourceMtime).toISOString();

  const briefs = [];
  for (const fileName of sourceFiles) {
    const src = path.join(workspaceDir, fileName);
    const dest = path.join(briefsDir, fileName);
    const html = fs.readFileSync(src, "utf8");
    fs.writeFileSync(dest, optimizeBriefHtml(html));

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
