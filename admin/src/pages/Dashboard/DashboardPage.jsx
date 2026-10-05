import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  CalendarDays,
  MessageCircle,
  Package,
  Plus,
  ShoppingBag,
  TrendingUp,
  Truck,
  Wallet,
} from 'lucide-react';
import api from '../../services/api';
import { CATALOG_ROLES, hasRole, useAuth } from '../../context/AuthContext';
import { useRealtimeEvent } from '../../context/RealtimeContext';
import { formatUGX, formatDateTime, formatRelative } from '../../utils/format';
import StatusBadge from '../../components/ui/StatusBadge';
import KpiCard from '../../components/ui/KpiCard';
import { CardSkeleton, TableSkeleton } from '../../components/ui/loaders';
import { ErrorState } from '../../components/ui/states';
import './DashboardPage.css';

/**
 * Operations dashboard. Every number comes from the backend:
 *  - GET /api/admin/dashboard/summary         today, queues, 7-day trend
 *  - GET /api/admin/orders?limit=8            recent orders
 *  - GET /api/admin/services/requests?limit=5 recent home-service bookings
 * Refreshes itself when a new order, payment or booking notification arrives.
 */
const count = (n) => (n ?? 0).toLocaleString('en-UG');
// Large shilling amounts are abbreviated so the headline stays on one line.
const money = (n) => {
  const v = Math.round(Number(n) || 0);
  if (v >= 100000000) return `${(v / 1000000).toFixed(0)}M`;
  if (v >= 10000000) return `${(v / 1000000).toFixed(1)}M`;
  return v.toLocaleString('en-UG');
};

