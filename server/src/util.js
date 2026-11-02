export function toCents(value) {
  return Math.round(Number(value) * 100);
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
