#!/usr/bin/env node
/**
 * GitHub Star 时间序列。
 *
 * 原来的做法是每期简报里手写一张「07-21 → 07-24」的快照表，基线只存在于上一期
 * HTML 里。换台电脑、或者断更几天，基线就断了。这个脚本把基线固化成
 * data/star-history.json，并且能从历史简报里把过去的数据点全部反解回来。
 *
 *   node scripts/star-history.mjs seed     从 briefs/*.html 反解历史快照表
 *   node scripts/star-history.mjs update   抓实时 star 数并追加一个数据点
 *   node scripts/star-history.mjs delta    按窗口算增量，输出 Markdown 表
 *
 * update 需要能访问 api.github.com；设 GITHUB_TOKEN 可提高额度。
 * delta 和 seed 纯本地，不联网。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const archiveDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const briefsDir = path.join(archiveDir, "briefs");
const historyPath = path.join(archiveDir, "data", "star-history.json");

// ---------------------------------------------------------------- 存储

function loadHistory() {
  if (!fs.existsSync(historyPath)) return { repos: {} };
  try {
    const data = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    return data && data.repos ? data : { repos: {} };
  } catch (err) {
    console.warn(`[star-history] 读取失败，当作空历史：${err.message}`);
    return { repos: {} };
  }
}

function saveHistory(history) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  // repo -> { ISO 时间戳: star 数 }，时间戳升序
  const repos = {};
  for (const name of Object.keys(history.repos).sort()) {
    const points = history.repos[name];
    repos[name] = Object.fromEntries(
      Object.entries(points).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  const payload = { updatedAt: new Date().toISOString(), repos };
  fs.writeFileSync(historyPath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function record(history, repo, iso, stars) {
  if (!Number.isFinite(stars)) return false;
  history.repos[repo] ??= {};
  const existing = history.repos[repo][iso];
  history.repos[repo][iso] = stars;
  return existing === undefined;
}

// ---------------------------------------------------------------- seed

const NUM = /^[\d,]+$/;
const parseNum = (s) => Number.parseInt(String(s).replace(/,/g, ""), 10);
const stripTags = (s) => s.replace(/<[^>]+>/g, "").trim();

/** 该仓库在某个 CST 日历日上是否已有数据点。 */
const cstDay = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
function hasPointOnDay(history, repo, day) {
  return Object.keys(history.repos[repo] || {}).some((iso) => cstDay(iso) === day);
}

/**
 * 表头的日期是 "07-21 10:20" 这种，没有年份。用简报自身的日期补年，
 * 并处理跨年：如果补完之后比简报日期还晚，说明是上一年。
 */
function resolveTimestamp(label, briefDate) {
  const m = label.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mm, dd, hh, min] = m;
  let year = Number(briefDate.slice(0, 4));
  let iso = `${year}-${mm}-${dd}T${hh}:${min}:00+08:00`;
  if (new Date(iso) > new Date(`${briefDate}T23:59:59+08:00`)) {
    year -= 1;
    iso = `${year}-${mm}-${dd}T${hh}:${min}:00+08:00`;
  }
  return new Date(iso).toISOString();
}

/**
 * 不按标题找表——23 期里标题写法有 20 多种（"GitHub Star 快照" / "star 快照：增长候选"
 * / "过去三天 Star 净增长 Top 5" …）。改为扫描全部表格，按结构判定：
 * 表头至少两列形如 "MM-DD HH:MM"，且数据行首列是 owner/repo。
 */
function seedFromBrief(history, file) {
  const briefDate = file.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!briefDate) return 0;

  const html = fs.readFileSync(path.join(briefsDir, file), "utf8");
  let added = 0;

  for (const table of html.match(/<table>[\s\S]*?<\/table>/g) || []) {
    const headers = [...(table.match(/<th>([\s\S]*?)<\/th>/g) || [])].map(stripTags);
    const stamps = headers.map((h) => resolveTimestamp(h, briefDate));
    if (stamps.filter(Boolean).length < 2) continue;

    for (const row of table.match(/<tr>(?:(?!<\/tr>)[\s\S])*<\/tr>/g) || []) {
      const cells = [...(row.match(/<td>([\s\S]*?)<\/td>/g) || [])].map(stripTags);
      if (cells.length < 2) continue;
      const repo = cells[0];
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;

      // 逐列对齐：第 i 列的时间戳来自同位置的表头
      for (let i = 1; i < cells.length; i += 1) {
        if (!stamps[i] || !NUM.test(cells[i])) continue;
        if (record(history, repo, stamps[i], parseNum(cells[i]))) added += 1;
      }
    }
  }
  return added;
}