export default function DashboardPage() {
  const { admin, role } = useAuth();
  const [summary, setSummary] = useState(null);
  const [recentOrders, setRecentOrders] = useState([]);
  const [recentBookings, setRecentBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sum, orders, bookings] = await Promise.all([
        api.get('/admin/dashboard/summary'),
        api.get('/admin/orders?page=1&limit=8').catch(() => null),
        api.get('/admin/services/requests?page=1&limit=5').catch(() => null),
      ]);
      setSummary(sum?.data || null);
      setRecentOrders(orders?.items || []);
      setRecentBookings(bookings?.data?.items || []);
    } catch (err) {
      setError(err.message || 'Unable to load dashboard data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeEvent('notification', (n) => {
    if (['NEW_ORDER', 'PAYMENT_RECEIVED', 'BALANCE_PAID', 'ORDER_CANCELLED', 'NEW_SERVICE_REQUEST'].includes(n.type)) load();
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = admin?.fullName?.split(' ')[0] || 'Admin';

  const today = summary?.today || {};
  const yesterday = summary?.yesterday || {};
  const q = summary?.queues || {};
  const trend = summary?.trend || [];
  const maxRevenue = Math.max(1, ...trend.map((d) => d.revenueUgx));
  const todayLabel = new Date().toLocaleDateString('en-UG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Kampala' });

  const kpis = [
    {
      label: "Today's orders",
      icon: ShoppingBag,
      tone: 'primary',
      to: '/orders',
      cta: 'Orders',
      value: count(today.orders),
      current: today.orders ?? 0,
      previous: yesterday.orders ?? 0,
      series: trend.map((d) => d.orders),
      hint: `${formatUGX(today.orderValueUgx)} value`,
    },
    {
      label: 'Collected today',
      icon: Wallet,
      tone: 'success',
      to: '/payments',
      cta: 'Payments',
      unit: 'UGX',
      value: money(today.paymentsCollectedUgx),
      current: today.paymentsCollectedUgx ?? 0,
      previous: yesterday.paymentsCollectedUgx ?? 0,
      series: trend.map((d) => d.paymentsUgx ?? 0),
      hint: 'MoMo & Airtel',
    },
    {
      label: 'Orders to confirm',
      icon: AlertTriangle,
      tone: q.ordersNeedingAction ? 'warning' : 'success',
      to: '/orders?status=COMMITMENT_PAID',
      cta: 'Review',
      value: count(q.ordersNeedingAction),
      status: q.ordersNeedingAction ? { label: 'Action needed', tone: 'warning' } : { label: 'All clear', tone: 'success' },
      hint: 'Deposit paid',
    },
    {
      label: 'Active deliveries',
      icon: Truck,
      tone: 'info',
      to: '/deliveries',
      cta: 'Track',
      value: count(q.activeDeliveries),
      status: q.activeDeliveries ? { label: 'In progress', tone: 'info' } : { label: 'None on the road', tone: 'neutral' },
      hint: 'Assigned, ready or out',
    },
    {
      label: 'Service bookings',
      icon: CalendarCheck,
      tone: q.newServiceRequests ? 'warning' : 'info',
      to: '/service-requests',
      cta: 'Bookings',
      value: count(q.openServiceRequests),
      status: q.newServiceRequests
        ? { label: `${count(q.newServiceRequests)} new to confirm`, tone: 'warning' }
        : q.openServiceRequests
          ? { label: 'In progress', tone: 'info' }
          : { label: 'All clear', tone: 'success' },
      hint: 'Open jobs',
    },
    {
      label: 'Unread messages',
      icon: MessageCircle,
      tone: q.unreadMessages ? 'danger' : 'success',
      to: '/messages',
      cta: 'Inbox',
      value: count(q.unreadMessages),
      status: q.unreadMessages ? { label: 'Reply needed', tone: 'danger' } : { label: 'All read', tone: 'success' },
      hint: 'From customers',
    },
  ];

  const attention = [
    q.ordersNeedingAction > 0 && { tone: 'warning', icon: ShoppingBag, text: `${q.ordersNeedingAction} paid order(s) waiting to be confirmed`, to: '/orders?status=COMMITMENT_PAID' },
    q.newServiceRequests > 0 && { tone: 'warning', icon: CalendarCheck, text: `${q.newServiceRequests} new service booking(s) to confirm`, to: '/service-requests' },
    q.unreadMessages > 0 && { tone: 'danger', icon: MessageCircle, text: `${q.unreadMessages} unread customer message(s)`, to: '/messages' },
    q.lowStockProducts > 0 && { tone: 'danger', icon: Package, text: `${q.lowStockProducts} active product(s) with 5 or fewer in stock`, to: '/inventory' },
    q.ordersAwaitingPayment > 0 && { tone: 'info', icon: Wallet, text: `${q.ordersAwaitingPayment} order(s) waiting for the customer's deposit`, to: '/orders?status=PENDING_PAYMENT' },
  ].filter(Boolean);

  return (
    <div>
      <header className="dash-head">
        <div>
          <p className="dash-head__date">
            <CalendarDays size={14} aria-hidden="true" /> {todayLabel}
          </p>
          <h1>
            {greeting}, {firstName}
          </h1>
          <p className="dash-head__sub">Here is what is happening across orders, deliveries, home services and customer messages today.</p>
        </div>
        <div className="dash-head__actions">
          <Link to="/orders" className="btn btn--secondary">
            <ShoppingBag size={15} aria-hidden="true" /> All orders
          </Link>
          {hasRole(role, CATALOG_ROLES) && (
            <Link to="/products/new" className="btn btn--primary">
              <Plus size={15} aria-hidden="true" /> Add product
            </Link>
          )}
        </div>
      </header>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {loading ? (
            <CardSkeleton count={6} />
          ) : (
            <div className="kpi-board">
              {kpis.map((kpi) => (
                <KpiCard key={kpi.label} {...kpi} />
              ))}
            </div>
          )}

          <div className="section-grid">
            <div className="dash-col">
              <section aria-label="Last 7 days">
                <div className="section-title">
                  <TrendingUp size={14} aria-hidden="true" /> Last 7 days
                </div>
                <div className="panel panel-pad dash-trend">
                  {trend.length === 0 ? (
                    <p className="text-muted">No data yet.</p>
                  ) : (
                    <ol className="dash-trend__bars">
                      {trend.map((d) => (
                        <li key={d.date} title={`${d.date}: ${d.orders} orders · ${formatUGX(d.revenueUgx)}`}>
                          <span className="dash-trend__value">{d.orders}</span>
                          <span className="dash-trend__bar" style={{ height: `${Math.max(4, Math.round((d.revenueUgx / maxRevenue) * 100))}%` }} />
                          <span className="dash-trend__day">{new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-UG', { weekday: 'short' })}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="subtle-note">Bar height = order value; number = orders placed (Kampala time).</p>
                </div>
              </section>

              <section aria-label="Recent orders">
                <div className="section-title">Recent Orders</div>
                {loading ? (
                  <TableSkeleton rows={6} columns={5} />
                ) : recentOrders.length === 0 ? (
                  <div className="panel panel-pad text-muted">No orders have been placed yet.</div>
                ) : (
                  <div className="panel">
                    <table className="dash-table">
                      <thead>
                        <tr>
                          <th scope="col">Order</th>
                          <th scope="col">Customer</th>
                          <th scope="col">Deliver to</th>
                          <th scope="col">Total</th>
                          <th scope="col">Status</th>
                          <th scope="col" aria-label="Open" />
                        </tr>
                      </thead>
                      <tbody>
                        {recentOrders.map((order) => (
                          <tr key={order.id}>
                            <td data-label="Order">
                              <Link to={`/orders/${order.id}`} className="mono">
                                {order.orderNumber}
                              </Link>
                              <div className="dash-table__sub">{formatDateTime(order.createdAt)}</div>
                            </td>
                            <td data-label="Customer">{order.customer?.fullName || '—'}</td>
                            <td data-label="Deliver to">{[order.fulfillment?.address?.division, order.fulfillment?.address?.district].filter(Boolean).join(', ') || '—'}</td>
                            <td data-label="Total">{formatUGX(order.pricing?.totalUgx)}</td>
                            <td data-label="Status">
                              <StatusBadge status={order.status} />
                            </td>
                            <td data-label="">
                              <Link to={`/orders/${order.id}`} className="dash-table__open" aria-label={`Open order ${order.orderNumber}`}>
                                <ArrowRight size={15} aria-hidden="true" />
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            <div className="dash-col">
              <section aria-label="Needs attention">
                <div className="section-title">Needs attention</div>
                <div className="panel panel-pad dash-alerts">
                  {loading ? (
                    <CardSkeleton count={1} />
                  ) : attention.length === 0 ? (
                    <div className="dash-alert dash-alert--success">
                      <Package size={16} aria-hidden="true" />
                      <span>All caught up — nothing needs attention right now.</span>
                    </div>
                  ) : (
                    attention.map((a) => (
                      <Link key={a.text} to={a.to} className={`dash-alert dash-alert--${a.tone}`}>
                        <a.icon size={16} aria-hidden="true" />
                        <span>{a.text}</span>
                      </Link>
                    ))
                  )}
                </div>
              </section>

              <section aria-label="Recent service bookings">
                <div className="section-title">Recent service bookings</div>
                <div className="panel panel-pad">
                  {recentBookings.length === 0 ? (
                    <p className="text-muted">No home-service bookings yet.</p>
                  ) : (
                    <ul className="dash-bookings">
                      {recentBookings.map((b) => (
                        <li key={b.id}>
                          <Link to={`/service-requests/${b.id}`}>
                            <span>
                              <strong>{b.service?.name}</strong>
                              <small>
                                {b.customer?.fullName} · {b.address?.district} · {formatRelative(b.createdAt)}
                              </small>
                            </span>
                            <StatusBadge status={b.status} kind="booking" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
