/** Versioned server fixtures. The CLI checkout never reads a sibling repository. */
import schema from "../fixtures/core/http-0.4.0.json";
import { checkShape } from "./core-http-shape.mjs";
const configurationRoute = "GET /api/extensions/configuration/";
export function coreConfiguration(overrides: Record<string, unknown> = {}) {
  const value = {
    adapterApi: 3, coreVersion: schema.coreVersion, protocolVersion: schema.protocolVersion,
    planeVersion: "1.4.2", nativeBridge: null, readerFingerprint: "a".repeat(64),
    release: "fixture-release", extensions: [], ...overrides,
  };
  value.extensions = (value.extensions as Record<string, unknown>[]).map(entry => ({
    source: "fixture-product", styles: [], ...entry,
  }));
  checkShape(schema.routes[configurationRoute].success, value);
  return value;
}
export function coreReply(path: string, body: unknown, evidence: "current" | "historical" | "negative" = "current") {
  return Response.json(coreBody(`GET ${path}`, body, evidence));
}
export function coreBody<T>(route: string, body: T, evidence: "current" | "historical" | "negative" = "current"): T {
  if (evidence === "current") {
    const contract = schema.routes[route as keyof typeof schema.routes];
    if (!contract) throw new Error(`Unknown core fixture route: ${route}`);
    checkShape(contract.success, body);
  }
  return body;
}

/** Deliberate malformed server input; it must remain visible as a negative fixture. */
export function invalidCoreReply(body: unknown) { return Response.json(body); }
