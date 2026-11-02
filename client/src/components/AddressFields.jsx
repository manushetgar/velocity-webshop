export const EMPTY_ADDRESS = { street: '', houseNumber: '', postalCode: '', city: '', countryCode: 'DE' };

export default function AddressFields({ value, onChange }) {
  const set = k => e => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <label className="span-2">Street<input value={value.street} onChange={set('street')} /></label>
      <label>House no.<input value={value.houseNumber} onChange={set('houseNumber')} /></label>
      <label>Postal code<input value={value.postalCode} onChange={set('postalCode')} /></label>
      <label className="span-2">City<input value={value.city} onChange={set('city')} /></label>
      <label>Country<input value={value.countryCode} maxLength="2" onChange={set('countryCode')} /></label>
    </>
  );
}
