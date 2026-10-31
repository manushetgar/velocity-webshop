// QuantityStepper.jsx - quantity input with - and + buttons (product page, cart).
//
// Props: current value, change handler, limits and a disabled flag.
export default function QuantityStepper({ value, onChange, min = 1, max = 999, disabled = false }) {
  // Sets a new value: only digits, limited to min..max (empty input becomes min).
  const set = v => onChange(Math.min(max, Math.max(min, Number(v) || min)));
  // The stepper markup.
  return (
    // Frame of the three parts (greyed out when disabled).
    <div className={`stepper ${disabled ? 'disabled' : ''}`}>
      {/* Minus button: disabled at the minimum. */}
      <button type="button" aria-label="Decrease quantity" disabled={disabled || value <= min} onClick={() => set(value - 1)}>−</button>
      {/* Text field for typing a number (numeric keyboard on phones); non-digits are removed. */}
      <input value={value} inputMode="numeric" aria-label="Quantity" disabled={disabled}
             onChange={e => set(e.target.value.replace(/\D/g, ''))} />
      {/* Plus button: disabled at the maximum (e.g. the stock). */}
      <button type="button" aria-label="Increase quantity" disabled={disabled || value >= max} onClick={() => set(value + 1)}>+</button>
    </div>
  );
}
