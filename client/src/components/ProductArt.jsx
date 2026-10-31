// ProductArt.jsx - product pictures without image files: simple SVG line drawings chosen by the product type
// (bike, helmet, lock ...) on a gradient in the color of the category. Used on cards, the product page and the cart.
//
// Product illustrations (simple line drawings) chosen by product type, tinted by category.
// Colors per shop category: two background colors (gradient) and the line color.
const THEMES = {
  // Bikes: blue.
  Bikes: { bg: ['#eef2ff', '#dfe6ff'], fg: '#3b5bdb' },
  // E-Bikes: green.
  'E-Bikes': { bg: ['#e6fbf5', '#cdf3e7'], fg: '#0f8a6a' },
  // Accessories: orange.
  Accessories: { bg: ['#fff6e5', '#ffe9c2'], fg: '#b45f06' },
  // Apparel: pink.
  Apparel: { bg: ['#fdeef4', '#fbdbe8'], fg: '#c2255c' },
  // Products without a known category: grey.
  Other: { bg: ['#f2f4f7', '#e4e7ec'], fg: '#475467' },
};

// Common line style of the drawings: no fill, rounded lines in the current color (= the theme color).
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' };

// Bike: two wheels and the frame.
const Bike = () => (
  // Group with the line style.
  <g {...S}>
    {/* Rear and front wheel. */}
    <circle cx="30" cy="56" r="17" /><circle cx="92" cy="56" r="17" />
    {/* Frame, fork, saddle and handlebar as one path. */}
    <path d="M30 56 L50 30 L80 30 L92 56 M50 30 L62 56 L30 56 M62 56 L80 30 M50 30 L46 20 M39 20 L54 20 M80 30 L77 19 L86 17" />
  </g>
);
// E-bike: the bike plus a battery and a lightning symbol.
const EBike = () => (
  // Group of all parts.
  <g>
    {/* The normal bike drawing. */}
    <Bike />
    {/* Battery on the down tube. */}
    <rect x="52" y="36" width="16" height="9" rx="2" transform="rotate(-50 60 40)" fill="currentColor" />
    {/* Filled circle at the top right. */}
    <circle cx="104" cy="16" r="11" fill="currentColor" />
    {/* White lightning symbol in the circle. */}
    <path d="M106 8 L100 17 L105 17 L102 25 L109 14 L104 14 Z" fill="#fff" />
  </g>
);
// Helmet.
const Helmet = () => (
  // Group with the line style.
  <g {...S}>
    {/* Helmet shell. */}
    <path d="M18 58 C18 30 42 14 66 14 C92 14 104 34 104 50 L104 58 Z" />
    {/* Air vents and the lower edge. */}
    <path d="M48 20 L56 40 M66 16 L69 38 M84 20 L82 40 M18 58 L104 58" />
  </g>
);
// Lock.
const Lock = () => (
  // Group with the line style.
  <g {...S}>
    {/* Shackle. */}
    <path d="M44 40 L44 28 A16 16 0 0 1 76 28 L76 40" />
    {/* Lock body. */}
    <rect x="34" y="40" width="52" height="32" rx="7" />
    {/* Keyhole. */}
    <path d="M60 52 L60 60" /><circle cx="60" cy="51" r="3" fill="currentColor" />
  </g>
);
// Light.
const Light = () => (
  // Group with the line style.
  <g {...S}>
    {/* Lamp body. */}
    <rect x="22" y="30" width="46" height="22" rx="10" />
    {/* Light beams and the mount. */}
    <path d="M68 34 L68 48 M76 30 L96 22 M78 41 L100 41 M76 52 L96 60 M36 52 L36 64 L52 64" />
  </g>
);
// Pump.
const Pump = () => (
  // Group with the line style.
  <g {...S}>
    {/* Pump barrel. */}
    <rect x="52" y="22" width="16" height="44" rx="4" />
    {/* Handle, base and hose. */}
    <path d="M42 14 L78 14 M60 14 L60 22 M34 70 L86 70 M60 66 L60 70 M68 58 C88 58 94 40 98 30" />
  </g>
);
// Bottle.
const Bottle = () => (
  // Group with the line style.
  <g {...S}>
    {/* Bottle body. */}
    <rect x="46" y="28" width="28" height="44" rx="8" />
    {/* Cap and a line on the bottle. */}
    <path d="M54 28 L54 18 L66 18 L66 28 M51 12 L69 12 M46 44 L74 44" />
  </g>
);
// Jersey.
const Jersey = () => (
  // Group with the line style.
  <g {...S}>
    {/* Shirt outline with sleeves. */}
    <path d="M42 12 L52 8 C55 15 65 15 68 8 L78 12 L98 28 L88 40 L80 34 L80 72 L40 72 L40 34 L32 40 L22 28 Z" />
    {/* Zip. */}
    <path d="M60 18 L60 44" />
  </g>
);
// Gloves.
const Gloves = () => (
  // Group with the line style.
  <g {...S}>
    {/* Hand with four fingers. */}
    <path d="M44 70 L44 24 A4 4 0 0 1 52 24 L52 40 L52 16 A4 4 0 0 1 60 16 L60 40 L60 18 A4 4 0 0 1 68 18 L68 42 L68 28 A4 4 0 0 1 76 28 L76 52 C76 64 70 72 58 72 C50 72 44 70 44 70 Z" />
    {/* Cuff. */}
    <path d="M44 60 L76 60" />
  </g>
);
// Saddle.
const Saddle = () => (
  // Group with the line style.
  <g {...S}>
    {/* Saddle shape. */}
    <path d="M26 38 C36 26 82 26 98 36 C92 46 72 48 58 50 C44 52 32 48 26 38 Z" />
    {/* Seat post and clamp. */}
    <path d="M58 50 L58 72 M48 72 L68 72" />
  </g>
);
// Price tag (fallback for unknown products).
const Tag = () => (
  // Group with the line style.
  <g {...S}>
    {/* Tag outline and hole. */}
    <path d="M30 20 L66 20 L94 48 L66 74 L30 40 Z" /><circle cx="44" cy="34" r="5" />
  </g>
);

