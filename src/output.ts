/*
 * Output shaping.
 *
 * The whole reason this CLI exists: Plane's own answer for seven work items is
 * about 6500 tokens of JSON, twenty-nine fields per item. The same seven printed
 * as lines is under a hundred. Commands therefore build a model and hand it to a
 * formatter; --json prints the model instead, for the rare case all fields matter.
 */

export interface Column {
  readonly name: string;
  readonly text: string;
}

/** Pads names into a column so a scanning eye — or a regex — finds the text. */
export const printColumns = (rows: ReadonlyArray<Column>, indent = "  "): ReadonlyArray<string> => {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.name.length));
  return rows.map((row) => `${indent}${row.name.padEnd(width)}  ${row.text}`);
};

/*
 * Every byte this process prints goes through emit or fail, and both scrub the
 * secret first. Guarding individual call sites failed twice: the token still
 * reached output through invalid JSON, a warning written after a successful
 * create, and a server echoing the key back inside a --json payload. A single
 * chokepoint cannot be forgotten at a new call site.
 */
let secret = "";

/** Registered once, as soon as configuration resolves. */
export const guardSecret = (value: string): void => {
  secret = value;
};

export const scrub = (text: string): string => {
  if (secret === "") return text;
  let safe = text.split(secret).join("[token]");
  // A token carrying whitespace reaches some error paths in pieces.
  for (const piece of secret.split(/\s+/)) {
    if (piece.length >= 12) safe = safe.split(piece).join("[token]");
  }
  return safe;
};

export const emit = (text: string): void => {
  const safe = scrub(text);
  process.stdout.write(safe.endsWith("\n") ? safe : `${safe}\n`);
};

/**
 * One place decides between machine and human output, so no command can forget
 * to support --json.
 */
export const printValue = <T>(value: T, json: boolean, format: (value: T) => string): void => {
  emit(json ? JSON.stringify(value, null, 2) : format(value));
};

export const fail = (message: string, code = 1): never => {
  process.stderr.write(`${scrub(message)}\n`);
  process.exit(code);
};

/** Diagnostics that are not fatal still go through the same guard. */
export const warn = (message: string): void => {
  process.stderr.write(`${scrub(message)}\n`);
};

/** Collapses whitespace: a work item title with a newline in it must stay one line. */
export const oneLine = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim();

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
