// AddressFields.jsx - the address inputs used in registration, My account and checkout.
//
// An empty address (Germany as default country, ISO code like the ERP's Country association).
export const EMPTY_ADDRESS = { street: '', houseNumber: '', postalCode: '', city: '', countryCode: 'DE' };

// Address split into fields the same way as in the Mini-ERP Customers entity
export default function AddressFields({ value, onChange }) {
  // Change handler for one field: copy the address and replace that field (k = field name).
  const set = k => e => onChange({ ...value, [k]: e.target.value });
  // The fields (placed in the surrounding form grid).
  return (
    // Fragment: the labels become direct children of the form grid.
    <>
      {/* Street (two grid columns wide). */}
      <label className="span-2">Street<input value={value.street} onChange={set('street')} /></label>
      {/* House number. */}
      <label>House no.<input value={value.houseNumber} onChange={set('houseNumber')} /></label>
      {/* Postal code. */}
      <label>Postal code<input value={value.postalCode} onChange={set('postalCode')} /></label>
      {/* City (two grid columns wide). */}
      <label className="span-2">City<input value={value.city} onChange={set('city')} /></label>
      {/* Country as a two-letter ISO code (DE, AT, NL ...). */}
      <label>Country<input value={value.countryCode} maxLength="2" onChange={set('countryCode')} /></label>
    </>
  );
}
