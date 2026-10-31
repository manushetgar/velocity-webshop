// Icons.jsx - small line icons as inline SVG components (no icon library). Each icon takes extra props, e.g.
// <CartIcon width={24} />.
//
// Common SVG attributes: 24x24 drawing area shown at 18 px, lines in the current text color, hidden from screen readers.
const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

// Shopping cart (header).
export const CartIcon = p => (
  // Wheels of the cart.
  <svg {...base} {...p}><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" />
    {/* Basket and handle. */}
    <path d="M2.5 3h2.6l2.4 11.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.2L21 7H6.2" /></svg>
);
// Person (login link).
export const UserIcon = p => (
  // Head and shoulders.
  <svg {...base} {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
);
// Delivery truck (shop benefits).
export const TruckIcon = p => (
  // Truck body and wheels.
  <svg {...base} {...p}><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></svg>
);
// Shield with a check mark (secure checkout).
export const ShieldIcon = p => (
  // Shield and check mark.
  <svg {...base} {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
);
// Two arrows in a circle (ERP sync).
export const SyncIcon = p => (
  // Arcs and arrow heads.
  <svg {...base} {...p}><path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3" /><path d="M4 4v4h4M20 20v-4h-4" /></svg>
);
// Return arrow (returns).
export const ReturnIcon = p => (
  // Arrow and curve.
  <svg {...base} {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-4" /></svg>
);
// Check mark.
export const CheckIcon = p => (
  // Check mark path.
  <svg {...base} {...p}><path d="M5 12l5 5 9-10" /></svg>
);
// Database (ERP).
export const DatabaseIcon = p => (
  // Cylinder.
  <svg {...base} {...p}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>
);
// Arrow to the left (back links).
export const ArrowLeftIcon = p => (
  // Arrow path.
  <svg {...base} {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
);
// Magnifier (search field).
export const SearchIcon = p => (
  // Lens and handle.
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);
