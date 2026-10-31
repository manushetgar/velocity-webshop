/**
 * Demo catalog. Used
 *  - as local sample data when no ERP is connected, and
 *  - to load the ERP with products (Admin > ERP > "Load demo catalog into ERP").
 * The category is web-shop data (merchandising) that the ERP does not know; it is kept locally.
 * The first two products are the Mini-ERP sample data.
 *
 * Role in the architecture (where this file is used):
 *  - db.js inserts these products into an empty shop database (shop-only sample data; it is shown only while no
 *    SAP connector is active).
 *  - services/erpMasterData.js (loadCatalogIntoErp) creates every product of this list that is missing in the ERP
 *    through the ERP API. Existing ERP data (prices, stock) is not overwritten, because the ERP is the master.
 *  - services/productSync.js and db.js call categoryFor() to give products that come from the ERP their shop
 *    category, because the ERP product has no category field.
 * This file has no imports: it is pure data plus two small lookup functions.
 */
// The product categories of the shop. Exported for routes/products.js, which returns them via
// GET /api/products/categories and validates the category of a created/edited product against this list
// (the extra value 'Other' is also accepted there).
export const CATEGORIES = ['Bikes', 'E-Bikes', 'Accessories', 'Apparel'];

// The demo products. Fields of every entry:
//  - productID:   business key, written exactly like the ERP's productID (upper case); it is used to match a catalog
//                 entry with the ERP product and with the shop row (products.product_id)
//  - name:        product name shown in the shop and stored in the ERP
//  - category:    shop-only merchandising data (one of CATEGORIES), not sent to the ERP
//  - price:       price in euros as a decimal number (the ERP format); the shop converts it to cents for SQLite
//  - stock:       initial stock quantity (0 = sold out, small numbers make the "low stock" warning visible)
//  - description: long text for the product detail page
export const CATALOG = [
  // Mini-ERP sample product 1 (exists in the ERP's initial data from Lab 0): hardtail mountain bike.
  { productID: 'DXTR1000', name: 'MTB', category: 'Bikes', price: 1200, stock: 25,
    description: 'Hardtail mountain bike with 29" wheels, air fork and 12-speed drivetrain for trails and rough terrain.' },
  // Mini-ERP sample product 2 (also part of the ERP's initial data): gravel bike.
  { productID: 'GRVL1000', name: 'Gravel', category: 'Bikes', price: 2300, stock: 15,
    description: 'Lightweight gravel bike with wide tyre clearance and hydraulic disc brakes for road and light off-road.' },
  // From here on: additional demo products. They exist in the ERP only after the demo catalog has been loaded into it
  // ("Load demo catalog" button, or automatically for a connector with auto catalog). Carbon road bike.
  { productID: 'ROAD1000', name: 'Road Carbon', category: 'Bikes', price: 2900, stock: 6,
    description: 'Carbon road bike with aero frame, 2x12 drivetrain and tubeless-ready wheels.' },
  // City bike (cheaper price range).
  { productID: 'CITY1000', name: 'City', category: 'Bikes', price: 799, stock: 12,
    description: 'Comfortable city bike with rack, mudguards, hub dynamo lights and 7-speed hub gear.' },
  // Kids bike; stock 3 is below the low-stock threshold (<= 5) of the admin dashboard (routes/admin.js).
  { productID: 'KIDS1000', name: 'Kids 20"', category: 'Bikes', price: 349, stock: 3,
    description: 'Robust 20-inch kids bike with low step-through frame and easy-to-reach brakes.' },
  // Trekking e-bike (category E-Bikes).
  { productID: 'EBK1000', name: 'E-Trekking', category: 'E-Bikes', price: 3100, stock: 8,
    description: 'Trekking e-bike with 625 Wh battery, mid-drive motor and up to 120 km range.' },
  // E-mountain bike; stock 4 also shows up as low stock.
  { productID: 'EBK2000', name: 'E-MTB', category: 'E-Bikes', price: 4200, stock: 4,
    description: 'Full-suspension e-mountain bike with 750 Wh battery and 150 mm travel.' },
  // Helmet (category Accessories); a price with decimals (89.9 euros = 8990 cents in the shop database).
  { productID: 'HLMT0100', name: 'Helmet', category: 'Accessories', price: 89.9, stock: 40,
    description: 'Lightweight helmet with MIPS liner, rear LED and magnetic buckle. Size M.' },
  // Folding lock.
  { productID: 'LOCK0100', name: 'Folding Lock', category: 'Accessories', price: 59.9, stock: 30,
    description: 'Hardened steel folding lock with frame mount, security level 10/15.' },
  // Light set with stock 0: demonstrates a sold-out product (it cannot be ordered).
  { productID: 'LGHT0100', name: 'Light Set', category: 'Accessories', price: 39.9, stock: 0,
    description: 'USB-C rechargeable front and rear light set, road legal (StVZO).' },
  // Floor pump.
  { productID: 'PUMP0100', name: 'Floor Pump', category: 'Accessories', price: 34.9, stock: 18,
    description: 'Floor pump with gauge and dual head for Presta and Schrader valves, up to 11 bar.' },
  // Water bottle (cheapest product, high stock).
  { productID: 'BOTL0100', name: 'Water Bottle', category: 'Accessories', price: 9.9, stock: 120,
    description: 'BPA-free 750 ml bottle with soft valve.' },
  // Cycling jersey (category Apparel = clothing).
  { productID: 'JRSY0100', name: 'Cycling Jersey', category: 'Apparel', price: 49.9, stock: 22,
    description: 'Breathable short-sleeve jersey with three back pockets and full zip.' },
  // Gloves (category Apparel).
  { productID: 'GLOV0100', name: 'Gloves', category: 'Apparel', price: 24.9, stock: 35,
    description: 'Padded summer gloves with touchscreen fingertips.' },
];

// Lookup table productID -> catalog entry, built once when the module is loaded. CATALOG.map(...) creates
// [key, value] pairs and new Map(...) turns them into a Map, so a lookup is a direct access instead of searching
// the array every time. Not exported: other modules use catalogEntry() / categoryFor() below.
const BY_ID = new Map(CATALOG.map(p => [p.productID, p]));
// Returns the catalog entry for a productID, or undefined if the product is not part of the demo catalog.
// String(productID || '') also handles null/undefined (-> '') and non-string values; toUpperCase() makes the lookup
// case-insensitive, so "dxtr1000" coming from user input or the ERP still finds DXTR1000.
export const catalogEntry = productID => BY_ID.get(String(productID || '').toUpperCase());
// Returns the shop category for a productID: the category of the demo catalog entry, or 'Other' for products that
// are not in the catalog (e.g. products created directly in the ERP). The optional chaining `?.` avoids an error
// when catalogEntry() returns undefined; `||` then falls back to 'Other'.
export const categoryFor = productID => catalogEntry(productID)?.category || 'Other';
