/** Native page placement; workspace pages never carry a project identifier. */
export type PagePlacement = { kind: "wiki" } | { kind: "project"; projectId: string };
export type PageTarget = string | PagePlacement;
export const pagePlacement = (target: PageTarget): PagePlacement =>
  typeof target === "string" ? { kind: "project", projectId: target } : target;
