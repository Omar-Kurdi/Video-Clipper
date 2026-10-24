/** The app mark: a 9:16 frame with one red line, the part that goes in the short. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size * 0.85} height={size} viewBox="0 0 22 26" fill="none" aria-hidden="true">
      <rect x="3" y="1" width="16" height="24" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M6 15h10" stroke="var(--red)" strokeWidth="2.5" />
    </svg>
  );
}
