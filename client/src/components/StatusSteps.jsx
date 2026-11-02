const STEPS = ['NEW', 'PICKED', 'SHIPPED', 'COMPLETED'];
const LABELS = { NEW: 'Ordered', PICKED: 'Picked', SHIPPED: 'Shipped', COMPLETED: 'Delivered' };

export default function StatusSteps({ status }) {
  if (status === 'CANCELED') return <div className="steps canceled">Order canceled</div>;
  const current = STEPS.indexOf(status);
  return (
    <ol className="steps">
      {STEPS.map((s, i) => (
        <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
          <span className="bullet" />
          <span className="label">{LABELS[s]}</span>
        </li>
      ))}
    </ol>
  );
}