/**
 * 兜底：早期简报的表头五花八门，且存在表头列数与数据行不一致的情况，按列位对齐会错行。
 * 这里只做一件有把握的事——行里出现 owner/repo 就取该行最大的无符号数当作"当期 star 数"，
 * 时间戳用简报自身日期。基线列不去猜（它会由前一期的数据点自然充当）。
 * 依据：同一行里当期 star 必然大于基线，而增量列带 +/- 号会被过滤掉。
 */
function seedLooseFromBrief(history, file) {
  const briefDate = file.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!briefDate) return 0;

  const iso = new Date(`${briefDate}T10:00:00+08:00`).toISOString();
  const html = fs.readFileSync(path.join(briefsDir, file), "utf8");
  let added = 0;

  for (const table of html.match(/<table>[\s\S]*?<\/table>/g) || []) {
    for (const row of table.match(/<tr>(?:(?!<\/tr>)[\s\S])*<\/tr>/g) || []) {
      const cells = [...(row.match(/<td>([\s\S]*?)<\/td>/g) || [])].map(stripTags);
      const repo = cells.map((c) => c.match(/^(?:\d+\s*[·.]\s*)?([\w.-]+\/[\w.-]+)$/)?.[1]).find(Boolean);
      if (!repo) continue;

      const nums = cells.filter((c) => NUM.test(c)).map(parseNum).filter((n) => n >= 1000);
      if (nums.length === 0) continue;

      // 严格解析先跑过了：同一天已有精确时刻的点就不要再补一个粗糙的
      if (hasPointOnDay(history, repo, briefDate)) continue;
      if (record(history, repo, iso, Math.max(...nums))) added += 1;
    }
  }
  return added;
}

function seed() {
  const history = loadHistory();
  const files = fs.readdirSync(briefsDir).filter((f) => f.endsWith(".html")).sort();
  // 必须分两趟跑完：某一期的精确快照表会给出更早日期的基线点（07-24 那期含 07-21 的时刻），
  // 若按文件逐期交替跑，处理 07-21 时那个精确点还不存在，兜底就会重复插一个粗糙点。
  let strict = 0;
  for (const file of files) strict += seedFromBrief(history, file);

  let loose = 0;
  for (const file of files) loose += seedLooseFromBrief(history, file);

  const withTable = files.filter(
    (f) => f.match(/(\d{4}-\d{2}-\d{2})/) &&
      Object.values(history.repos).some((pts) =>
        Object.keys(pts).some((iso) => cstDay(iso) === f.match(/(\d{4}-\d{2}-\d{2})/)[1]))
  ).length;
  const saved = saveHistory(history);
  const repos = Object.keys(saved.repos);
  console.log(`[seed] 扫描 ${files.length} 期，${withTable} 期含可解析的 star 表`);
  console.log(`[seed] 精确时刻数据点 ${strict} 个，按期次兜底 ${loose} 个`);
  console.log(`[seed] 覆盖 ${repos.length} 个仓库`);
  return saved;
}

// ---------------------------------------------------------------- update

async function fetchStars(repos) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-brief-archive/star-history",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const out = new Map();
  // search API 一次最多 5 个 repo: 限定符比较稳妥，分批查
  for (let i = 0; i < repos.length; i += 5) {
    const batch = repos.slice(i, i + 5);
    const q = batch.map((r) => `repo:${r}`).join(" ");
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.warn(`[update] 批次失败 ${res.status}：${batch.join(", ")}`);
      continue;
    }
    const data = await res.json();
    for (const item of data.items || []) out.set(item.full_name, item.stargazers_count);
    if (i + 5 < repos.length) await new Promise((r) => setTimeout(r, 2000));
  }
  return out;
}

