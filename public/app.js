const loadingOverlay = document.getElementById("loadingOverlay");
const refreshBtn = document.getElementById("refreshBtn");
const updatedAt = document.getElementById("updatedAt");
const sourceBox = document.getElementById("sourceBox");
const totalCount = document.getElementById("totalCount");
const pressList = document.getElementById("pressList");
const notesList = document.getElementById("notesList");
const yearSelect = document.getElementById("yearSelect");
const yearApplyBtn = document.getElementById("yearApplyBtn");
const yearMeta = document.getElementById("yearMeta");
const departmentBoard = document.getElementById("departmentBoard");

let selectedYearState = "";
let selectedDepartmentState = "";
let departmentReleasesState = {};
const releaseNewsState = new Map();

function escapeHtml(value) {
  return (value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function link(url, text) {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

function setControlsDisabled(disabled) {
  refreshBtn.disabled = disabled;
  yearApplyBtn.disabled = disabled;
  yearSelect.disabled = disabled;
}

function showLoading() {
  setControlsDisabled(true);
  loadingOverlay.classList.remove("hidden");
}

function hideLoading() {
  setControlsDisabled(false);
  loadingOverlay.classList.add("hidden");
}

function renderSource(source) {
  if (!source || !source.url) {
    sourceBox.innerHTML = "<p>출처 정보를 불러오지 못했습니다.</p>";
    return;
  }
  sourceBox.innerHTML = `<p>${link(source.url, `${source.name} 바로가기`)}</p>`;
}

function renderYearOptions(availableYears = [], selectedYear = "") {
  const years = [...new Set((availableYears || []).map((value) => Number.parseInt(value, 10)).filter(Number.isFinite))]
    .sort((a, b) => b - a);

  if (!years.length) {
    yearSelect.innerHTML = "";
    return;
  }

  yearSelect.innerHTML = years
    .map((year) => `<option value="${escapeHtml(String(year))}">${escapeHtml(String(year))}년</option>`)
    .join("");

  const target = Number.parseInt(selectedYear, 10);
  yearSelect.value = Number.isFinite(target) && years.includes(target) ? String(target) : String(years[0]);
}

function highlightSelectedDepartment() {
  const buttons = departmentBoard.querySelectorAll(".dept-count-btn");
  buttons.forEach((button) => {
    const isSelected = button.dataset.dept === selectedDepartmentState;
    button.classList.toggle("is-selected", isSelected);
  });
}

function renderReleaseLinks(item) {
  const links = [];
  if (item.previewUrl) links.push(link(item.previewUrl, "미리보기 뷰어"));
  if (item.url) links.push(link(item.url, "보도자료 원문"));
  if (item.downloadUrl) links.push(link(item.downloadUrl, "PDF 다운로드"));

  if (!links.length) return "<p class=\"meta\">링크 정보가 없습니다.</p>";
  return `<p class="meta">보도자료: ${links.join(" | ")}</p>`;
}

function renderSelectedDepartmentList() {
  const department = selectedDepartmentState;
  if (!department) {
    totalCount.textContent = "";
    pressList.innerHTML = "<p>보도자료를 확인할 과를 선택해 주세요.</p>";
    return;
  }

  const releases = departmentReleasesState[department] || [];
  totalCount.textContent = `${selectedYearState}년 ${department} 보도자료 ${releases.length}건`;

  if (!releases.length) {
    pressList.innerHTML = `<p><strong>${escapeHtml(department)}</strong>의 ${escapeHtml(
      selectedYearState
    )}년 보도자료가 없습니다.</p>`;
    return;
  }

  const rows = releases
    .map(
      (item) => `
        <details class="release-item">
          <summary>
            <span class="summary-meta">${escapeHtml(item.publishedAt || "-")}</span>
            <span class="summary-title">${escapeHtml(item.title || "-")}</span>
          </summary>
          <div class="release-body">
            ${renderReleaseLinks(item)}
            <button
              type="button"
              class="release-news-btn"
              data-news-seq="${escapeHtml(item.newsSeq || "")}"
            >
              관련 뉴스 보기
            </button>
            <div class="release-news-result" data-news-seq="${escapeHtml(item.newsSeq || "")}"></div>
          </div>
        </details>
      `
    )
    .join("");

  pressList.innerHTML = rows;
  bindReleaseNewsButtons();
}

function resolveDefaultDepartment(groups = []) {
  const departments = groups.flatMap((group) => group.departments || []);
  const active = departments.find((dept) => (dept.count || 0) > 0);
  if (active) return active.department;
  return departments[0]?.department || "";
}

function renderDepartmentBoard(groups = [], selectedYear = "", yearlyReleaseCount = 0) {
  const flatDepartments = groups.flatMap((group) => group.departments || []);
  const activeDepartments = flatDepartments.filter((row) => (row.count || 0) > 0).length;

  yearMeta.textContent = `${selectedYear}년 기준 총 ${yearlyReleaseCount || 0}건 | 보도자료 발행 과 ${
    activeDepartments || 0
  }/${flatDepartments.length || 0}개`;

  if (!groups.length) {
    departmentBoard.innerHTML = "<p>조직 집계 정보를 불러오지 못했습니다.</p>";
    return;
  }

  const html = groups
    .map((group) => {
      const groupTitle = group.subUnit ? `${group.topUnit} > ${group.subUnit}` : group.topUnit;
      const departmentRows = (group.departments || [])
        .map(
          (dept) => `
            <li class="org-dept-row">
              <span class="org-dept-name">${escapeHtml(dept.department || "-")}</span>
              <button type="button" class="dept-count-btn" data-dept="${escapeHtml(dept.department || "")}">
                ${escapeHtml(String(dept.count || 0))}건
              </button>
            </li>
          `
        )
        .join("");

      return `
        <section class="org-group">
          <h3>${escapeHtml(groupTitle)}</h3>
          <ul>${departmentRows}</ul>
        </section>
      `;
    })
    .join("");

  departmentBoard.innerHTML = html;

  const hasSelected = flatDepartments.some((dept) => dept.department === selectedDepartmentState);
  if (!selectedDepartmentState || !hasSelected) {
    selectedDepartmentState = resolveDefaultDepartment(groups);
  }

  const buttons = departmentBoard.querySelectorAll(".dept-count-btn");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedDepartmentState = button.dataset.dept || "";
      highlightSelectedDepartment();
      renderSelectedDepartmentList();
    });
  });

  highlightSelectedDepartment();
}

