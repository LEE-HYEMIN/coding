const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MOEL_BASE = "https://www.moel.go.kr";
const SNAPSHOT_YEARS = 3;
const VERCEL_FETCH_TIMEOUT_MS = Number(process.env.VERCEL_FETCH_TIMEOUT_MS || 9000);
const CACHE_TTL_MS = 15 * 60 * 1000;
const ORG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const YEARS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RELEASE_NEWS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_YEAR_SCAN_PAGES = 360;
const MAX_SELECTABLE_YEARS = 6;
const DETAIL_FETCH_CONCURRENCY = 4;
const NEWS_FETCH_CONCURRENCY = 3;
const NEWS_MAX_PER_RELEASE = 20;
const NEWS_MAX_AGE_DAYS = 90;
const NEWS_QUERY_MAX = 4;
const SAFETY_HQ_NAME = "산업안전보건본부";
const DEPARTMENT_ALIAS_RULES = new Map([
  ["화학사고예방조사과", ["화학사고예방조사과", "화학사고예방과"]],
  ["산업보건정책과", ["산업보건정책과", "산업보건기준과"]],
]);

const STOPWORDS = new Set([
  "고용노동부",
  "노동부",
  "보도자료",
  "참고",
  "관련",
  "통해",
  "위한",
  "이번",
  "발표",
  "강화",
  "점검",
  "감독",
  "추진",
  "지원",
  "현장",
]);

const cache = {
  byYear: new Map(),
  inFlightByYear: new Map(),
};

const orgCache = {
  data: null,
  fetchedAt: 0,
};

const yearsCache = {
  years: null,
  fetchedAt: 0,
};

const releaseNewsCache = {
  bySeq: new Map(),
  inFlightBySeq: new Map(),
};

function nowKstString() {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

function currentKstYear() {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date())
  );
}

function withTimeout(promise, timeoutMs, label = "timeout") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

function parseTargetYear(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  const nowYear = currentKstYear();
  if (!Number.isFinite(parsed)) return nowYear;
  if (parsed < 2015 || parsed > nowYear) return nowYear;
  return parsed;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

function parseDateText(value) {
  const text = normalizeText(value);
  if (!text) return null;

  const match = text.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]) - 1;
    const d = Number(match[3]);
    const date = new Date(Date.UTC(y, m, d));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function formatDate(date) {
  if (!date || Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}.${m}.${d}`;
}

function toAbsoluteUrl(url, baseUrl) {
  if (!url) return "";
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function hasAnyKeyword(text, keywords) {
  const value = normalizeText(text);
  return keywords.some((keyword) => value.includes(keyword));
}

function tokenize(text) {
  return normalizeText(text)
    .replace(/[\[\]{}()<>"'`“”‘’.,:;!?/\\|+=_*~\-]/g, " ")
    .split(/\s+/)
    .map((token) => normalizeText(token))
    .filter(Boolean)
    .filter((token) => token.length >= 2)
    .filter((token) => !/^\d+$/.test(token));
}