async function update() {
  const history = loadHistory();
  const tracked = Object.keys(history.repos);
  if (tracked.length === 0) {
    console.error("[update] 历史为空，先跑 `seed`");
    process.exitCode = 1;
    return;
  }

  const stars = await fetchStars(tracked);
  if (stars.size === 0) {
    console.error("[update] 一个仓库都没抓到，不写入");
    process.exitCode = 1;
    return;
  }

  const iso = new Date().toISOString();
  for (const [repo, count] of stars) record(history, repo, iso, count);
  saveHistory(history);
  console.log(`[update] ${iso} 记录 ${stars.size}/${tracked.length} 个仓库`);
  if (stars.size < tracked.length) {
    const missing = tracked.filter((r) => !stars.has(r));
    console.warn(`[update] 缺失：${missing.join(", ")}`);
  }
}

// ---------------------------------------------------------------- delta

function latestTwo(points) {
  const stamps = Object.keys(points).sort();
  return stamps.length < 2 ? null : [stamps.at(-2), stamps.at(-1)];
}

function delta() {
  const history = loadHistory();
  const entries = Object.entries(history.repos);

  // 最新一次快照的时刻。只有出现在这次快照里的仓库才有资格进表——
  // 否则一个上次出现在 07-18 的仓库会把 8 天的增长混进 54 小时的窗口里。
  const latest = entries
    .flatMap(([, points]) => Object.keys(points))
    .sort()
    .at(-1);
  if (!latest) {
    console.log("还没有任何数据点。");
    return;
  }
  const latestDay = cstDay(latest);

  const rows = [];
  const stale = [];
  for (const [repo, points] of entries) {
    const stamps = Object.keys(points).sort();
    const curr = stamps.at(-1);
    if (cstDay(curr) !== latestDay) {
      stale.push(repo);
      continue;
    }
    const prev = stamps.at(-2);
    if (!prev) continue;
    rows.push({
      repo,
      prev: points[prev],
      curr: points[curr],
      diff: points[curr] - points[prev],
      hours: (new Date(curr) - new Date(prev)) / 3.6e6,
      from: prev,
    });
  }

  if (rows.length === 0) {
    console.log("最新快照里没有可比对的仓库（至少需要两次快照）。");
    return;
  }

  rows.sort((a, b) => b.diff - a.diff);
  const fmt = (n) => n.toLocaleString("en-US");
  const short = (iso) => new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

  console.log(`快照时刻：${short(latest)} CST\n`);
  console.log("| 仓库 | 上次 | 本次 | 增量 | 窗口 |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    const sign = r.diff > 0 ? "+" : "";
    console.log(
      `| ${r.repo} | ${fmt(r.prev)} | ${fmt(r.curr)} | ${sign}${fmt(r.diff)} | ${short(r.from)} 起 ${r.hours.toFixed(1)}h |`
    );
  }
  if (stale.length > 0) {
    console.log(`\n未纳入（本次快照未覆盖，共 ${stale.length} 个）：${stale.slice(0, 8).join("、")}${stale.length > 8 ? " …" : ""}`);
  }
}

// ---------------------------------------------------------------- main

/**
 * 从 stdin 读 {"owner/repo": stars} 并记为一个数据点。
 * 用于 api.github.com 不可达、但能通过别的通道拿到 star 数的场景。
 * 第二个参数可指定 ISO 时间戳，默认当前时刻。
 */
async function importPoint(iso) {
  const raw = await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });

  const parsed = JSON.parse(raw);
  const stamp = new Date(iso || Date.now()).toISOString();
  const history = loadHistory();
  let n = 0;
  for (const [repo, stars] of Object.entries(parsed)) {
    if (record(history, repo, stamp, Number(stars))) n += 1;
  }
  saveHistory(history);
  console.log(`[import] ${stamp} 记录 ${n} 个仓库`);
}

const cmd = process.argv[2];
if (cmd === "seed") seed();
else if (cmd === "update") await update();
else if (cmd === "delta") delta();
else if (cmd === "import") await importPoint(process.argv[3]);
else {
  console.error("用法: node scripts/star-history.mjs <seed|update|delta|import [ISO]>");
  process.exitCode = 1;
}
