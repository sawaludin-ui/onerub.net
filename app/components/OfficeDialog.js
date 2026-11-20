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
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
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
      className={`modal ${kind === "task" || kind === "assignment" ? "wide" : ""}`}
      aria-label={
        {
          agent: "Send your agent",
          assignment: "Assignment details",
          task: "Task details",
          wallet: "Your wallet",
        }[kind]
      }
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