function buildPressSummary(title, content) {
  const ensureSentence = (text) => {
    const value = normalizeText(text);
    if (!value) return "";
    if (/[.!?…]$/.test(value)) return value;
    return `${value}.`;
  };

  const shortenHeadline = (text, max = 84) => {
    const value = normalizeText(text);
    if (value.length <= max) return value;
    const cut = value.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 28) return normalizeText(cut.slice(0, lastSpace));
    return normalizeText(cut);
  };

  const compactDetail = (text, max = 74) => {
    const value = normalizeText(text);
    if (!value) return "";
    if (value.length <= max) return value;
    const firstClause = normalizeText(value.split(/(?:,\s+|[;:])/)[0] || "");
    if (firstClause.length >= 18 && firstClause.length <= max) return firstClause;
    return "";
  };

  const buildGenericDetail = (headlineText) => {
    if (/(감독|점검|착수)/.test(headlineText)) {
      return "관련 사업장을 대상으로 안전수칙과 법 준수 여부를 집중 점검합니다.";
    }
    if (/(개최|공모|챌린지|캠페인)/.test(headlineText)) {
      return "참여 대상과 일정 등 세부 내용은 첨부된 PDF에서 확인할 수 있습니다.";
    }
    if (/(발표|공개|현황|통계)/.test(headlineText)) {
      return "핵심 수치와 세부 기준은 첨부된 PDF에서 확인할 수 있습니다.";
    }
    if (/지원/.test(headlineText)) {
      return "지원 대상과 신청 절차는 보도자료와 첨부 PDF에 안내되어 있습니다.";
    }
    if (/(예방|수칙|주의보|안전)/.test(headlineText)) {
      return "핵심 예방수칙과 현장 점검 포인트는 보도자료와 첨부 PDF에서 확인할 수 있습니다.";
    }
    return "";
  };

  const isReadableDetail = (text) => {
    const value = normalizeText(text);
    if (!value) return false;
    const bare = value.replace(/[.!?…]$/, "");
    if (/(하고|하며|하여|위해|관련|대해|통해|등과|등의|및)$/.test(bare)) return false;
    const openParens = (value.match(/\(/g) || []).length;
    const closeParens = (value.match(/\)/g) || []).length;
    if (openParens !== closeParens) return false;
    if (/\d+\.$/.test(value)) return false;
    return true;
  };

  const cleanTitle = normalizeText(title)
    .replace(/^\([^)]+\)\s*/, "")
    .replace(/^[-·•]\s*/, "");
  if (!cleanTitle) return "";

  const headline = ensureSentence(shortenHeadline(cleanTitle, 84));
  const cleanContent = normalizeText(content)
    .replace(/문\s*의\s*:[^]{0,260}$/i, "")
    .replace(/\(\s*KOSHA[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanContent) return headline;

  const sentences = cleanContent
    .replace(/고용노동부\(장관[^)]*\)/g, "고용노동부")
    .replace(/한국산업안전보건공단\(이사장[^)]*\)/g, "한국산업안전보건공단")
    .split(/(?<=[.!?])\s+|(?<=다\.)\s+|(?<=요\.)\s+|(?<=함\.)\s+|[\r\n]+|[□○◇◆▶▸]/)
    .map((sentence) =>
      normalizeText(sentence)
        .replace(/^[-·•]\s*/, "")
        .replace(/^(고용노동부|한국산업안전보건공단)\s*(는|은|이|가)?\s*/, "")
        .replace(/^(와|및)\s+/, "")
    )
    .filter(Boolean)
    .filter((sentence) => sentence.length >= 18)
    .filter((sentence) => !/^(문의|붙임|별첨|첨부)/.test(sentence));

  const clauses = sentences
    .flatMap((sentence) => sentence.split(/(?:,\s+|[;:])/))
    .map((item) => normalizeText(item))
    .filter((item) => item.length >= 18);

  const candidates = uniqueBy([...sentences, ...clauses], (item) => normalizeNameKey(item));
  const actionKeywords = /(착수|점검|감독|발표|공개|운영|개최|시행|강화|추진|지원)/;
  const normalizedTitle = normalizeNameKey(cleanTitle).slice(0, 20);
  const detailSentence =
    candidates
      .map((sentence) => {
        let score = 0;
        if (actionKeywords.test(sentence)) score += 4;
        if (/\d/.test(sentence)) score += 1;
        if (sentence.length >= 20 && sentence.length <= 48) score += 4;
        else if (sentence.length <= 70) score += 3;
        else if (sentence.length <= 90) score += 1;
        else score -= 3;
        if (/장관|이사장|대표|고용노동부|한국산업안전보건공단/.test(sentence)) score -= 1;
        const normalizedSentence = normalizeNameKey(sentence);
        if (normalizedTitle && normalizedSentence.includes(normalizedTitle)) score -= 3;
        return { sentence, score };
      })
      .sort((a, b) => b.score - a.score)[0]?.sentence || "";

  const part1 = headline;
  const fallbackDetail = buildGenericDetail(cleanTitle);
  const preferredDetail = ensureSentence(compactDetail(detailSentence, 74));
  const part2 = isReadableDetail(preferredDetail) ? preferredDetail : ensureSentence(fallbackDetail);
  const normalizedPart1 = normalizeNameKey(part1.replace(/[.]/g, "")).slice(0, 24);
  const normalizedPart2 = normalizeNameKey(part2.replace(/[.]/g, "")).slice(0, 24);

  const parts = [part1];
  if (part2 && normalizedPart1 !== normalizedPart2) {
    parts.push(part2);
  }

  return parts.join(" ");
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeNameKey(text) {
  return normalizeText(text).replace(/\s+/g, "").toLowerCase();
}

function isLeafDepartmentName(name) {
  return /(과|팀|담당관)$/.test(normalizeText(name));
}

function buildDepartmentNameMap(officialDepartments = []) {
  const map = new Map();

  for (const department of officialDepartments) {
    const key = normalizeNameKey(department);
    if (!key) continue;
    map.set(key, department);
  }

  for (const [canonical, aliases] of DEPARTMENT_ALIAS_RULES.entries()) {
    if (!officialDepartments.includes(canonical)) continue;
    for (const alias of aliases) {
      const key = normalizeNameKey(alias);
      if (!key) continue;
      map.set(key, canonical);
    }
  }

  return map;
}

