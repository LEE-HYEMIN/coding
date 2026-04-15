# CLAUDE.md

## 프로젝트 개요

고용노동부 산업안전보건본부 보도자료 대시보드.
- `server.js`: Express 서버 (로컬 실행 및 Vercel 배포)
- `scripts/update-snapshot.js`: GitHub Actions용 스냅샷 자동 수집 스크립트
- `snapshots/`: 연도별 JSON 스냅샷 (`dashboard-YYYY.json`)

## 핵심 규칙: 매칭 로직 동기화

**`server.js`의 부서 매칭 로직을 수정할 때는 `scripts/update-snapshot.js`도 반드시 함께 수정해야 합니다.**

두 파일에서 동일하게 유지해야 하는 함수:
- `buildDepartmentNameMap` — 공식 부서명 + 별칭 → 정규명 매핑
- `extractDepartmentsFromContent` — 본문 "문의:" 섹션에서 부서명 추출
- `findMatchedSafetyDepartments` — 2단계 매칭 (문의 섹션 + 전체 텍스트)
- `buildPressSummary` — 보도자료 요약 생성
- `DEPARTMENT_ALIAS_RULES` — 부서명 별칭 규칙

## 스냅샷 구조 (`dashboard-YYYY.json`)

- `items`: 부서별 최신 보도자료 1건 목록
- `departmentReleases`: 부서별 전체 보도자료 목록 (각 항목에 `newsSeq`, `title`, `publishedAt`, `url`, `previewUrl`, `downloadUrl`, `viewerFileName`, `coDepartments` 포함)
- `officialDepartments`: 공식 부서명 배열
- `organizationGroups`: 조직 구조 (topUnit > subUnit > 부서별 건수)
- `departmentStats`: 부서별 보도자료 건수

## 수동 스냅샷

사용자가 "수동 스냅샷 진행해줘"라고 하면 즉시 실행:
```bash
node scripts/update-snapshot.js
```

## 배포

- **로컬**: `node server.js`
- **Vercel**: `vercel.json` 설정으로 자동 배포, 스냅샷 파일 포함 (`snapshots/**`)
- **GitHub Actions**: `.github/workflows/update-snapshots.yml` — 매일 KST 00:00 자동 실행