// Chooses the drawing for a product from words in its name or product ID (e.g. HLMT0100 -> helmet).
function pick(product) {
  // Name and product ID in lower case, searched together.
  const t = `${product.name} ${product.productId}`.toLowerCase();
  // Helmet (also German 'Helm').
  if (/helm/.test(t)) return Helmet;
  // Lock.
  if (/lock/.test(t)) return Lock;
  // Light (also the ID prefix LGHT).
  if (/light|lght/.test(t)) return Light;
  // Pump.
  if (/pump/.test(t)) return Pump;
  // Bottle (also BOTL).
  if (/bottle|botl/.test(t)) return Bottle;
  // Jersey or shirt (also JRSY).
  if (/jersey|shirt|jrsy/.test(t)) return Jersey;
  // Gloves (also GLOV).
  if (/glove|glov/.test(t)) return Gloves;
  // Saddle.
  if (/saddle/.test(t)) return Saddle;
  // E-bike by category, a name starting with 'E-' or the ID part EBK.
  if (product.category === 'E-Bikes' || /^e-|ebk/.test(t)) return EBike;
  // Other bikes.
  if (product.category === 'Bikes') return Bike;
  // Anything else: price tag.
  return Tag;
}

// Colors of a category (grey for unknown categories); also used by other components.
export function themeFor(category) {
  // Known category or the fallback.
  return THEMES[category] || THEMES.Other;
}

// The picture of a product; size = card / thumb / large (CSS classes art-card, art-thumb, art-large).
export default function ProductArt({ product, size = 'card' }) {
  // Colors of the product's category.
  const theme = themeFor(product.category);
  // The drawing component for this product.
  const Art = pick(product);
  // The picture markup.
  return (
    // Frame with the gradient background (decorative: hidden from screen readers).
    <div className={`art art-${size}`} aria-hidden="true"
         style={{ background: `linear-gradient(140deg, ${theme.bg[0]}, ${theme.bg[1]})`, color: theme.fg }}>
      {/* Drawing area 120x84; the line color comes from the frame's color. */}
      <svg viewBox="0 0 120 84"><Art /></svg>
    </div>
  );
}

// The bike drawing is also used on its own (e.g. the shop's hero banner).
export { Bike as BikeArt };
