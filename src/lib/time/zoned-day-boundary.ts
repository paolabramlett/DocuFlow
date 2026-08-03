/**
 * Computes the UTC instant of local midnight in `timeZone`, `daysFromNow` days from `now` — backed
 * by the real IANA/ICU timezone database via Intl, never a hardcoded offset (a flat "subtract 6
 * hours" breaks across any offset transition, historical or future). Used by
 * getOperativeCounts's "Completados hoy" metric (src/features/cases/queries.ts).
 */
export function zonedDayBoundaryToUtc(now: Date, timeZone: string, daysFromNow: number): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  const day = Number(parts.find((p) => p.type === "day")!.value) + daysFromNow;

  // Start from a naive UTC guess for that Y-M-D, then correct twice using the zone's ACTUAL offset
  // at the current candidate instant — two corrections converge exactly even in the rare case
  // where the first correction itself crosses an offset-transition instant.
  let candidate = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const offsetMinutes = offsetMinutesAt(new Date(candidate), timeZone);
    candidate = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60_000;
  }
  return new Date(candidate);
}

function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(instant);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(offsetPart);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}
