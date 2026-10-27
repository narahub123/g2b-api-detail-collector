import type { NoticeFilterValues } from "@/lib/g2b/notice-filters";

/** 공고 목록의 검색 및 범위 조건을 지정한 경로의 GET 양식으로 제공합니다. */
export function NoticeFilters({
  basePath = "/",
  values,
  error,
}: {
  basePath?: "/" | "/admin";
  values: NoticeFilterValues;
  error: string | null;
}) {
  return (
    <form
      action={basePath}
      method="get"
      className="notice-filters"
      aria-label="공고 검색 및 필터"
    >
      <div className="filter-search">
        <label>
          검색 대상
          <select name="searchField" defaultValue={values.searchField}>
            <option value="title">공고명</option>
            <option value="notice_number">공고번호</option>
          </select>
        </label>
        <label>
          검색어
          <input
            name="query"
            type="search"
            defaultValue={values.query}
            placeholder="검색어 입력"
          />
        </label>
      </div>
      <div className="filter-ranges">
        <fieldset>
          <legend>공고 게시일</legend>
          <label>
            시작일
            <input
              name="postedFrom"
              type="date"
              defaultValue={values.postedFrom}
            />
          </label>
          <label>
            종료일
            <input name="postedTo" type="date" defaultValue={values.postedTo} />
          </label>
        </fieldset>
        <fieldset>
          <legend>입찰 마감일</legend>
          <label>
            시작일
            <input
              name="deadlineFrom"
              type="date"
              defaultValue={values.deadlineFrom}
            />
          </label>
          <label>
            종료일
            <input
              name="deadlineTo"
              type="date"
              defaultValue={values.deadlineTo}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>금액 (원)</legend>
          <label>
            최소금액
            <input
              name="minAmount"
              type="number"
              min="0"
              step="1"
              defaultValue={values.minAmount}
            />
          </label>
          <label>
            최대금액
            <input
              name="maxAmount"
              type="number"
              min="0"
              step="1"
              defaultValue={values.maxAmount}
            />
          </label>
        </fieldset>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="filter-actions">
        <a href={basePath}>조건 초기화</a>
        <button type="submit">검색 및 필터 적용</button>
      </div>
    </form>
  );
}
