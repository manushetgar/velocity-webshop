// ---------------------------------------------------------------------------------------------------------------
// util.js - small helper functions shared by the routes and services of the web shop backend.
//
//  - toCents():   converts a money amount given in euros (e.g. 89.9 from the ERP REST API or from the admin form)
//                 into whole cents. Cents are the format in which the shop stores all money values in SQLite
//                 (see db.js: price_cents, total_cents, unit_price_cents, item_total_cents).
//  - httpError(): creates an Error object that carries an HTTP status code. Route handlers simply `throw` it and
//                 the central error handler in index.js turns it into a JSON response { error: "<message>" }.
//
// This file has no imports and no dependencies, so every other module can use it without creating import cycles.
// ---------------------------------------------------------------------------------------------------------------

// Converts a money amount in euros (a number or a numeric string such as "19.99") into an integer number of cents.
// Why integers: binary floating-point numbers cannot represent most decimal fractions exactly (0.1 + 0.2 !== 0.3),
// so the shop stores and adds up money as whole cents and only converts at the boundaries (ERP API, admin input,
// JSON output). Used e.g. by services/productSync.js for the prices received from the ERP and by routes/products.js.
// `export` makes the function importable by other modules (ES modules: "type": "module" in server/package.json).
export function toCents(value) {
  // Number(value) turns a string like "19.99" into the number 19.99 (invalid input becomes NaN);
  // "* 100" converts euros to cents; Math.round() removes the floating-point noise of the multiplication,
  // e.g. 19.99 * 100 = 1998.9999999999998 in JavaScript -> Math.round gives the correct 1999.
  return Math.round(Number(value) * 100);
}

// Creates an Error that carries an HTTP status code (e.g. 400 Bad Request, 404 Not Found, 409 Conflict).
// Typical use in a route: `throw httpError(404, 'Product not found.')`. Express 5 forwards errors thrown in route
// handlers - also in async handlers (rejected promises) - to the error-handling middleware in index.js, which sends
// res.status(err.status).json({ error: err.message }). This keeps the validation code in the routes short and makes
// all error responses of the API look the same, which the React frontend relies on to show the message.
export function httpError(status, message) {
  // A normal JavaScript Error object; `message` is the readable text that the frontend shows to the user.
  const err = new Error(message);
  // Custom property read by the central error handler (index.js) to choose the HTTP status of the response.
  // Errors without a status (unexpected bugs) become 500 Internal Server Error there.
  err.status = status;
  // The error is returned, not thrown, so the caller writes `throw httpError(...)` - the throw stays visible at the
  // call site, which makes the control flow of the route easy to read.
  return err;
}
