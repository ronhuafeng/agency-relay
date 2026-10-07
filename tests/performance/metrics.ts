/** Bounded lab statistics. Null is unavailable, never silently zero. No percentiles. */
export function distribution(values: Array<number | null>) {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!known.length) return { samples: 0, missing: values.length, min: null, median: null, max: null, mean: null, sampleSd: null };
  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  const middle = Math.floor(known.length / 2);
  return { samples: known.length, missing: values.length - known.length, min: known[0], median: known.length % 2 ? known[middle]! : (known[middle-1]! + known[middle]!) / 2,
    max: known.at(-1), mean, sampleSd: known.length < 2 ? null : Math.sqrt(known.reduce((sum, value) => sum + (value-mean)**2, 0)/(known.length-1)) };
}

export function labCls(shifts: Array<{ startTime: number; value: number; hadRecentInput: boolean }>) {
  let maximum = 0, session = 0, start = 0, previous = -Infinity;
  for (const shift of shifts) {
    if (shift.hadRecentInput) continue;
    if (shift.startTime - previous >= 1000 || shift.startTime - start >= 5000) { session = 0; start = shift.startTime; }
    session += shift.value; previous = shift.startTime; maximum = Math.max(maximum, session);
  }
  return maximum;
}
