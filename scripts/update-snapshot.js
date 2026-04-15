/**
 * 현재 연도 스냅샷 업데이트 스크립트
 * - 기존 스냅샷을 읽어 이미 수집된 newsSeq 목록을 파악
 * - 최근 5페이지만 스캔해서 새 항목만 상세 수집
 * - 기존 데이터와 병합 후 저장
 *
 * ⚠️ 부서 매칭 로직(extractDepartmentsFromContent, findMatchedSafetyDepartments,
 *    buildDepartmentNameMap)은 server.js와 동일하게 유지해야 합니다.
 *    server.js를 수정할 때 이 파일도 함께 수정하세요.
 */

const path = require("path");
const fs = require("fs/promises");
const cheerio = require("cheerio");

const MOEL_BASE = "https://www.moel.go.kr";
const SNAPSHOT_DIR = path.join(__dirname, "../snapshots");
const SCAN_PAGES = 5;
const DETAIL_CONCURRENCY = 4;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SAFETY_HQ_NAME = "산업안전보건본부";
const DEPARTMENT_ALIAS_RULES = new Map([
  ["화학사고예방조사과", ["화학사고예방조사과", "화학사고예방과"]],
  ["산업보건정책과", ["산업보건정책과", "산업보건기준과"]],
]);

// ─── 유틸리티 ────────────────────────────────────────────────────────────────

function currentKstYear() {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date())
  );
}

