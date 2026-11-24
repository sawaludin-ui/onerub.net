import { ArrowUpRight } from 'lucide-react';
import { taskStatsView } from './task-stats-view.mjs';
import styles from './TaskStatsCard.module.css';

export default function TaskStatsCard({ task, fallbackToken, chainId, contract, featured = false }) {
  const view = taskStatsView(task, { fallbackToken, chainId, contract });
  const [whole, fraction] = view.value.split('.');
  return (
    <article className={'task-card market-task-card ' + (featured ? 'featured ' : '') + styles.card} aria-label={'Task ' + view.number + ': ' + view.title}>
      <header className={styles.header}>
        <h3 className={styles.heading}>Stats</h3>
        <span className={styles.period}>All Time</span>
      </header>
      <div className={styles.earnings}>
        <span className={styles.label}>Earnings</span>
        <div className={styles.amount} aria-label={view.value + ' ' + view.symbol}>
          <strong>{whole}{fraction !== undefined && <span className={styles.fraction}>.{fraction}</span>}</strong>
          <span className={styles.currency}>{view.symbol}</span>
        </div>
        <p className={styles.note}><span className={view.paid && view.supported ? styles.paid : styles.unpaid}>{view.note}</span><span className={styles.scope}> · this task</span></p>
      </div>
      <dl className={styles.metrics}>
        <div className={styles.metric}>
          <dt>Projects</dt><dd>{view.projects}</dd>
          <span className={styles.metricNote}>this task</span>
        </div>
        <div className={styles.metric}>
          <dt>clients</dt><dd>{view.clients ?? '—'}</dd>
          <span className={styles.metricNote}>requester wallet</span>
        </div>
      </dl>
      <a className={styles.detail} href={view.href} aria-label={'Detail: ' + view.title}>
        <span className={styles.number}>{view.number}</span>
        <span className={styles.detailLabel}>Detail <ArrowUpRight size={18} aria-hidden="true" /></span>
      </a>
      <div className={styles.availability}>
        <span className={styles.label}>Availability</span>
        <div className={styles.bars} role="img" aria-label={view.knownAgents ? view.agents + ' Agent ID wallets submitted to this task' : 'Agent count unavailable'}>
          {Array.from({ length: view.barCount }, (_, i) => {
            const active = view.knownAgents && i < view.agents;
            const progress = Math.min(1, i / Math.max(1, Math.min(view.agents, view.barCount) - 1));
            const hue = progress < 0.7 ? 210 + progress / 0.7 * 120 : 330 + (progress - 0.7) / 0.3 * 60;
            return <span key={i} className={styles.bar} data-active={active ? 'true' : 'false'} style={active ? { backgroundColor: 'hsl(' + hue + ' 92% 67%)' } : undefined} aria-hidden="true" />;
          })}
        </div>
        <p className={styles.agentCount}>{view.knownAgents ? view.agents + ' agent' + (view.agents === 1 ? '' : 's') : 'Agent count unavailable'}</p>
      </div>
    </article>
  );
}
