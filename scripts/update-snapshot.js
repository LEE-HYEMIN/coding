/**
 * 현재 연도 스냅샷 업데이트 스크립트
 * - 기존 스냅샷을 읽어 이미 수집된 newsSeq 목록을 파악
 * - 최근 5페이지만 스캔해서 새 항목만 상세 수집
 * - 기존 데이터와 병합 후 저장
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

function currentKstYear() {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date())
  );
}

function nowKstString() {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

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

function normalizeText(v) {
  return (v || "").replace(/\s+/g, " ").trim();
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
        rows.push({ newsSeq, title: normalizeText($anchor.text()), date: dateText, dateObj, url: `${MOEL_BASE}/news/enews/report/enewsView.do?news_seq=${newsSeq}` });
      });
      if (foundOlderYear) break;
    } catch (e) {
      console.error(`페이지 ${page} 수집 실패:`, e.message);
    }
  }
  return rows;
}

async function fetchPressDetail(newsSeq) {
  const url = `${MOEL_BASE}/news/enews/report/enewsView.do?news_seq=${newsSeq}`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const title = normalizeText($("h3.tit, .view_title, h4.tit").first().text());
  const dateText = normalizeText($(".date, .view_info .date, td:contains('등록일')").first().text().replace("등록일", ""));
  const content = normalizeText($(".b_content").first().text()).slice(0, 1000);
  return { newsSeq, title, publishedAt: dateText || formatDate(new Date()), content, url };
}

async function fetchOrganization() {
  const html = await fetchText(`${MOEL_BASE}/agency/org/ministry/list.do`);
  const $ = cheerio.load(html);
  const departments = [];
  $("*").each((_, el) => {
    const text = normalizeText($(el).text());
    if (text.includes(SAFETY_HQ_NAME)) {
      $(el).find("li, dd, span").each((__, child) => {
        const name = normalizeText($(child).text());
        if (name.length >= 3 && name.endsWith("과") || name.endsWith("팀") || name.endsWith("담당관")) {
          departments.push(name);
        }
      });
    }
  });
  return [...new Set(departments)];
}

function matchDepartment(content, departments) {
  const matched = [];
  for (const dept of departments) {
    const aliases = DEPARTMENT_ALIAS_RULES.get(dept) || [dept];
    if (aliases.some((alias) => content.includes(alias))) matched.push(dept);
  }
  return matched;
}

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

  if (!newRows.length && existing) {
    console.log("새 항목 없음. 스냅샷 유지.");
    process.exit(0);
  }

  // 조직 정보 수집
  let departments = existing?.officialDepartments || [];
  if (!departments.length) {
    console.log("조직 정보 수집 중...");
    departments = await fetchOrganization();
    console.log(`부서 ${departments.length}개 수집`);
  }

  // 신규 항목 상세 수집
  const newDetails = (await mapLimit(newRows, DETAIL_CONCURRENCY, async (row) => {
    try {
      const detail = await fetchPressDetail(row.newsSeq);
      const matched = matchDepartment(`${detail.title} ${detail.content}`, departments);
      if (!matched.length) return null;
      return { ...detail, departments: matched, publishedAt: row.date, url: row.url };
    } catch (e) {
      console.error(`상세 수집 실패 (${row.newsSeq}):`, e.message);
      return null;
    }
  })).filter(Boolean);
  console.log(`신규 항목 중 매칭: ${newDetails.length}건`);

  // 기존 departmentReleases와 병합
  const departmentReleases = existing?.departmentReleases
    ? JSON.parse(JSON.stringify(existing.departmentReleases))
    : {};

  for (const dept of departments) {
    if (!departmentReleases[dept]) departmentReleases[dept] = [];
  }

  for (const detail of newDetails) {
    for (const dept of detail.departments) {
      if (!departmentReleases[dept]) departmentReleases[dept] = [];
      const alreadyExists = departmentReleases[dept].some((i) => i.newsSeq === detail.newsSeq);
      if (!alreadyExists) {
        departmentReleases[dept].unshift({
          newsSeq: detail.newsSeq,
          title: detail.title,
          publishedAt: detail.publishedAt,
          url: detail.url,
        });
      }
    }
  }

  // items: 각 부서 최신 1건
  const items = departments.map((dept) => {
    const latest = departmentReleases[dept]?.[0];
    if (!latest) return null;
    return { department: dept, newsSeq: latest.newsSeq, title: latest.title, publishedAt: latest.publishedAt, url: latest.url };
  }).filter(Boolean);

  const yearlyReleaseCount = Object.values(departmentReleases).reduce((s, v) => s + v.length, 0);

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
    organizationGroups: existing?.organizationGroups || [],
    departmentStats: existing?.departmentStats || [],
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
  console.log(`총 ${yearlyReleaseCount}건 (신규 ${newDetails.length}건 추가)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