function nowKstString() {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

function normalizeText(v) {
  return (v || "").replace(/\s+/g, " ").trim();
}

function normalizeNameKey(text) {
  return normalizeText(text).replace(/\s+/g, "").toLowerCase();
}

function toAbsoluteUrl(url, baseUrl) {
  if (!url) return "";
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
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

function parseDateText(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const match = text.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return isNaN(date.getTime()) ? null : date;
  }
  const fallback = new Date(text);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function formatDate(date) {
  if (!date) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

// ─── 요약 생성 (server.js의 buildPressSummary와 동일) ───────────────────────

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

// ─── 조직 매핑 (server.js의 buildDepartmentNameMap과 동일) ──────────────────

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

// ─── 부서 매칭 (server.js의 extractDepartmentsFromContent, findMatchedSafetyDepartments와 동일) ─

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

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchText(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, "accept-language": "ko-KR,ko;q=0.9" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (e) {
      clearTimeout(timer);
      const retryable = e.cause?.code === "ECONNRESET" || e.cause?.code === "ECONNREFUSED" || e.name === "AbortError";
      if (retryable && attempt < retries) {
        const delay = 1000 * (attempt + 1);
        console.log(`재시도 ${attempt + 1}/${retries} (${delay}ms 후): ${url}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function mapLimit(items, limit, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

// ─── 보도자료 목록 ────────────────────────────────────────────────────────────

async function fetchPressRows(targetYear, maxPages) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${MOEL_BASE}/news/enews/report/enewsList.do?pageIndex=${page}`;
    try {
      const html = await fetchText(url);
      const $ = cheerio.load(html);
      let foundOlderYear = false;
      $("table tbody tr, .board_list tbody tr").each((_, tr) => {
        const $tr = $(tr);
        const $anchor = $tr.find("a[href*='enewsView']").first();
        const href = $anchor.attr("href") || "";
        const newsSeq = (href.match(/news_seq=(\d+)/) || [])[1] || "";
        const $tds = $tr.find("td");
        // td 구조: [번호, 제목, 첨부, 날짜, 조회수] — 날짜는 뒤에서 두 번째
        const dateText = normalizeText($tds.eq($tds.length - 2).text());
        const dateObj = parseDateText(dateText);
        if (!newsSeq) return;
        if (dateObj && dateObj.getUTCFullYear() < targetYear) { foundOlderYear = true; return; }
        if (dateObj && dateObj.getUTCFullYear() > targetYear) return;
        rows.push({
          newsSeq,
          title: normalizeText($anchor.text()),
          date: dateObj ? formatDate(dateObj) : dateText,
          dateObj,
          url: `${MOEL_BASE}/news/enews/report/enewsView.do?news_seq=${newsSeq}`,
        });
      });
      if (foundOlderYear) break;
    } catch (e) {
      console.error(`페이지 ${page} 수집 실패:`, e.message);
    }
  }
  return rows;
}

// ─── 보도자료 상세 (server.js의 fetchMoelPressDetail과 동일) ─────────────────

async function fetchPressDetail(newsSeq) {
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
    const fileName = nameFromLink || nameFromTitle || `첨부파일 ${index + 1}`;
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
    viewerFiles.push({ name: fileName, previewUrl, downloadUrl });
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

// ─── 조직 수집 (server.js의 fetchSafetyHqOrganization과 동일) ────────────────

async function fetchOrganization() {
  const html = await fetchText(`${MOEL_BASE}/agency/org/ministry/list.do`);
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

  const departments = uniqueBy(
    groups.flatMap((group) => group.departments),
    (name) => normalizeNameKey(name)
  );

  if (!departments.length || !groups.length) {
    throw new Error("산업안전보건본부 공식 소속과 목록을 찾지 못했습니다.");
  }

  return { groups, departments };
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const targetYear = currentKstYear();
  const snapshotPath = path.join(SNAPSHOT_DIR, `dashboard-${targetYear}.json`);

  // 기존 스냅샷 로드
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    console.log(`기존 스냅샷 로드: ${existing.items?.length || 0}건`);
  } catch {
    console.log("기존 스냅샷 없음, 새로 생성합니다.");
  }

  // 이미 수집된 newsSeq 목록
  const existingSeqs = new Set(
    (existing?.departmentReleases
      ? Object.values(existing.departmentReleases).flat().map((i) => i.newsSeq)
      : []
    ).filter(Boolean)
  );
  console.log(`기존 수집 건수: ${existingSeqs.size}건`);

  // 최근 페이지 스캔
  console.log(`최근 ${SCAN_PAGES}페이지 스캔 중...`);
  const rows = await fetchPressRows(targetYear, SCAN_PAGES);
  const newRows = rows.filter((r) => !existingSeqs.has(r.newsSeq));
  console.log(`전체: ${rows.length}건, 신규: ${newRows.length}건`);

  // 조직 정보 수집
  let orgData = null;
  if (existing?.officialDepartments?.length) {
    // 기존 스냅샷에서 조직 정보 재사용 (moel.go.kr 요청 절약)
    const existingGroups = existing.organizationGroups?.map((g) => ({
      id: g.id,
      topUnit: g.topUnit,
      subUnit: g.subUnit,
      departments: (g.departments || []).map((d) => (typeof d === "string" ? d : d.department)),
    })) || [];
    orgData = { departments: existing.officialDepartments, groups: existingGroups };
    console.log(`조직 정보 스냅샷에서 재사용: 부서 ${orgData.departments.length}개`);
  } else {
    console.log("조직 정보 수집 중...");
    orgData = await fetchOrganization();
    console.log(`부서 ${orgData.departments.length}개 수집`);
  }

  const { departments, groups } = orgData;
  const officialDeptMap = buildDepartmentNameMap(departments);

  // 기존 departmentReleases 복사 (항상 재계산 기준)
  const departmentReleases = existing?.departmentReleases
    ? JSON.parse(JSON.stringify(existing.departmentReleases))
    : {};

  for (const dept of departments) {
    if (!departmentReleases[dept]) departmentReleases[dept] = [];
  }

  // 신규 항목 상세 수집 및 병합
  let newDetailsCount = 0;
  if (newRows.length) {
    const newDetails = (await mapLimit(newRows, DETAIL_CONCURRENCY, async (row) => {
      try {
        const detail = await fetchPressDetail(row.newsSeq);
        // 보도자료 본문에서 "문의:" 섹션 추출 후 공식 부서명 매칭
        const extractedDepts = extractDepartmentsFromContent(detail.content);
        const { departments: matched } = findMatchedSafetyDepartments(
          { title: detail.title, content: detail.content },
          extractedDepts,
          officialDeptMap
        );
        if (!matched.length) return null;
        return { ...detail, departments: matched, publishedAt: row.date || detail.publishedAt };
      } catch (e) {
        console.error(`상세 수집 실패 (${row.newsSeq}):`, e.message);
        return null;
      }
    })).filter(Boolean);
    newDetailsCount = newDetails.length;
    console.log(`신규 항목 중 매칭: ${newDetailsCount}건`);

    for (const detail of newDetails) {
      const viewer = (detail.viewerFiles || [])[0] || {};
      for (const dept of detail.departments) {
        if (!departmentReleases[dept]) departmentReleases[dept] = [];
        const alreadyExists = departmentReleases[dept].some((i) => i.newsSeq === detail.newsSeq);
        if (!alreadyExists) {
          departmentReleases[dept].unshift({
            newsSeq: detail.newsSeq,
            title: detail.title,
            publishedAt: detail.publishedAt,
            url: detail.url,
            previewUrl: viewer.previewUrl || "",
            downloadUrl: viewer.downloadUrl || "",
            viewerFileName: viewer.name || "",
            coDepartments: detail.departments || [],
          });
        }
      }
    }
  }

  // items: 각 부서 최신 1건
  const items = departments.map((dept) => {
    const latest = departmentReleases[dept]?.[0];
    if (!latest) return null;
    return {
      department: dept,
      newsSeq: latest.newsSeq,
      title: latest.title,
      publishedAt: latest.publishedAt,
      url: latest.url,
    };
  }).filter(Boolean);

  // departmentStats
  const departmentStats = departments.map((dept) => ({
    department: dept,
    count: departmentReleases[dept]?.length || 0,
  }));

  // organizationGroups (부서별 건수 포함)
  const organizationGroups = groups.map((group) => ({
    id: group.id,
    topUnit: group.topUnit,
    subUnit: group.subUnit,
    departments: group.departments.map((dept) => ({
      department: dept,
      count: departmentReleases[dept]?.length || 0,
    })),
  }));

  const yearlyReleaseCount = Object.values(departmentReleases).reduce((s, v) => s + v.length, 0);

  // 신규 항목 없을 때: 건수가 이미 정확하면 스냅샷 유지 (불필요한 저장 방지)
  if (!newRows.length && existing) {
    const countsMatch = organizationGroups.every((group) => {
      const existingGroup = (existing.organizationGroups || []).find((g) => g.id === group.id);
      return (group.departments || []).every((dept) => {
        const existingDept = (existingGroup?.departments || []).find((d) => d.department === dept.department);
        return existingDept && existingDept.count === dept.count;
      });
    });
    if (countsMatch) {
      console.log("새 항목 없음, 건수 일치. 스냅샷 유지.");
      process.exit(0);
    }
    console.log("건수 불일치 감지. 스냅샷 갱신합니다.");
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    generatedAtKst: nowKstString(),
    selectedYear: targetYear,
    availableYears: existing?.availableYears || [targetYear],
    source: { name: "고용노동부 보도자료", url: `${MOEL_BASE}/news/enews/report/enewsList.do` },
    totalCount: items.length,
    yearlyReleaseCount,
    scannedYearRows: rows.length,
    items,
    officialDepartments: departments,
    organizationGroups,
    departmentStats,
    departmentReleases,
    notes: existing?.notes || [
      "보도자료는 고용노동부 공식 보도자료 목록에서 수집합니다.",
      "조직 기준은 기관소개 > 조직안내 > 본부 > 산업안전보건본부 구조를 사용합니다.",
      "보도자료가 여러 과에서 공동 작성된 경우, 해당 보도자료를 관련 모든 과에 반영합니다.",
      "최근 3년 간 과별 보도자료 건수와 목록(발행일/제목)을 제공합니다.",
    ],
  };

  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`스냅샷 저장 완료: ${snapshotPath}`);
  console.log(`총 ${yearlyReleaseCount}건 (신규 ${newDetailsCount}건 추가)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
