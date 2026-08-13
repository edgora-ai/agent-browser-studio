// Pure cron-expression validation, shared by the automation scheduler and the
// rule CRUD services (IPC + REST). No Electron / IO dependencies.

export function parseCronField(field: string, min: number, max: number): number[] {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const f = part.trim();
    if (!f) throw new Error(`invalid cron field value: ${f}`);
    if (f === "*") { for (let i = min; i <= max; i++) result.add(i); continue; }
    const stepMatch = f.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${f}`);
      for (let i = min; i <= max; i += step) result.add(i);
      continue;
    }
    const rangeMatch = f.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]), hi = Number(rangeMatch[2]), step = Number(rangeMatch[3] || 1);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`invalid cron range: ${f}`);
      }
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${f}`);
      for (let i = lo; i <= hi; i += step) result.add(i);
      continue;
    }
    const n = Number(f);
    if (Number.isInteger(n) && n >= min && n <= max) result.add(n);
    else throw new Error(`invalid cron field value: ${f}`);
  }
  return [...result];
}

/** Validate a 5-field cron expression (min hour dom mon dow); throws on error. */
export function validateCron(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must have 5 fields: min hour dom mon dow");
  parseCronField(parts[0], 0, 59); // min
  parseCronField(parts[1], 0, 23); // hour
  parseCronField(parts[2], 1, 31); // dom
  parseCronField(parts[3], 1, 12); // mon
  parseCronField(parts[4], 0, 6);  // dow (0=Sun)
}