async function mapLimit(items, limit, worker) {
  const result = [];
  let index = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      result[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return result;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "user-agent": USER_AGENT,
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      ...(options.headers || {}),
    };
    return await fetch(url, { ...options, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}, timeoutMs = 25000, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (!response.ok) {
        throw new Error(`요청 실패 (${response.status}) - ${url}`);
      }
      return response.text();
    } catch (error) {
      const isRetryable = error.cause?.code === "ECONNRESET" || error.cause?.code === "ECONNREFUSED";
      if (isRetryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

function parseMoelPressRows(html, pageUrl) {
  const $ = cheerio.load(html);
  const rows = [];

  $(".board_list tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const $anchor = $tr.find("a[href*='enewsView.do?news_seq']").first();
    if (!$anchor.length) return;

    const href = $anchor.attr("href") || "";
    const newsSeq = (href.match(/news_seq=(\d+)/) || [])[1] || "";
    const title = normalizeText($anchor.attr("title") || $anchor.text());
    const dateText = normalizeText($tr.find("td").eq(3).text());
    const dateObj = parseDateText(dateText);

    rows.push({
      newsSeq,
      title,
      date: dateObj ? formatDate(dateObj) : dateText,
      dateObj,
      url: toAbsoluteUrl(href, pageUrl),
    });
  });

  return rows;
}

async function fetchMoelPressRowsForYear(targetYear, maxPages = MAX_YEAR_SCAN_PAGES) {
  const rows = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${MOEL_BASE}/news/enews/report/enewsList.do?pageIndex=${page}`;
    const html = await fetchText(url);
    const pageRows = parseMoelPressRows(html, url);
    if (!pageRows.length) break;

    for (const row of pageRows) {
      const year = row.dateObj ? row.dateObj.getUTCFullYear() : null;
      if (year === targetYear) {
        rows.push(row);
      }
    }

    const knownYears = pageRows
      .map((row) => (row.dateObj ? row.dateObj.getUTCFullYear() : null))
      .filter((year) => Number.isFinite(year));

    if (knownYears.length && Math.max(...knownYears) < targetYear) {
      break;
    }
  }

  return uniqueBy(rows, (item) => item.newsSeq || item.url).sort((a, b) => {
    const aDate = a.dateObj ? a.dateObj.getTime() : 0;
    const bDate = b.dateObj ? b.dateObj.getTime() : 0;
    return bDate - aDate;
  });
}

async function fetchAvailablePressYears(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    yearsCache.years &&
    now - yearsCache.fetchedAt < YEARS_CACHE_TTL_MS &&
    yearsCache.years.length
  ) {
    return yearsCache.years;
  }

  const years = new Set();
  for (let page = 1; page <= MAX_YEAR_SCAN_PAGES; page += 1) {
    const url = `${MOEL_BASE}/news/enews/report/enewsList.do?pageIndex=${page}`;
    const html = await fetchText(url);
    const pageRows = parseMoelPressRows(html, url);
    if (!pageRows.length) break;

    for (const row of pageRows) {
      if (!row.dateObj) continue;
      years.add(row.dateObj.getUTCFullYear());
    }

    if (years.size >= MAX_SELECTABLE_YEARS) break;
  }

  const sortedYears = [...years]
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => b - a)
    .slice(0, MAX_SELECTABLE_YEARS);

  const fallbackYear = currentKstYear();
  yearsCache.years = sortedYears.length ? sortedYears : [fallbackYear];
  yearsCache.fetchedAt = now;
  return yearsCache.years;
}

async function fetchSafetyHqOrganization(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    orgCache.data &&
    now - orgCache.fetchedAt < ORG_CACHE_TTL_MS &&
    orgCache.data.departments.length
  ) {
    return orgCache.data;
  }

  const listUrl = `${MOEL_BASE}/agency/org/ministry/list.do`;
  const html = await fetchText(listUrl);
  const $ = cheerio.load(html);

  const candidateRoots = [];
  $("a").each((_, anchor) => {
    const name = normalizeText($(anchor).text());
    const $parent = $(anchor).parent();
    const isHqAnchor =
      name === SAFETY_HQ_NAME &&
      $parent.hasClass("org-item") &&
      $parent.parent().hasClass("org2");

    if (isHqAnchor) {
      candidateRoots.push($parent.parent());
    }
  });

  if (!candidateRoots.length) {
    throw new Error("산업안전보건본부 조직 노드를 찾지 못했습니다.");
  }

  const rootOrgNode = candidateRoots.sort((a, b) => {
    const aCount = $(a).find(".org-sub > ul > li > a").length;
    const bCount = $(b).find(".org-sub > ul > li > a").length;
    return bCount - aCount;
  })[0];

  const groups = [];
  const $root = $(rootOrgNode);
  $root.find("> .org4-ul > .org4").each((_, org4) => {
    const $org4 = $(org4);
    const topUnit = normalizeText($org4.children(".org-item").first().text());
    if (!topUnit) return;

    $org4.children(".org-sub").each((__, orgSub) => {
      const $orgSub = $(orgSub);
      const subUnit = normalizeText($orgSub.find("> .org-sub-item a").first().text());

      const departments = [];
      $orgSub.find("> ul > li > a").each((___, anchor) => {
        const name = normalizeText($(anchor).text());
        if (!name || !isLeafDepartmentName(name)) return;
        departments.push(name);
      });

      const uniqueDepartments = uniqueBy(departments, (name) => normalizeNameKey(name));
      if (!uniqueDepartments.length) return;

      groups.push({
        id: `${topUnit}::${subUnit || "direct"}`,
        topUnit,
        subUnit: subUnit || "",
        departments: uniqueDepartments,
      });
    });
  });

  const departments = uniqueBy(groups.flatMap((group) => group.departments), (name) => normalizeNameKey(name));
  if (!departments.length || !groups.length) {
    throw new Error("산업안전보건본부 공식 소속과 목록을 찾지 못했습니다.");
  }

  orgCache.data = {
    groups,
    departments,
  };
  orgCache.fetchedAt = now;
  return orgCache.data;
}

async function fetchMoelPressDetail(newsSeq) {
  const url = `${MOEL_BASE}/news/enews/report/enewsView.do?news_seq=${newsSeq}`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const info = {};
  $(".b_info dl").each((_, dl) => {
    const key = normalizeText($(dl).find("dt").first().text());
    const value = normalizeText($(dl).find("dd").first().text());
    if (key) info[key] = value;
  });

  const title = normalizeText(info["제목"] || $(".b_info dd").first().text());
  const dateText = normalizeText(info["등록일"] || $(".b_info dd").eq(1).text());
  const dateObj = parseDateText(dateText);
  const content =
    normalizeText($(".b_content.news_content").text()) || normalizeText($(".b_content").first().text());

  const parsePreviewUrl = (onclick) => {
    const match = (onclick || "").match(/gfnPreView\('([^']+)'\)/);
    if (!match) return "";
    return toAbsoluteUrl(match[1], MOEL_BASE);
  };

  const viewerFiles = [];
  $(".board_view_wrap .file .list li").each((index, li) => {
    const $li = $(li);
    const nameFromLink = normalizeText($li.find(".link a:not(.btn_line)").first().text());
    const nameFromTitle = normalizeText(
      ($li.find("a[title*='다운로드']").first().attr("title") || "").replace(/\s*다운로드\s*$/i, "")
    );
    const fileName =
      nameFromLink ||
      nameFromTitle ||
      `첨부파일 ${index + 1}`;
    const downloadHref = normalizeText($li.find("a[href*='/common/downloadFile.do']").first().attr("href") || "");
    const previewOnclick = normalizeText($li.find("a.attachPreview").first().attr("onclick") || "");

    const downloadUrl = downloadHref ? toAbsoluteUrl(downloadHref, MOEL_BASE) : "";
    const previewUrl = parsePreviewUrl(previewOnclick);
    const isPdf =
      /\.pdf($|[?&])/i.test(fileName) ||
      /file_ext=pdf/i.test(downloadHref) ||
      /\.pdf($|[?&])/i.test(downloadUrl);

    if (!isPdf) return;
    if (!downloadUrl && !previewUrl) return;
    viewerFiles.push({
      name: fileName,
      previewUrl,
      downloadUrl,
    });
  });

  return {
    newsSeq,
    title,
    publishedAt: dateObj ? formatDate(dateObj) : dateText,
    publishedAtObj: dateObj,
    url,
    content,
    summary: buildPressSummary(title, content),
    viewerFiles: uniqueBy(viewerFiles, (item) => `${item.name}-${item.previewUrl}-${item.downloadUrl}`),
  };
}

function extractDepartmentsFromContent(content) {
  const text = normalizeText(content);
  const inquiryMatch = text.match(/문\s*의\s*:\s*([^]{0,260})/i);
  const inquiryText = inquiryMatch ? normalizeText(inquiryMatch[1]).slice(0, 260) : "";
  const matches = inquiryText.match(/[가-힣A-Za-z·]+(?:과|관|팀|담당관)/g) || [];
  return uniqueBy(matches.map((item) => normalizeText(item)), (item) => item);
}

function findMatchedSafetyDepartments(press, departments, officialDeptMap) {
  const matched = [];
  const reasons = new Map();
  const matchedKeys = new Set();

  const addMatch = (department, reason) => {
    const canonical = normalizeText(department);
    const canonicalKey = normalizeNameKey(canonical);
    if (!canonicalKey) return;
    if (!matchedKeys.has(canonicalKey)) {
      matched.push(canonical);
      matchedKeys.add(canonicalKey);
    }
    const reasonSet = reasons.get(canonical) || new Set();
    reasonSet.add(reason);
    reasons.set(canonical, reasonSet);
  };

  for (const department of departments) {
    const key = normalizeNameKey(department);
    if (!officialDeptMap.has(key)) continue;
    addMatch(officialDeptMap.get(key), "official-department");
  }

  const normalizedText = normalizeNameKey(`${press.title} ${press.content}`);
  for (const [key, officialName] of officialDeptMap.entries()) {
    if (!normalizedText.includes(key)) continue;
    addMatch(officialName, "official-name-in-text");
  }

  return {
    departments: matched,
    reasons: Object.fromEntries(
      [...reasons.entries()].map(([department, reasonSet]) => [department, [...reasonSet].join("+")])
    ),
  };
}

function buildRelevanceKeywords(press) {
  const titleTokens = tokenize(press.title)
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 8);

  const departmentTokens = tokenize(press.department)
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 3);

  const contentTokens = tokenize(press.content).filter((token) => !STOPWORDS.has(token));
  const freq = new Map();
  for (const token of contentTokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  const contentTop = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, 8);

  return uniqueBy([...titleTokens, ...departmentTokens, ...contentTop], (token) => token).slice(0, 20);
}

function buildNewsQueries(press) {
  const cleanedTitle = normalizeText(press.title).replace(/["“”'‘’]/g, "");
  const shortTitle = cleanedTitle.slice(0, 70);
  const keywords = buildRelevanceKeywords(press);
  const departmentText = normalizeText(press.department);
  const deptLeadToken = tokenize(departmentText).find((token) => token.length >= 2) || "";
  const contentTokens = tokenize(press.content).filter((token) => !STOPWORDS.has(token));
  const contentLead = uniqueBy(contentTokens, (item) => item).slice(0, 4);

  const queries = [];
  if (shortTitle) queries.push(`${shortTitle} 고용노동부`);
  if (keywords.length) queries.push(`${keywords.slice(0, 6).join(" ")} 고용노동부`);
  if (deptLeadToken || contentLead.length) {
    queries.push(`${[deptLeadToken, ...contentLead].filter(Boolean).join(" ")} 고용노동부`);
  }

  return uniqueBy(queries.map((item) => normalizeText(item)).filter(Boolean), (item) => item).slice(0, NEWS_QUERY_MAX);
}

async function fetchNaverNewsByQuery(query) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("네이버 API 키가 설정되지 않았습니다.");

  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=20&sort=sim`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });
  if (!response.ok) throw new Error(`네이버 API 요청 실패 (${response.status})`);

  const json = await response.json();
  const rows = [];

  const decodeHtml = (str) =>
    str.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'");

  for (const item of json.items || []) {
    const title = normalizeText(decodeHtml(item.title || ""));
    const description = normalizeText(decodeHtml(item.description || ""));
    const pubDateObj = parseDateText(item.pubDate);
    if (!title || !item.link) continue;

    let source = "네이버 뉴스";
    try {
      if (item.originallink) source = new URL(item.originallink).hostname.replace(/^www\./, "");
    } catch {}

    rows.push({
      source: normalizeText(source),
      title,
      description,
      publishedAt: pubDateObj ? formatDate(pubDateObj) : item.pubDate,
      publishedAtObj: pubDateObj,
      url: item.link,
    });
  }

  return uniqueBy(rows, (item) => `${item.title}-${item.source}-${item.publishedAt}-${item.url}`);
}

