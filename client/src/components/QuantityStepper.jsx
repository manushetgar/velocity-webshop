export default function QuantityStepper({ value, onChange, min = 1, max = 999, disabled = false }) {
  const set = v => onChange(Math.min(max, Math.max(min, Number(v) || min)));
  return (
    <div className={`stepper ${disabled ? 'disabled' : ''}`}>
      <button type="button" aria-label="Decrease quantity" disabled={disabled || value <= min} onClick={() => set(value - 1)}>−</button>
      <input value={value} inputMode="numeric" aria-label="Quantity" disabled={disabled}
             onChange={e => set(e.target.value.replace(/\D/g, ''))} />
      <button type="button" aria-label="Increase quantity" disabled={disabled || value >= max} onClick={() => set(value + 1)}>+</button>
    </div>
  );
}
