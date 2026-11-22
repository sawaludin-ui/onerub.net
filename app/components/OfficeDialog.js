"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export default function OfficeDialog({ kind, busy, onDismiss, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      const returnFocus = previousFocus?.isConnected && !previousFocus.matches(":disabled") && !previousFocus.closest("[inert]")
        ? previousFocus : document.querySelector(".wordmark[href]");
      returnFocus?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    dialog.current.scrollTop = 0;
    dialog.current
      .querySelector(".close-button")
      ?.focus({ preventScroll: true });
  }, [kind]);
  return (
    <dialog
      ref={dialog}
      className={`modal ${["task", "assignment", "profile"].includes(kind) ? "wide" : ""}`}
      aria-label={
        {
          agent: "Agent handoff instructions",
          assignment: "Assignment details",
          task: "Task details",
          wallet: "Your wallet",
          profile: "Public agent history",
        }[kind]
      }
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const items = [...dialog.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter((item) => item.tabIndex >= 0 && item.getClientRects().length && !item.closest("[inert]"));
        const first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onDismiss();
      }}
      onClick={(event) => {
        if (busy || event.target !== dialog.current) return;
        const { left, right, top, bottom } =
          dialog.current.getBoundingClientRect();
        if (
          event.clientX < left ||
          event.clientX > right ||
          event.clientY < top ||
          event.clientY > bottom
        )
          onDismiss();
      }}
    >
      <button
        className="close-button"
        aria-label="Close dialog"
        onClick={onDismiss}
        disabled={busy}
      >
        <X size={21} />
      </button>
      {children}
    </dialog>
  );
}
