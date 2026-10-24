import { useEffect, useRef, type ReactNode } from "react";

/**
 * An in-place confirmation, used instead of the browser's confirm() popup:
 * says what will happen, with the action and a way back. Esc cancels.
 */
export function Confirm({ children, action, cancel = "Cancel", onConfirm, onCancel, tone = "red", className = "" }: {
  children: ReactNode; action: string; cancel?: string; onConfirm: () => void; onCancel: () => void;
  tone?: "red" | "warn"; className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className={`confirm ${tone} ${className}`} role="alertdialog" aria-live="polite"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <div className="confirm-text">{children}</div>
      <div className="confirm-actions">
        <button ref={ref} type="button" className="btn small primary" onClick={onConfirm}>{action}</button>
        <button type="button" className="btn small" onClick={onCancel}>{cancel}</button>
      </div>
    </div>
  );
}
