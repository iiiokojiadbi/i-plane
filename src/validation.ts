import { flagValue, type ParsedArgs, UsageError } from "./args.ts";

export const required = (value: string | undefined, expected: string): string => {
  if (value === undefined || value.trim() === "") throw new UsageError(`Expected ${expected}.`);
  return value.trim();
};

export const requiredFlag = (args: ParsedArgs, name: string): string =>
  required(flagValue(args, name), `--${name} <value>`);

export const choice = (value: string, choices: ReadonlyArray<string>, name: string): string => {
  const normalized = value.toLowerCase();
  if (!choices.includes(normalized))
    throw new UsageError(`--${name} expects ${choices.join(", ")}; got "${value}".`);
  return normalized;
};

export const dateValue = (value: string, name: string): string | null => {
  if (value === "none") return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new UsageError(`--${name} expects YYYY-MM-DD or none; got "${value}".`);
  }
  return value;
};

export const colorValue = (value: string): string => {
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new UsageError("--color expects a six-digit hex color, such as #336699.");
  return value;
};

export const references = (value: string): string[] => {
  if (value === "none" || value === "") return [];
  const refs = value.split(",").map((ref) => ref.trim());
  if (refs.some((ref) => ref === ""))
    throw new UsageError("Empty reference in comma-separated list.");
  return [...new Set(refs)];
};

export const requireChanges = (body: Record<string, unknown>): void => {
  if (Object.keys(body).length === 0)
    throw new UsageError("Nothing to change. Pass at least one field flag.");
};
