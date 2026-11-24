// Adapted directly from the supplied task-001-stats-card.zip; layout/utility classes retained.
import { useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { taskStatsView } from './task-stats-view.mjs';
import styles from './TaskStatsCard.module.css';
import {
  buildAvailabilitySegments,
  extractTaskDigits,
  formatAgentCountLabel,
} from './provided-task-stats.mjs';

function ProvidedTaskStatsCard({ task, detailHref }) {
  const [hoveredSlot, setHoveredSlot] = useState(null);
  const [tilt, setTilt] = useState(null);

  const segments = useMemo(
    () => buildAvailabilitySegments(task.agentsEntered, task.totalAgentSlots),
    [task.agentsEntered, task.totalAgentSlots]
  );

  const taskDigits = useMemo(
    () => extractTaskDigits(task.taskNumber),
    [task.taskNumber]
  );

  const agentSummary = useMemo(
    () => task.knownAgents ? formatAgentCountLabel(task.agentsEntered) : "Agent count unavailable",
    [task.agentsEntered, task.knownAgents]
  );

  const hoveredAgent =
    hoveredSlot !== null && hoveredSlot < task.agents.length
      ? task.agents[hoveredSlot]
      : null;

  const handlePointerMove = (event) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const ry = (x - 0.5) * 9;
    const rx = (0.5 - y) * 9;
    setTilt({ rx, ry, px: x * 100, py: y * 100 });
  };

  const handlePointerLeave = () => {
    setTilt(null);
  };

  const cardTransform = tilt
    ? `perspective(1000px) rotateX(${tilt.rx.toFixed(2)}deg) rotateY(${tilt.ry.toFixed(2)}deg) translateZ(6px)`
    : 'perspective(1000px) rotateX(2deg) rotateY(-1.5deg) translateZ(0px)';

  return (
    <article
      data-task-stats-card
      aria-label={`Task ${taskDigits} statistics card`}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{
        transform: cardTransform,
        transformStyle: 'preserve-3d',
      }}
      className={styles.scope + " market-zip-task-card relative w-full max-w-[376px] rounded-[28px] border border-t-white/[0.18] border-x-white/[0.08] border-b-[#0D0D0F] bg-gradient-to-b from-[#2A2A2E] via-[#212123] to-[#19191B] p-6 text-[#F5F5F7] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_0_-2px_6px_rgba(0,0,0,0.45),0_10px_0_#131315,0_26px_42px_-8px_rgba(0,0,0,0.42),0_44px_72px_-16px_rgba(0,0,0,0.34)] transition-transform duration-200 ease-out will-change-transform"}
    >
      {/* Dynamic 3D Specular Sheen */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[28px] opacity-60 transition-opacity duration-200"
        style={{
          background: tilt
            ? `radial-gradient(circle at ${tilt.px}% ${tilt.py}%, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 60%)`
            : 'radial-gradient(circle at 25% 12%, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 55%)',
        }}
      />

      {/* Top Header Row: Paid */}
      <div className="relative z-10 flex items-center justify-end gap-4">
        <span className="inline-flex items-center rounded-[10px] border border-white/[0.12] bg-[#28282A] px-3.5 py-1.5 text-[13px] font-normal leading-none text-[#E5E5E7] whitespace-nowrap shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          {task.statusLabel}
        </span>
      </div>

      {/* Primary Payout Block (mapped from Earnings) */}
      <div className="relative z-10 mt-5">
        <p className="text-[13px] font-normal text-[#C7C7CC]">Earnings</p>
        <div className="mt-1 flex items-baseline tabular-nums">
          <span className="text-[48px] font-semibold leading-[1.04] tracking-[-0.03em] text-[#F5F5F7]">
            {task.payoutAmount}
          </span>
          <span className="ml-2 text-[44px] font-medium leading-[1.04] tracking-[-0.03em] text-[#6E6E73]">
            {task.payoutCurrency}
          </span>
        </div>
        <p className="mt-2 text-[13px] font-normal leading-snug">
          <span className="text-[#4ADE80]">{task.payoutHighlight}</span>
          <span className="text-[#A1A1AA]"> · {task.payoutNote}</span>
        </p>
      </div>

      {/* Two Middle Inset Boxes (14 submissions | Due 24 Nov 2026, 21:00 WIB) */}
      <div className="relative z-10 mt-5 grid grid-cols-2 gap-3">
        <div className="flex flex-col justify-center rounded-[16px] border border-white/[0.06] bg-[#2C2C2E] px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_4px_10px_rgba(0,0,0,0.2)]">
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-[24px] font-normal leading-none tracking-[-0.02em] text-[#F5F5F7]">
              {task.submissionsCount}
            </span>
            <span className="text-[13px] font-normal text-[#A1A1AA]">
              submissions
            </span>
          </div>
        </div>

        <div className="flex flex-col justify-between rounded-[16px] border border-white/[0.06] bg-[#2C2C2E] px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_4px_10px_rgba(0,0,0,0.2)]">
          <div className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-[24px] font-normal leading-none tracking-[-0.02em] text-[#F5F5F7] whitespace-nowrap">
              {task.dueDatePrimary}
            </span>
            <span className="text-[13px] font-normal text-[#A1A1AA]">
              {task.dueYear}
            </span>
          </div>
          <p className="mt-2.5 text-[12px] text-[#8E8E93] tabular-nums whitespace-nowrap">
            Due <span className="font-medium text-[#D1D1D6]">{task.dueTimeLabel}</span>
          </p>
        </div>
      </div>

      {/* White Featured Box: Task Number Only (01) + Detail Button + Speckle ('bercak-bercak') Decoration */}
      <div className="relative z-10 mt-3.5 flex items-center justify-between gap-3 overflow-hidden rounded-[18px] bg-[#F2F2F4] px-5 py-[18px] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_6px_16px_rgba(0,0,0,0.28)]">
        <svg
          aria-hidden="true"
          viewBox="0 0 328 76"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          {/* Organic speckle / splatter accents ('bercak-bercak') */}
          <circle cx="18" cy="14" r="3.2" fill="#18181B" fillOpacity="0.09" />
          <circle cx="28" cy="10" r="1.4" fill="#18181B" fillOpacity="0.14" />
          <ellipse cx="14" cy="60" rx="4.5" ry="2.6" transform="rotate(-22 14 60)" fill="#2563EB" fillOpacity="0.14" />
          <circle cx="52" cy="64" r="2.1" fill="#18181B" fillOpacity="0.11" />
          <circle cx="76" cy="13" r="2.6" fill="#9333EA" fillOpacity="0.13" />
          <circle cx="84" cy="20" r="1.2" fill="#18181B" fillOpacity="0.12" />
          <path d="M98 58c3-2 7 0 6 4s-6 4-7 1 0-4 1-5z" fill="#18181B" fillOpacity="0.08" />
          <circle cx="116" cy="28" r="1.8" fill="#EC4899" fillOpacity="0.13" />
          <ellipse cx="132" cy="14" rx="5" ry="2.8" transform="rotate(18 132 14)" fill="#18181B" fillOpacity="0.08" />
          <circle cx="144" cy="48" r="2.8" fill="#2563EB" fillOpacity="0.12" />
          <circle cx="156" cy="63" r="1.6" fill="#18181B" fillOpacity="0.13" />
          <path d="M168 24c4-3 8 1 6 5s-7 2-8-1 1-3 2-4z" fill="#F97316" fillOpacity="0.14" />
          <circle cx="182" cy="54" r="3.6" fill="#18181B" fillOpacity="0.07" />
          <circle cx="192" cy="12" r="1.5" fill="#9333EA" fillOpacity="0.14" />
          <circle cx="204" cy="40" r="2.2" fill="#18181B" fillOpacity="0.11" />
          <ellipse cx="218" cy="65" rx="4.2" ry="2.2" transform="rotate(-14 218 65)" fill="#EC4899" fillOpacity="0.13" />
          <circle cx="234" cy="16" r="2.9" fill="#18181B" fillOpacity="0.08" />
          <circle cx="246" cy="10" r="1.3" fill="#2563EB" fillOpacity="0.15" />
          <circle cx="268" cy="66" r="2.4" fill="#18181B" fillOpacity="0.1" />
          <circle cx="304" cy="12" r="2.8" fill="#F97316" fillOpacity="0.13" />
          <circle cx="315" cy="24" r="1.5" fill="#18181B" fillOpacity="0.12" />
          <ellipse cx="312" cy="62" rx="4" ry="2.4" transform="rotate(25 312 62)" fill="#9333EA" fillOpacity="0.13" />
          <circle cx="106" cy="42" r="1.1" fill="#18181B" fillOpacity="0.14" />
          <circle cx="164" cy="39" r="1.3" fill="#18181B" fillOpacity="0.12" />
          <circle cx="212" cy="26" r="1.7" fill="#18181B" fillOpacity="0.1" />
          <circle cx="64" cy="44" r="1.4" fill="#F97316" fillOpacity="0.12" />
        </svg>

        <span
          className="relative z-10 text-[34px] font-normal leading-none tracking-[-0.02em] text-[#111113] tabular-nums"
          aria-label={"Task number " + taskDigits}
        >
          {taskDigits}
        </span>
        <a
          href={detailHref}
          aria-label={"Detail: " + task.title}
          className="relative z-10 inline-flex min-h-[40px] cursor-pointer items-center gap-1.5 rounded-[12px] bg-[#18181B] px-4 py-2 text-[13.5px] font-medium text-white shadow-[0_3px_8px_rgba(0,0,0,0.2)] transition-all duration-150 hover:bg-[#27272A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#18181B] active:scale-[0.98] whitespace-nowrap shrink-0"
        >
          <span>Detail</span>
          <ArrowUpRight className="h-4 w-4 stroke-[2]" aria-hidden="true" />
        </a>
      </div>

      {/* Worker Section: Segmented Bar for .ai Agents Entered */}
      <div className="relative z-10 mt-5">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-[13.5px] font-normal text-[#E5E5E7]">
            Worker
          </h2>
          {hoveredAgent && (
            <span className="font-mono text-[11px] text-[#A1A1AA] tabular-nums">
              {hoveredAgent.handle}
            </span>
          )}
        </div>

        <div
          className="flex h-8 items-center gap-[3.5px]"
          role="img"
          aria-label={task.knownAgents ? `${task.agentsEntered} AI agent submissions` : "Agent count unavailable"}
          data-testid="availability-bars"
        >
          {segments.map((segment) => (
            <div
              key={segment.index}
              data-active={segment.isActive ? 'true' : 'false'}
              onMouseEnter={() => setHoveredSlot(segment.index)}
              onMouseLeave={() => setHoveredSlot(null)}
              className="h-full flex-1 rounded-[4px] transition-transform duration-150 hover:scale-y-110"
              style={{ backgroundColor: segment.color }}
              title={
                segment.isActive && task.agents[segment.index]
                  ? `${task.agents[segment.index].handle} (${task.agents[segment.index].status})`
                  : `Agent ${segment.index + 1}: ${segment.isActive ? "Submitted" : "Not filled"}`
              }
            />
          ))}
        </div>

        <p className="mt-2.5 text-[12.5px] font-normal text-[#8E8E93] tabular-nums">
          {agentSummary}
        </p>
      </div>
    </article>
  );
}
export default function TaskStatsCard({ task, fallbackToken, chainId, contract }) {
  const view = taskStatsView(task, { fallbackToken, chainId, contract });
  return <ProvidedTaskStatsCard task={view} detailHref={view.href} />;
}