function renderNotes(notes = []) {
  if (!notes.length) {
    notesList.innerHTML = "<li>기준 정보 없음</li>";
    return;
  }
  notesList.innerHTML = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
}

function renderReleaseNewsResult(container, data) {
  if (!data || !Array.isArray(data.relatedNews)) {
    container.innerHTML = "<p class=\"meta\">관련 뉴스 정보가 없습니다.</p>";
    return;
  }

  if (!data.relatedNews.length) {
    container.innerHTML = "<p class=\"meta\">관련 뉴스가 검색되지 않았습니다.</p>";
    return;
  }

  const rows = data.relatedNews
    .map(
      (news) => `
        <tr>
          <td>${escapeHtml(news.source || "-")}</td>
          <td>${escapeHtml(news.publishedAt || "-")}</td>
          <td>${link(news.url, news.title || "-")}</td>
        </tr>
      `
    )
    .join("");

  container.innerHTML = `
    <p class="meta">관련 뉴스 ${escapeHtml(String(data.relatedNewsCount || data.relatedNews.length))}건</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>기사 출처</th><th>보도일</th><th>기사 제목</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function loadReleaseNews(newsSeq, button, container) {
  if (!newsSeq) {
    container.innerHTML = "<p class=\"meta\">보도자료 식별값이 없습니다.</p>";
    return;
  }

  if (releaseNewsState.has(newsSeq)) {
    renderReleaseNewsResult(container, releaseNewsState.get(newsSeq));
    return;
  }

  button.disabled = true;
  button.textContent = "불러오는 중...";
  container.innerHTML = "<p class=\"meta\">관련 뉴스를 조회하고 있습니다...</p>";

  try {
    const response = await fetch(`/api/release-news?newsSeq=${encodeURIComponent(newsSeq)}`);
    if (!response.ok) {
      throw new Error(`요청 실패 (${response.status})`);
    }
    const data = await response.json();
    releaseNewsState.set(newsSeq, data);
    renderReleaseNewsResult(container, data);
  } catch (error) {
    container.innerHTML = `<p class="meta">조회 실패: ${escapeHtml(error.message)}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = "관련 뉴스 보기";
  }
}

function bindReleaseNewsButtons() {
  const buttons = pressList.querySelectorAll(".release-news-btn");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const newsSeq = button.dataset.newsSeq || "";
      const containers = [...pressList.querySelectorAll(".release-news-result")];
      const container = containers.find((node) => (node.dataset.newsSeq || "") === newsSeq);
      if (!container) return;
      loadReleaseNews(newsSeq, button, container);
    });
  });
}

function renderDashboard(data) {
  selectedYearState = String(data.selectedYear || "");
  departmentReleasesState = data.departmentReleases || {};

  updatedAt.textContent = `수집 시각: ${data.generatedAtKst || "-"}`;
  renderSource(data.source || null);
  renderYearOptions(data.availableYears || [], data.selectedYear || "");
  renderDepartmentBoard(data.organizationGroups || [], data.selectedYear || "", data.yearlyReleaseCount || 0);
  renderSelectedDepartmentList();
  renderNotes(data.notes || []);
}

function buildDashboardUrl(refresh = false, year = "") {
  const params = new URLSearchParams();
  if (refresh) params.set("refresh", "1");
  if (year) params.set("year", String(year));
  const query = params.toString();
  return `/api/dashboard${query ? `?${query}` : ""}`;
}

async function loadDashboard(refresh = false, year = "") {
  showLoading();
  try {
    const targetYear = String(year || yearSelect.value || selectedYearState || "").trim();
    const response = await fetch(buildDashboardUrl(refresh, targetYear));
    if (!response.ok) {
      throw new Error(`요청 실패 (${response.status})`);
    }
    const data = await response.json();
    renderDashboard(data);
  } catch (error) {
    sourceBox.innerHTML = `<p>오류: ${escapeHtml(error.message)}</p>`;
    totalCount.textContent = "";
    yearMeta.textContent = "";
    departmentBoard.innerHTML = "<p>과별 현황을 불러오지 못했습니다.</p>";
    pressList.innerHTML = "<p>보도자료를 불러오지 못했습니다.</p>";
    notesList.innerHTML = "<li>오류 발생</li>";
  } finally {
    hideLoading();
  }
}

refreshBtn.addEventListener("click", () => loadDashboard(true, yearSelect.value));
yearApplyBtn.addEventListener("click", () => loadDashboard(false, yearSelect.value));
loadDashboard(false);