function countKeywordHits(text, keywords) {
  const value = normalizeText(text).toLowerCase();
  if (!value) return 0;
  const matched = new Set();
  for (const keyword of keywords) {
    const token = normalizeText(keyword).toLowerCase();
    if (!token || token.length < 2) continue;
    if (value.includes(token)) matched.add(token);
  }
  return matched.size;
}

function countTokenOverlap(text, tokenSet) {
  const tokens = tokenize(text).filter((token) => !STOPWORDS.has(token));
  let overlap = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) overlap += 1;
  }
  return overlap;
}

function scoreNewsItem(newsItem, keywords, press, pressTokenSet) {
  const title = normalizeText(newsItem.title);
  const description = normalizeText(newsItem.description);
  const merged = `${title} ${description}`;

  const titleHitCount = countKeywordHits(title, keywords);
  const descriptionHitCount = countKeywordHits(description, keywords);
  const overlapCount = countTokenOverlap(merged, pressTokenSet);

  let score = 0;
  score += Math.min(titleHitCount, 8) * 2;
  score += Math.min(descriptionHitCount, 8);
  score += Math.min(overlapCount, 10);
  if (titleHitCount >= 2) score += 2;
  if (descriptionHitCount >= 2) score += 1;
  if (overlapCount >= 4) score += 2;

  const deptText = normalizeText(press.department);
  const deptToken = tokenize(deptText).find((token) => token.length >= 2) || "";
  const mergedLower = merged.toLowerCase();
  if (deptToken && mergedLower.includes(deptToken.toLowerCase())) score += 1;
  if (mergedLower.includes("고용노동부")) score += 1;
  return score;
}

