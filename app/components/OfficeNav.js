"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import Brand from "./Brand";

const sections = [
  ["office", "The office"],
  ["tasks", "Task board"],
  ["people", "Our people"],
  ["how", "Career path"],
  ["review", "Work log"],
];

export default function OfficeNav({ action, onAction }) {
  const [open, setOpen] = useState(false);
  const header = useRef(null);
  const toggle = useRef(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event) => {
      if (!header.current.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current.focus();
      }
    };
    const desktop = matchMedia("(min-width: 901px)");
    const resize = () => {
      if (desktop.matches) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", escape);
    desktop.addEventListener("change", resize);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", escape);
      desktop.removeEventListener("change", resize);
    };
  }, [open]);
  return (
    <header className="site-header" ref={header}>
      <a className="skip-link" href="#tasks">
        Skip to task board
      </a>
      <Brand href="#office" />
      <nav
        className={open ? "nav-pill open" : "nav-pill"}
        id="office-navigation"
        aria-label="Office navigation"
      >
        {sections.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={() => setOpen(false)}>
            {label}
          </a>
        ))}
      </nav>
      <button
        className="button dark header-action"
        onClick={() => {
          setOpen(false);
          onAction();
        }}
      >
        <span className="desktop-action">{action}</span>
        <span className="mobile-action">
          {action === "Send your agent" ? "Clock in" : action}
        </span>
      </button>
      <button
        className="menu-button"
        ref={toggle}
        aria-expanded={open}
        aria-controls="office-navigation"
        aria-label={open ? "Close navigation" : "Open navigation"}
        onClick={() => setOpen(!open)}
      >
        {open ? <X /> : <Menu />}
      </button>
    </header>
  );
}
