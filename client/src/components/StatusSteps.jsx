// StatusSteps.jsx - progress bar of an order: Ordered -> Picked -> Shipped -> Delivered.
//
// The status codes of the normal order life cycle, in order.
const STEPS = ['NEW', 'PICKED', 'SHIPPED', 'COMPLETED'];
// Labels for customers.
const LABELS = { NEW: 'Ordered', PICKED: 'Picked', SHIPPED: 'Shipped', COMPLETED: 'Delivered' };

// Progress indicator for the order life cycle (same status codes as the Mini-ERP)
export default function StatusSteps({ status }) {
  // Canceled orders have no progress: show a single line instead.
  if (status === 'CANCELED') return <div className="steps canceled">Order canceled</div>;
  // Position of the current status (0 = NEW).
  const current = STEPS.indexOf(status);
  // One list item per step.
  return (
    // Ordered list of the steps.
    <ol className="steps">
      {/* Steps before the current one are done, the current one is highlighted. */}
      {STEPS.map((s, i) => (
        // One step with its state class.
        <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
          {/* Dot of the step. */}
          <span className="bullet" />
          {/* Label of the step. */}
          <span className="label">{LABELS[s]}</span>
        </li>
      ))}
    </ol>
  );
}