function filterAndRankNews(press, newsItems) {
  const keywords = buildRelevanceKeywords(press);
  const pressTokens = uniqueBy(
    tokenize(`${press.title} ${press.department} ${press.content}`)
      .filter((token) => !STOPWORDS.has(token))
      .slice(0, 60),
    (item) => item
  );
  const pressTokenSet = new Set(pressTokens);
  const startDate = press.publishedAtObj;
  const endDate = startDate ? addDays(startDate, NEWS_MAX_AGE_DAYS) : null;

  const scored = newsItems.map((item) => ({
    ...item,
    score: scoreNewsItem(item, keywords, press, pressTokenSet),
  }));

  const applyDateFilter = (rows) =>
    rows.filter((row) => {
      if (!row.publishedAtObj) return true;
      if (startDate && row.publishedAtObj < startDate) return false;
      if (endDate && row.publishedAtObj > endDate) return false;
      return true;
    });

  let filtered = applyDateFilter(scored.filter((row) => row.score >= 8));
  if (filtered.length < 4) filtered = applyDateFilter(scored.filter((row) => row.score >= 6));
  if (filtered.length < 2) filtered = applyDateFilter(scored.filter((row) => row.score >= 4));
  if (!filtered.length) filtered = applyDateFilter(scored.filter((row) => row.score >= 2));

  return filtered
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const aDate = a.publishedAtObj ? a.publishedAtObj.getTime() : 0;
      const bDate = b.publishedAtObj ? b.publishedAtObj.getTime() : 0;
      return bDate - aDate;
    })
    .slice(0, NEWS_MAX_PER_RELEASE)
    .map((item) => ({
      source: item.source,
      title: item.title,
      publishedAt: item.publishedAt,
      url: item.url,
      relevanceScore: item.score,
    }));
}

