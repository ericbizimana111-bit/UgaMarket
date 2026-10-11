import { PhoneCall } from 'lucide-react';
import { useCalls } from '../../context/CallContext';

/** "Call customer" (in-browser voice call), shown next to "Message customer". */
export default function CallCustomerButton({ customer, className = 'btn btn--primary btn--sm btn--block', style }) {
  const { callCustomer, active } = useCalls();
  if (!customer?.id) return null;
  return (
    <button
      type="button"
      className={className}
      style={style}
      onClick={() => callCustomer({ id: customer.id, fullName: customer.fullName, phone: customer.phone })}
      disabled={Boolean(active)}
      title="Voice call this customer in the browser (they must have UgaMarket open; otherwise they get a missed-call notice)"
    >
      <PhoneCall size={14} aria-hidden="true" /> Call customer
    </button>
  );
}
