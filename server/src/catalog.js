export const CATEGORIES = ['Bikes', 'E-Bikes', 'Accessories', 'Apparel'];

export const CATALOG = [
  { productID: 'DXTR1000', name: 'MTB', category: 'Bikes', price: 1200, stock: 25,
    description: 'Hardtail mountain bike with 29" wheels, air fork and 12-speed drivetrain for trails and rough terrain.' },
  { productID: 'GRVL1000', name: 'Gravel', category: 'Bikes', price: 2300, stock: 15,
    description: 'Lightweight gravel bike with wide tyre clearance and hydraulic disc brakes for road and light off-road.' },
  { productID: 'ROAD1000', name: 'Road Carbon', category: 'Bikes', price: 2900, stock: 6,
    description: 'Carbon road bike with aero frame, 2x12 drivetrain and tubeless-ready wheels.' },
  { productID: 'CITY1000', name: 'City', category: 'Bikes', price: 799, stock: 12,
    description: 'Comfortable city bike with rack, mudguards, hub dynamo lights and 7-speed hub gear.' },
  { productID: 'KIDS1000', name: 'Kids 20"', category: 'Bikes', price: 349, stock: 3,
    description: 'Robust 20-inch kids bike with low step-through frame and easy-to-reach brakes.' },
  { productID: 'EBK1000', name: 'E-Trekking', category: 'E-Bikes', price: 3100, stock: 8,
    description: 'Trekking e-bike with 625 Wh battery, mid-drive motor and up to 120 km range.' },
  { productID: 'EBK2000', name: 'E-MTB', category: 'E-Bikes', price: 4200, stock: 4,
    description: 'Full-suspension e-mountain bike with 750 Wh battery and 150 mm travel.' },
  { productID: 'HLMT0100', name: 'Helmet', category: 'Accessories', price: 89.9, stock: 40,
    description: 'Lightweight helmet with MIPS liner, rear LED and magnetic buckle. Size M.' },
  { productID: 'LOCK0100', name: 'Folding Lock', category: 'Accessories', price: 59.9, stock: 30,
    description: 'Hardened steel folding lock with frame mount, security level 10/15.' },
  { productID: 'LGHT0100', name: 'Light Set', category: 'Accessories', price: 39.9, stock: 0,
    description: 'USB-C rechargeable front and rear light set, road legal (StVZO).' },
  { productID: 'PUMP0100', name: 'Floor Pump', category: 'Accessories', price: 34.9, stock: 18,
    description: 'Floor pump with gauge and dual head for Presta and Schrader valves, up to 11 bar.' },
  { productID: 'BOTL0100', name: 'Water Bottle', category: 'Accessories', price: 9.9, stock: 120,
    description: 'BPA-free 750 ml bottle with soft valve.' },
  { productID: 'JRSY0100', name: 'Cycling Jersey', category: 'Apparel', price: 49.9, stock: 22,
    description: 'Breathable short-sleeve jersey with three back pockets and full zip.' },
  { productID: 'GLOV0100', name: 'Gloves', category: 'Apparel', price: 24.9, stock: 35,
    description: 'Padded summer gloves with touchscreen fingertips.' },
];

const BY_ID = new Map(CATALOG.map(p => [p.productID, p]));
export const catalogEntry = productID => BY_ID.get(String(productID || '').toUpperCase());
export const categoryFor = productID => catalogEntry(productID)?.category || 'Other';
