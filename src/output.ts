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

export const emit = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

/**
 * One place decides between machine and human output, so no command can forget
 * to support --json.
 */
export const printValue = <T>(value: T, json: boolean, format: (value: T) => string): void => {
  emit(json ? JSON.stringify(value, null, 2) : format(value));
};

export const fail = (message: string, code = 1): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

/** Collapses whitespace: a work item title with a newline in it must stay one line. */
export const oneLine = (text: string | null | undefined): string =>
  (text ?? "").replace(/\s+/g, " ").trim();

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
