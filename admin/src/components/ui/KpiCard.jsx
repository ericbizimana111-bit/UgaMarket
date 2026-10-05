import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Minus } from 'lucide-react';
import './KpiCard.css';

/**
 * Dashboard KPI card.
 *
 *  - `value` is the headline number; pass `unit` (e.g. "UGX") to show it as a
 *    small prefix so large amounts stay readable.
 *  - Trend cards pass `current`/`previous` (day-over-day change) and `series`
 *    (sparkline, oldest → newest).
 *  - Queue cards pass `status` ({ label, tone }) so zero reads as "all clear"
 *    rather than an empty box.
 * tone: primary | success | warning | danger | info | neutral
 */
export default function KpiCard(props) {
  const { to, label, icon: Icon, tone = 'primary', value, unit, hint, current, previous, series, status, cta = 'View' } = props;
  const attention = status && (status.tone === 'warning' || status.tone === 'danger');
  return (
    <Link to={to} className={`kpi kpi--${tone} ${attention ? 'kpi--attention' : ''}`}>
      <div className="kpi__head">
        <span className="kpi__label">{label}</span>
        <span className="kpi__icon" aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
      </div>

      <div className="kpi__body">
        <div className="kpi__value">
          {unit && <span className="kpi__unit">{unit}</span>}
          {value}
        </div>
        {series && <Sparkline values={series} />}
      </div>

      <div className="kpi__foot">
        <span className="kpi__meta">
          {status ? (
            <span className={`kpi__pill kpi__pill--${status.tone}`}>
              <span className="kpi__dot" aria-hidden="true" />
              {status.label}
            </span>
          ) : (
            current !== undefined && <Delta current={current} previous={previous} />
          )}
          {hint && <span className="kpi__hint">{hint}</span>}
        </span>
        <span className="kpi__cta">
          {cta}
          <ArrowRight size={13} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

/** Day-over-day change chip. Up is good for every metric this card shows. */
function Delta({ current = 0, previous = 0 }) {
  if (!current && !previous) {
    return (
      <span className="kpi__delta kpi__delta--flat">
        <Minus size={12} aria-hidden="true" /> No activity yet
      </span>
    );
  }
  if (!previous) {
    return (
      <span className="kpi__delta kpi__delta--up">
        <ArrowUpRight size={12} aria-hidden="true" /> New vs yesterday
      </span>
    );
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) {
    return (
      <span className="kpi__delta kpi__delta--flat">
        <Minus size={12} aria-hidden="true" /> Same as yesterday
      </span>
    );
  }
  const up = pct > 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`kpi__delta kpi__delta--${up ? 'up' : 'down'}`}>
      <Arrow size={12} aria-hidden="true" />
      {Math.abs(pct)}% vs yesterday
    </span>
  );
}

/** Small 7-day trend line; decorative (the numbers are in the card text). */
function Sparkline({ values }) {
  const W = 92;
  const H = 34;
  const pad = 3;
  const max = Math.max(...values, 0);
  const empty = max === 0;
  const step = values.length > 1 ? (W - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [pad + i * step, empty ? H - pad : H - pad - (v / max) * (H - pad * 2)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className={`kpi__spark ${empty ? 'kpi__spark--empty' : ''}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      {!empty && <path className="kpi__spark-area" d={area} />}
      <path className="kpi__spark-line" d={line} />
      <circle className="kpi__spark-dot" cx={lx} cy={ly} r="2.6" />
    </svg>
  );
}
