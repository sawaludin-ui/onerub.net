"use client";

// Live clock in the visitor's own locale/timezone, shown with its UTC offset.
import { useEffect, useState } from "react";

export default function LiveClock() {
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!now) return <span className="eyebrow live-clock" suppressHydrationWarning>—</span>;

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offMin = -now.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const utc = `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? ":" + String(abs % 60).padStart(2, "0") : ""}`;
  return (
    <span className="eyebrow live-clock" suppressHydrationWarning>
      {time} · {utc}
    </span>
  );
}