async function collectRelatedNews(press) {
  const queries = buildNewsQueries(press);
  if (!queries.length) return [];

  const queryResults = await mapLimit(queries, Math.min(queries.length, NEWS_QUERY_MAX), async (query) => {
    try {
      return await fetchNaverNewsByQuery(query);
    } catch {
      return [];
    }
  });

  const merged = uniqueBy(queryResults.flat(), (item) => `${item.title}-${item.source}-${item.publishedAt}`);
  return filterAndRankNews(press, merged);
}

async function collectSafetyHeadquartersPress(targetYear) {
  const organization = await fetchSafetyHqOrganization();
  const officialDepartments = organization.departments || [];
  const officialDeptMap = buildDepartmentNameMap(officialDepartments);

  const listRows = await fetchMoelPressRowsForYear(targetYear, MAX_YEAR_SCAN_PAGES);
  const candidates = listRows;

  const detailed = (
    await mapLimit(candidates, DETAIL_FETCH_CONCURRENCY, async (row) => {
      try {
        const detail = await fetchMoelPressDetail(row.newsSeq);
        const departments = extractDepartmentsFromContent(detail.content);
        const match = findMatchedSafetyDepartments(detail, departments, officialDeptMap);

        if (!match.departments.length) {
          return null;
        }

        return {
          newsSeq: detail.newsSeq,
          title: detail.title,
          departments: match.departments,
          departmentCandidates: departments,
          classificationReasonByDepartment: match.reasons,
          publishedAt: detail.publishedAt,
          publishedAtObj: detail.publishedAtObj,
          url: detail.url,
          viewerFiles: detail.viewerFiles || [],
        };
      } catch {
        return null;
      }
    })
  ).filter(Boolean);

  const sortedByLatest = [...detailed].sort((a, b) => {
    const aDate = a.publishedAtObj ? a.publishedAtObj.getTime() : 0;
    const bDate = b.publishedAtObj ? b.publishedAtObj.getTime() : 0;
    return bDate - aDate;
  });

  const departmentReleaseMap = new Map(officialDepartments.map((name) => [name, []]));
  for (const item of sortedByLatest) {
    const viewer = (item.viewerFiles || [])[0] || {};
    for (const department of item.departments || []) {
      if (!departmentReleaseMap.has(department)) continue;
      const list = departmentReleaseMap.get(department);
      if (list.some((row) => row.newsSeq === item.newsSeq)) continue;
      list.push({
        newsSeq: item.newsSeq,
        title: item.title,
        publishedAt: item.publishedAt,
        url: item.url,
        previewUrl: viewer.previewUrl || "",
        downloadUrl: viewer.downloadUrl || "",
        viewerFileName: viewer.name || "",
        coDepartments: item.departments || [],
      });
    }
  }

  const departmentStats = officialDepartments.map((department) => ({
    department,
    count: departmentReleaseMap.get(department)?.length || 0,
  }));

  const organizationGroups = (organization.groups || []).map((group) => ({
    id: group.id,
    topUnit: group.topUnit,
    subUnit: group.subUnit,
    departments: group.departments.map((department) => ({
      department,
      count: departmentReleaseMap.get(department)?.length || 0,
    })),
  }));

  const latestByDepartment = officialDepartments
    .map((department) => {
      const latest = departmentReleaseMap.get(department)?.[0];
      if (!latest) return null;
      return {
        department,
        title: latest.title,
        publishedAt: latest.publishedAt,
        url: latest.url,
      };
    })
    .filter(Boolean);

  const departmentReleases = {};
  for (const department of officialDepartments) {
    departmentReleases[department] = departmentReleaseMap.get(department) || [];
  }

  return {
    items: latestByDepartment,
    officialDepartments,
    organizationGroups,
    departmentStats,
    departmentReleases,
    yearlyReleaseCount: detailed.length,
    scannedYearRows: listRows.length,
  };
}

