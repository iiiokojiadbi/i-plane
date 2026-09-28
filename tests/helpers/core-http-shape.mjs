/** Validate the deliberately small wire-schema vocabulary; reject unknown schema keywords. */
import assert from "node:assert/strict";

const keywords = new Set([
  "kind",
  "properties",
  "required",
  "additional",
  "values",
  "items",
  "const",
  "enum",
  "variants",
]);
export function checkShape(schema, value, path = "$") {
  for (const key of Object.keys(schema)) assert(keywords.has(key), `${path}: unknown schema keyword ${key}`);
  if (schema.variants) {
    const matches = schema.variants.filter((candidate) => {
      try {
        checkShape(candidate, value, path);
        return true;
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path}: expected exactly one response variant`);
    return;
  }
  if (Object.hasOwn(schema, "const")) {
    assert.deepEqual(value, schema.const, `${path}: constant changed`);
    return;
  }
  if (schema.enum) {
    assert(schema.enum.includes(value), `${path}: unknown value`);
    return;
  }
  if (schema.kind === "null") {
    assert.equal(value, null, `${path}: expected null`);
    return;
  }
  if (schema.kind === "integer") {
    assert(Number.isInteger(value), `${path}: expected integer`);
    return;
  }
  if (schema.kind === "array") {
    assert(Array.isArray(value), `${path}: expected array`);
    value.forEach((entry, index) => {
      checkShape(schema.items, entry, `${path}[${index}]`);
    });
    return;
  }
  if (schema.kind === "object") {
    assert(value && typeof value === "object" && !Array.isArray(value), `${path}: expected object`);
    for (const key of schema.required ?? [])
      assert(Object.hasOwn(value, key), `${path}.${key}: required response field missing`);
    for (const [key, entry] of Object.entries(value)) {
      const property = schema.properties?.[key] ?? schema.values;
      if (property) checkShape(property, entry, `${path}.${key}`);
      else assert.equal(schema.additional, true, `${path}.${key}: undeclared response field`);
    }
    return;
  }
  assert(["string", "number", "boolean"].includes(schema.kind), `${path}: invalid schema kind`);
  assert.equal(typeof value, schema.kind, `${path}: wrong value kind`);
}
