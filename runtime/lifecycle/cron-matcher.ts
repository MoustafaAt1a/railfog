// spec: contracts/functions.contract.md#FN-2 — schedule triggers declare a
// standard 5-field cron expression ("*/5 * * * *"). A schedule trigger must
// fire on its declared schedule, not on a fixed polling tick.

/**
 * Parses a single cron field into the set of matching values for its domain.
 * Supports the standard subset: "*", step "*\/n", ranges "a-b", lists "a,b",
 * single values, and step applied to ranges "a-b/n".
 */
function parseField(
  field: string,
  min: number,
  max: number,
): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.toLowerCase().split("/");
    const step = stepPart !== undefined ? parseInt(stepPart, 10) : 1;
    if (Number.isNaN(step) || step < 1) {
      throw new Error(`Invalid cron step in field "${field}"`);
    }

    let start = min;
    let end = max;

    if (rangePart !== "*") {
      const [startStr, endStr] = rangePart.split("-");
      start = parseInt(startStr, 10);
      if (Number.isNaN(start)) {
        throw new Error(`Invalid cron field "${field}"`);
      }
      end = endStr !== undefined ? parseInt(endStr, 10) : start;
      if (Number.isNaN(end)) {
        throw new Error(`Invalid cron field "${field}"`);
      }
    }

    if (start < min || end > max || start > end) {
      throw new Error(`Cron field "${field}" out of range [${min}-${max}]`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }

  return values;
}

export interface CronExpression {
  /** True if the expression matches the given local-time moment. */
  matches(date: Date): boolean;
}

/**
 * Compiles a 5-field cron expression (minute hour day-of-month month
 * day-of-week) into a matcher. Throws ValidationFailedError-shaped Error on
 * malformed input — callers validate at snapshot ingestion time.
 *
 * spec: contracts/functions.contract.md#FN-2 — schedule trigger syntax
 */
export function compileCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Schedule must be a 5-field cron expression: "${expression}"`,
    );
  }

  const minutes = parseField(fields[0], 0, 59);
  const hours = parseField(fields[1], 0, 23);
  // Day-of-month and day-of-week follow standard cron OR semantics: the
  // trigger fires when either constraint matches (the other being "*").
  const daysOfMonth = parseField(fields[2], 1, 31);
  const months = parseField(fields[3], 1, 12);
  const daysOfWeek = parseField(fields[4], 0, 6); // 0 = Sunday

  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";

  return {
    matches(date: Date): boolean {
      if (!minutes.has(date.getMinutes())) return false;
      if (!hours.has(date.getHours())) return false;
      if (!months.has(date.getMonth() + 1)) return false;

      const domMatch = daysOfMonth.has(date.getDate());
      const dowMatch = daysOfWeek.has(date.getDay());

      if (domRestricted && dowRestricted) {
        return domMatch || dowMatch;
      }
      if (domRestricted) return domMatch;
      if (dowRestricted) return dowMatch;
      return true;
    },
  };
}