async function getOrganizationWithSnapshotFallback() {
  // 캐시에 이미 있으면 바로 반환
  if (orgCache.data && orgCache.data.departments.length) {
    return orgCache.data;
  }
  // 스냅샷에서 조직정보 로드 시도 (moel.go.kr 요청 없이)
  const currentYear = currentKstYear();
  for (const year of [currentYear, currentYear - 1, currentYear - 2]) {
    const snapshot = await loadDashboardSnapshot(year);
    if (snapshot?.officialDepartments?.length) {
      const org = { departments: snapshot.officialDepartments };
      orgCache.data = org;
      orgCache.fetchedAt = Date.now();
      return org;
    }
  }
  // 스냅샷도 없으면 실시간 수집
  return fetchSafetyHqOrganization().catch(() => ({ departments: [] }));
}

async function buildReleaseNewsData(newsSeq) {
  const [organization, detail] = await Promise.all([
    getOrganizationWithSnapshotFallback(),
    fetchMoelPressDetail(newsSeq),
  ]);
  const officialDeptMap = buildDepartmentNameMap(organization.departments || []);

  const departments = extractDepartmentsFromContent(detail.content);
  const match = findMatchedSafetyDepartments(detail, departments, officialDeptMap);
  const matchedDepartments = match.departments || [];

  const relatedNews = await collectRelatedNews({
    title: detail.title,
    content: detail.content,
    department: matchedDepartments.join(" "),
    publishedAtObj: detail.publishedAtObj,
  });

  return {
    newsSeq: detail.newsSeq,
    title: detail.title,
    publishedAt: detail.publishedAt,
    url: detail.url,
    previewUrl: detail.viewerFiles?.[0]?.previewUrl || "",
    downloadUrl: detail.viewerFiles?.[0]?.downloadUrl || "",
    viewerFileName: detail.viewerFiles?.[0]?.name || "",
    departments: matchedDepartments,
    relatedNewsCount: relatedNews.length,
    relatedNews,
  };
}

async function getReleaseNewsData(newsSeq, forceRefresh = false) {
  const key = String(newsSeq);
  const now = Date.now();

  const cached = releaseNewsCache.bySeq.get(key);
  if (!forceRefresh && cached && now - cached.updatedAt < RELEASE_NEWS_CACHE_TTL_MS) {
    return cached.data;
  }

  if (releaseNewsCache.inFlightBySeq.has(key)) {
    return releaseNewsCache.inFlightBySeq.get(key);
  }

  const inFlight = buildReleaseNewsData(key)
    .then((data) => {
      releaseNewsCache.bySeq.set(key, {
        data,
        updatedAt: Date.now(),
      });
      return data;
    })
    .finally(() => {
      releaseNewsCache.inFlightBySeq.delete(key);
    });

  releaseNewsCache.inFlightBySeq.set(key, inFlight);
  return inFlight;
}

