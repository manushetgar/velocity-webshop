const THEMES = {
  Bikes: { bg: ['#eef2ff', '#dfe6ff'], fg: '#3b5bdb' },
  'E-Bikes': { bg: ['#e6fbf5', '#cdf3e7'], fg: '#0f8a6a' },
  Accessories: { bg: ['#fff6e5', '#ffe9c2'], fg: '#b45f06' },
  Apparel: { bg: ['#fdeef4', '#fbdbe8'], fg: '#c2255c' },
  Other: { bg: ['#f2f4f7', '#e4e7ec'], fg: '#475467' },
};

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' };

const Bike = () => (
  <g {...S}>
    <circle cx="30" cy="56" r="17" /><circle cx="92" cy="56" r="17" />
    <path d="M30 56 L50 30 L80 30 L92 56 M50 30 L62 56 L30 56 M62 56 L80 30 M50 30 L46 20 M39 20 L54 20 M80 30 L77 19 L86 17" />
  </g>
);
const EBike = () => (
  <g>
    <Bike />
    <rect x="52" y="36" width="16" height="9" rx="2" transform="rotate(-50 60 40)" fill="currentColor" />
    <circle cx="104" cy="16" r="11" fill="currentColor" />
    <path d="M106 8 L100 17 L105 17 L102 25 L109 14 L104 14 Z" fill="#fff" />
  </g>
);
const Helmet = () => (
  <g {...S}>
    <path d="M18 58 C18 30 42 14 66 14 C92 14 104 34 104 50 L104 58 Z" />
    <path d="M48 20 L56 40 M66 16 L69 38 M84 20 L82 40 M18 58 L104 58" />
  </g>
);
const Lock = () => (
  <g {...S}>
    <path d="M44 40 L44 28 A16 16 0 0 1 76 28 L76 40" />
    <rect x="34" y="40" width="52" height="32" rx="7" />
    <path d="M60 52 L60 60" /><circle cx="60" cy="51" r="3" fill="currentColor" />
  </g>
);
const Light = () => (
  <g {...S}>
    <rect x="22" y="30" width="46" height="22" rx="10" />
    <path d="M68 34 L68 48 M76 30 L96 22 M78 41 L100 41 M76 52 L96 60 M36 52 L36 64 L52 64" />
  </g>
);
const Pump = () => (
  <g {...S}>
    <rect x="52" y="22" width="16" height="44" rx="4" />
    <path d="M42 14 L78 14 M60 14 L60 22 M34 70 L86 70 M60 66 L60 70 M68 58 C88 58 94 40 98 30" />
  </g>
);
const Bottle = () => (
  <g {...S}>
    <rect x="46" y="28" width="28" height="44" rx="8" />
    <path d="M54 28 L54 18 L66 18 L66 28 M51 12 L69 12 M46 44 L74 44" />
  </g>
);
const Jersey = () => (
  <g {...S}>
    <path d="M42 12 L52 8 C55 15 65 15 68 8 L78 12 L98 28 L88 40 L80 34 L80 72 L40 72 L40 34 L32 40 L22 28 Z" />
    <path d="M60 18 L60 44" />
  </g>
);
const Gloves = () => (
  <g {...S}>
    <path d="M44 70 L44 24 A4 4 0 0 1 52 24 L52 40 L52 16 A4 4 0 0 1 60 16 L60 40 L60 18 A4 4 0 0 1 68 18 L68 42 L68 28 A4 4 0 0 1 76 28 L76 52 C76 64 70 72 58 72 C50 72 44 70 44 70 Z" />
    <path d="M44 60 L76 60" />
  </g>
);
const Saddle = () => (
  <g {...S}>
    <path d="M26 38 C36 26 82 26 98 36 C92 46 72 48 58 50 C44 52 32 48 26 38 Z" />
    <path d="M58 50 L58 72 M48 72 L68 72" />
  </g>
);
const Tag = () => (
  <g {...S}>
    <path d="M30 20 L66 20 L94 48 L66 74 L30 40 Z" /><circle cx="44" cy="34" r="5" />
  </g>
);

function pick(product) {
  const t = `${product.name} ${product.productId}`.toLowerCase();
  if (/helm/.test(t)) return Helmet;
  if (/lock/.test(t)) return Lock;
  if (/light|lght/.test(t)) return Light;
  if (/pump/.test(t)) return Pump;
  if (/bottle|botl/.test(t)) return Bottle;
  if (/jersey|shirt|jrsy/.test(t)) return Jersey;
  if (/glove|glov/.test(t)) return Gloves;
  if (/saddle/.test(t)) return Saddle;
  if (product.category === 'E-Bikes' || /^e-|ebk/.test(t)) return EBike;
  if (product.category === 'Bikes') return Bike;
  return Tag;
}

export function themeFor(category) {
  return THEMES[category] || THEMES.Other;
}

export default function ProductArt({ product, size = 'card' }) {
  const theme = themeFor(product.category);
  const Art = pick(product);
  return (
    <div className={`art art-${size}`} aria-hidden="true"
         style={{ background: `linear-gradient(140deg, ${theme.bg[0]}, ${theme.bg[1]})`, color: theme.fg }}>
      <svg viewBox="0 0 120 84"><Art /></svg>
    </div>
  );
}

export { Bike as BikeArt };
