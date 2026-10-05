import { useState } from 'react';
import './TrendChart.css';

/**
 * Last-7-days business trend. One measure at a time (switchable) so the
 * column height and the number always mean the same thing; every day's full
 * figures are in the hover/focus tooltip and in the screen-reader table.
 *
 * days: [{ date: 'YYYY-MM-DD', orders, revenueUgx, paymentsUgx }] oldest → newest
 */
const METRICS = [
  { key: 'revenueUgx', label: 'Order value', money: true, empty: 'No orders placed' },
  { key: 'orders', label: 'Orders', money: false, empty: 'No orders placed' },
  { key: 'paymentsUgx', label: 'Collected', money: true, empty: 'No payments collected' },
];

const full = (n) => Math.round(n || 0).toLocaleString('en-UG');
function compact(n) {
  const v = Math.round(n || 0);
  if (v >= 1000000) return `${(v / 1000000).toFixed(v >= 10000000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(v);
}
const fmt = (metric, n, short = false) => (metric.money ? `UGX ${short ? compact(n) : full(n)}` : full(n));

/** Round the axis top up to a clean number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^n)
 *  so the tallest column fills most of the plot; counts stay even for a clean midline. */
function niceMax(max, integer) {
  if (max <= 0) return integer ? 4 : 100000;
  const exp = 10 ** Math.floor(Math.log10(max));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s * exp >= max) * exp;
  return integer ? Math.max(2, Math.ceil(step / 2) * 2) : step;
}

const dayDate = (date) => new Date(`${date}T12:00:00Z`);
const weekday = (date) => dayDate(date).toLocaleDateString('en-UG', { weekday: 'short', timeZone: 'UTC' });
const longDate = (date) => dayDate(date).toLocaleDateString('en-UG', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function TrendChart({ days = [] }) {
  const [metricKey, setMetricKey] = useState('revenueUgx');
  const [active, setActive] = useState(null);
  const metric = METRICS.find((m) => m.key === metricKey);

  const values = days.map((d) => d[metric.key] || 0);
  const total = values.reduce((s, v) => s + v, 0);
  const max = Math.max(0, ...values);
  const top = niceMax(max, !metric.money);
  const bestIndex = max > 0 ? values.lastIndexOf(max) : -1;
  const todayIndex = days.length - 1;
  const ticks = [top, top / 2, 0];
  const activeDay = active !== null ? days[active] : null;

  return (
    <div className="trend">
      <div className="trend__top">
        <div className="trend__tabs" role="tablist" aria-label="Measure shown in the chart">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={m.key === metricKey}
              className={`trend__tab ${m.key === metricKey ? 'trend__tab--on' : ''}`}
              onClick={() => setMetricKey(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <dl className="trend__stats">
        <div>
          <dt>7-day total</dt>
          <dd className="trend__total">{fmt(metric, total)}</dd>
        </div>
        <div>
          <dt>Daily average</dt>
          <dd>{fmt(metric, total / Math.max(1, days.length))}</dd>
        </div>
        <div>
          <dt>Best day</dt>
          <dd>{bestIndex >= 0 ? `${weekday(days[bestIndex].date)} · ${fmt(metric, max, true)}` : '—'}</dd>
        </div>
      </dl>

      <div className="trend__plot" aria-hidden="true" onMouseLeave={() => setActive(null)}>
        <div className="trend__grid">
          {ticks.map((t) => (
            <div key={t} className="trend__gridline">
              <span>{metric.money ? compact(t) : full(t)}</span>
            </div>
          ))}
        </div>

        <div className="trend__cols">
          {days.map((d, i) => {
            const v = values[i];
            const h = top > 0 ? (v / top) * 100 : 0;
            const isToday = i === todayIndex;
            const showLabel = v > 0 && (i === bestIndex || isToday);
            return (
              <div
                key={d.date}
                className={`trend__col ${isToday ? 'trend__col--today' : ''} ${active === i ? 'trend__col--active' : ''}`}
                tabIndex={0}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                <div className="trend__bar-wrap">
                  {showLabel && (
                    <span className="trend__value" style={{ bottom: `calc(${h}% + 6px)` }}>
                      {fmt(metric, v, true)}
                    </span>
                  )}
                  <span className={`trend__bar ${v === 0 ? 'trend__bar--zero' : ''}`} style={{ height: v === 0 ? undefined : `${Math.max(h, 1.5)}%` }} />
                </div>
                <span className="trend__day">{isToday ? 'Today' : weekday(d.date)}</span>
              </div>
            );
          })}
        </div>

        {activeDay && (
          <div
            className="trend__tip"
            style={{
              left: `calc(52px + (100% - 52px) * ${(active + 0.5) / days.length})`,
              // Keep the tooltip inside the panel at the first and last day.
              transform: `translateX(${active === 0 ? '-15%' : active === days.length - 1 ? '-85%' : '-50%'})`,
            }}
          >
            <div className="trend__tip-date">{longDate(activeDay.date)}</div>
            <div className="trend__tip-main">{fmt(metric, activeDay[metric.key])}</div>
            {METRICS.filter((m) => m.key !== metric.key).map((m) => (
              <div key={m.key} className="trend__tip-row">
                <span>{m.label}</span>
                <strong>{fmt(m, activeDay[m.key])}</strong>
              </div>
            ))}
          </div>
        )}

        {max === 0 && <div className="trend__empty">{metric.empty} in the last 7 days</div>}
      </div>

      <p className="trend__note">Days follow Kampala time. Order value excludes cancelled orders; collected = successful MoMo &amp; Airtel payments.</p>

      <table className="trend__sr">
        <caption>Last 7 days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {METRICS.map((m) => (
              <th key={m.key} scope="col">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{longDate(d.date)}</th>
              {METRICS.map((m) => (
                <td key={m.key}>{fmt(m, d[m.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