async function buildDashboardData(targetYear, forceRefresh = false) {
  const notes = [];
  const selectedYear = parseTargetYear(targetYear);
  let availableYears = [selectedYear];
  try {
    availableYears = await fetchAvailablePressYears(forceRefresh);
  } catch (error) {
    notes.push(`연도 목록 수집 실패: ${error.message}`);
  }

  if (!availableYears.includes(selectedYear)) {
    availableYears.push(selectedYear);
    availableYears.sort((a, b) => b - a);
  }

  let items = [];
  let officialDepartments = [];
  let organizationGroups = [];
  let departmentStats = [];
  let departmentReleases = {};
  let yearlyReleaseCount = 0;
  let scannedYearRows = 0;

  try {
    const result = await collectSafetyHeadquartersPress(selectedYear);
    items = result.items || [];
    officialDepartments = result.officialDepartments || [];
    organizationGroups = result.organizationGroups || [];
    departmentStats = result.departmentStats || [];
    departmentReleases = result.departmentReleases || {};
    yearlyReleaseCount = result.yearlyReleaseCount || 0;
    scannedYearRows = result.scannedYearRows || 0;
  } catch (error) {
    notes.push(`데이터 수집 실패: ${error.message}`);
  }

  notes.push("보도자료는 고용노동부 공식 보도자료 목록에서 수집합니다.");
  notes.push("조직 기준은 기관소개 > 조직안내 > 본부 > 산업안전보건본부 구조를 사용합니다.");
  notes.push("보도자료가 여러 과에서 공동 작성된 경우, 해당 보도자료를 관련 모든 과에 반영합니다.");
  notes.push("최근 3년 간 과별 보도자료 건수와 목록(발행일/제목)을 제공합니다.");
  if (!yearlyReleaseCount) {
    notes.push(`${selectedYear}년에 산업안전보건본부 소속과로 분류된 보도자료가 확인되지 않았습니다.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    generatedAtKst: nowKstString(),
    selectedYear,
    availableYears,
    source: {
      name: "고용노동부 보도자료",
      url: `${MOEL_BASE}/news/enews/report/enewsList.do`,
    },
    totalCount: items.length,
    yearlyReleaseCount,
    scannedYearRows,
    items,
    officialDepartments,
    organizationGroups,
    departmentStats,
    departmentReleases,
    notes,
  };
}

async function loadDashboardSnapshot(year) {
  try {
    const filePath = path.join(__dirname, "snapshots", `dashboard-${year}.json`);
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    return data;
  } catch {
    return null;
  }
}

async function getDashboardData(targetYear, forceRefresh = false) {
  const selectedYear = parseTargetYear(targetYear);
  const key = String(selectedYear);
  const now = Date.now();
  const onVercel = Boolean(process.env.VERCEL);

  const cached = cache.byYear.get(key);
  if (!forceRefresh && cached && now - cached.updatedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  if (cache.inFlightByYear.has(key)) {
    return cache.inFlightByYear.get(key);
  }

  const fallbackSnapshot = await loadDashboardSnapshot(selectedYear);

  // Vercel 환경: 스냅샷이 있으면 즉시 반환 (타임아웃 위험 없음)
  if (onVercel && fallbackSnapshot && !forceRefresh) {
    return fallbackSnapshot;
  }

  const inFlight = (async () => {
    try {
      if (onVercel) {
        return await withTimeout(
          buildDashboardData(selectedYear, forceRefresh),
          VERCEL_FETCH_TIMEOUT_MS,
          "dashboard-fetch-timeout"
        );
      }
      return await buildDashboardData(selectedYear, forceRefresh);
    } catch (error) {
      if (fallbackSnapshot) {
        const notes = [...(fallbackSnapshot.notes || [])];
        notes.unshift(`실시간 수집 실패로 스냅샷 데이터를 표시합니다. (${error.message})`);
        return { ...fallbackSnapshot, notes };
      }
      throw error;
    }
  })()
    .then((data) => {
      cache.byYear.set(key, { data, updatedAt: Date.now() });
      return data;
    })
    .finally(() => {
      cache.inFlightByYear.delete(key);
    });

  cache.inFlightByYear.set(key, inFlight);
  return inFlight;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: new Date().toISOString() });
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1";
    const data = await getDashboardData(req.query.year, forceRefresh);
    res.json(data);
  } catch (error) {
    console.error("[dashboard] failed:", error);
    res.status(500).json({
      error: "대시보드 데이터를 불러오지 못했습니다.",
      detail: error.message,
    });
  }
});

app.get("/api/release-news", async (req, res) => {
  try {
    const newsSeq = normalizeText(req.query.newsSeq);
    if (!/^\d+$/.test(newsSeq)) {
      res.status(400).json({ error: "유효한 news_seq 값이 필요합니다." });
      return;
    }

    const forceRefresh = req.query.refresh === "1";
    const onVercel = Boolean(process.env.VERCEL);
    const data = onVercel
      ? await withTimeout(getReleaseNewsData(newsSeq, forceRefresh), VERCEL_FETCH_TIMEOUT_MS, "release-news-timeout")
      : await getReleaseNewsData(newsSeq, forceRefresh);
    res.json(data);
  } catch (error) {
    console.error("[release-news] failed:", error);
    res.status(500).json({
      error: "관련 뉴스 데이터를 불러오지 못했습니다.",
      detail: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
