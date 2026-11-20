export default function Brand({ href = "/" }) {
  return (
    <a className="wordmark" href={href} aria-label="ONERUB.NET home">
      <span className="brand-mark" aria-hidden="true" />
      <span>
        ONERUB<span className="wordmark-dot">.NET</span>
      </span>
    </a>
  );
}
