/** Last 4 digits of incidentId, digits-only, left-padded. Collisions disambiguated by caller. */
export function toDisplayId(incidentId: string): string {
  const digits = incidentId.replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "0");
}

/** `${yy}${mm}${dd}-${displayId}` from the incident datetime. UTC so refs are timezone-stable. */
export function toRef(incidentId: string, at: Date): string {
  const yy = String(at.getUTCFullYear()).slice(-2);
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}-${toDisplayId(incidentId)}`;
}
