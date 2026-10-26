/** 공고 차수에 따라 정렬하고, 다른 공고번호가 연결된 경우 전체 번호로 구분합니다. */
export function RelatedNoticeLine({
  currentKey,
  relatedKeys,
}: {
  currentKey: string;
  relatedKeys: string[];
}) {
  const keys = [...new Set([currentKey, ...relatedKeys])].filter((key) =>
    /^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key),
  );
  if (keys.length <= 1) return null;
  keys.sort((a, b) => {
    const [aNumber, aOrder] = a.split("--");
    const [bNumber, bOrder] = b.split("--");
    return (
      aNumber.localeCompare(bNumber) ||
      aOrder.localeCompare(bOrder, undefined, { numeric: true })
    );
  });
  const baseNumber = currentKey.split("--")[0];
  return (
    <nav className="related-notice-line" aria-label="관련 공고">
      <span className="related-notice-label">관련 공고 :</span>
      <span className="related-notice-items">
        {keys.map((key, index) => {
          const [number, order] = key.split("--");
          const label = number === baseNumber ? order : `${number}-${order}`;
          return (
            <span key={key} className="related-notice-item">
              {index > 0 && (
                <span className="related-notice-separator" aria-hidden="true">
                  {" "}
                  -{" "}
                </span>
              )}
              {key === currentKey ? (
                <strong className="related-notice-current" aria-current="page">
                  {label}
                </strong>
              ) : (
                <a
                  className="related-notice-link"
                  href={`/bids/${encodeURIComponent(key)}/view`}
                >
                  {label}
                </a>
              )}
            </span>
          );
        })}
      </span>
    </nav>
  );
}
