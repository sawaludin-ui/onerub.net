"use client";

// Presentation-only motion: scroll reveals, stat count-up, nav condense on
// scroll, and a light hero-sculpture parallax. No app logic, no data. Every
// motion effect is gated behind prefers-reduced-motion.
import { useEffect } from "react";

export default function MotionLayer() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups = [];

    // --- nav condenses on scroll (not a motion effect; always on) ---
    const header = document.querySelector(".site-header");
    if (header) {
      const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 24);
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
      cleanups.push(() => window.removeEventListener("scroll", onScroll));
    }

    if (reduce) return () => cleanups.forEach((fn) => fn());

    // --- scroll reveals ---
    const revealTargets = document.querySelectorAll(
      ".market-strip, .task-section > *, .marketplace-process .section-top, .process-step, .market-trust, .agent-history-section > *, .closing-section > *, .trust-rules article, .market-task-card, .empty-state, .market-empty",
    );
    if ("IntersectionObserver" in window && revealTargets.length) {
      const io = new IntersectionObserver(
        (entries, obs) => {
          for (const e of entries)
            if (e.isIntersecting) {
              e.target.classList.add("in");
              obs.unobserve(e.target);
            }
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
      );
      revealTargets.forEach((el, i) => {
        el.classList.add("js-reveal");
        el.style.setProperty("--reveal-delay", `${Math.min(i % 6, 5) * 55}ms`);
        io.observe(el);
      });
      cleanups.push(() => io.disconnect());
    }

    // --- count-up for stat numbers ---
    const countNodes = document.querySelectorAll(
      ".market-strip .strip-stat strong, .task-bounty strong",
    );
    const animateCount = (strong) => {
      const textNode = [...strong.childNodes].find(
        (n) => n.nodeType === 3 && /\d/.test(n.nodeValue),
      );
      if (!textNode) return;
      const raw = textNode.nodeValue.trim();
      const target = parseFloat(raw.replace(/[^0-9.]/g, ""));
      if (!isFinite(target) || target <= 0) return;
      const decimals = (raw.split(".")[1] || "").length;
      const dur = 1100;
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        textNode.nodeValue = (target * eased).toFixed(decimals);
        if (p < 1) requestAnimationFrame(tick);
        else textNode.nodeValue = raw;
      };
      requestAnimationFrame(tick);
    };
    if ("IntersectionObserver" in window && countNodes.length) {
      const io2 = new IntersectionObserver(
        (entries, obs) => {
          for (const e of entries)
            if (e.isIntersecting) {
              animateCount(e.target);
              obs.unobserve(e.target);
            }
        },
        { threshold: 0.6 },
      );
      countNodes.forEach((el) => io2.observe(el));
      cleanups.push(() => io2.disconnect());
    }

    // --- hero sculpture parallax (fine pointers only) ---
    const film = document.querySelector(".market-hero .office-film");
    if (film && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      let raf = 0;
      const onMove = (ev) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const dx = (ev.clientX / window.innerWidth - 0.5) * 16;
          const dy = (ev.clientY / window.innerHeight - 0.5) * 12;
          film.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        });
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      cleanups.push(() => {
        window.removeEventListener("pointermove", onMove);
        if (raf) cancelAnimationFrame(raf);
        film.style.transform = "";
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return null;
}
