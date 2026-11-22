"use client";

export default function PaginationControls({
  label, page = 1, pageSize, total = null, loading = false, onPageChange,
  hasNext, hasPrevious, rangeStart, rangeEnd,
}) {
  const knownTotal = Number.isSafeInteger(total) && total >= 0;
  const pages = knownTotal ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const previous = hasPrevious ?? page > 1;
  const next = hasNext ?? (knownTotal && page < pages);
  const start = rangeStart ?? (knownTotal && total ? (page - 1) * pageSize + 1 : null);
  const end = rangeEnd ?? (knownTotal && total ? Math.min(page * pageSize, total) : null);
  return (
    <nav className="pagination-controls" aria-label={`${label} pagination`}>
      <p className="pagination-summary" role="status" aria-live="polite" aria-atomic="true">
        {loading ? "Loading page…" : knownTotal && total === 0 ? "No results" : (
          <>Page {page}{knownTotal ? ` of ${pages}` : ""}{start != null && end != null && end >= start ? ` · ${start}–${end}${knownTotal ? ` of ${total}` : ""}` : ""}</>
        )}
      </p>
      <div className="pagination-actions">
        <button type="button" className="button outline" aria-label={`${label}: previous page`} disabled={loading || !previous} onClick={() => onPageChange(page - 1)}>Previous</button>
        <button type="button" className="button outline" aria-label={`${label}: next page`} disabled={loading || !next} onClick={() => onPageChange(page + 1)}>Next</button>
      </div>
    </nav>
  );
}
