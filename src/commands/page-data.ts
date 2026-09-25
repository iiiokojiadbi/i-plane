import { PlaneError } from "../client.ts";
import { scrubHtml } from "../html-secrets.ts";
import { oneLine, printColumns } from "../output.ts";
import { pageHtmlToMarkdown } from "../page-html.ts";
import { type PagePlacement, type PageTarget, pagePlacement } from "../page-placement.ts";
import type { PageClient } from "../page-transport.ts";
import { isUuid, resolveNamed } from "../resolve.ts";
import type { Project } from "../types.ts";

export interface Page {
  readonly id: string;
  readonly name: string;
  readonly description_html?: string | null;
  readonly description_json?: unknown;
  readonly updated_at?: string;
  readonly is_locked?: boolean;
  readonly access?: number;
  readonly archived_at?: string | null;
  readonly parent?: string | null;
  readonly sort_order?: number;
  readonly created_at?: string;
}
export const projectOfPage = async (client: PageClient, ref: string): Promise<Project> => {
  let result: Project;
  if (isUuid(ref)) result = await client.request<Project>(`projects/${ref}/`);
  else {
    const projects = await client.listAll<Project>("projects/");
    const matches = projects.filter(
      (project) => project.identifier.toLowerCase() === ref.toLowerCase(),
    );
    result =
      matches.length === 1 && matches[0] ? matches[0] : resolveNamed(projects, ref, "project");
  }
  if ((await client.preparePages?.(result.id)) === "changed-identity")
    return projectOfPage(client, ref);
  return result;
};
export const placementOf = async (
  client: PageClient,
  projectRef?: string,
): Promise<PagePlacement> => {
  if (projectRef !== undefined)
    return { kind: "project", projectId: (await projectOfPage(client, projectRef)).id };
  const placement = { kind: "wiki" } as const;
  await client.preparePages?.(placement);
  return placement;
};
export const pagesPath = (target: PageTarget): string => {
  const placement = pagePlacement(target);
  return placement.kind === "wiki" ? "pages/" : `projects/${placement.projectId}/pages/`;
};
/** Native sibling rank order, flattened preorder; corrupt cycles stay visible once. */
export const wikiPages = (pages: ReadonlyArray<Page>): Page[] => {
  const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = pages
    .map((page) => ({ ...page, parent: page.parent ?? null }))
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        compareText(a.created_at ?? "", b.created_at ?? "") ||
        compareText(a.id, b.id),
    );
  const ids = new Set(ordered.map((page) => page.id));
  const children = new Map<string, Page[]>();
  for (const page of ordered) {
    const parent = page.parent && ids.has(page.parent) ? page.parent : "";
    const rows = children.get(parent) ?? [];
    rows.push(page);
    children.set(parent, rows);
  }
  const result: Page[] = [],
    seen = new Set<string>();
  const append = (roots: Page[]) => {
    const stack = roots.slice().reverse();
    while (stack.length) {
      const page = stack.pop();
      if (!page || seen.has(page.id)) continue;
      seen.add(page.id);
      result.push(page);
      for (const child of (children.get(page.id) ?? []).slice().reverse()) stack.push(child);
    }
  };
  append(children.get("") ?? []);
  append(ordered);
  return result;
};
export const pagesOf = async (
  client: PageClient,
  target: PageTarget,
): Promise<ReadonlyArray<Page>> => {
  const pages = await client.listAll<Page>(pagesPath(target));
  return pagePlacement(target).kind === "wiki" ? wikiPages(pages) : pages;
};
export const pageOf = async (
  client: PageClient,
  target: PageTarget,
  ref: string,
): Promise<Page> => {
  const id = isUuid(ref) ? ref : resolveNamed(await pagesOf(client, target), ref, "page").id;
  return client.request<Page>(`${pagesPath(target)}${id}/`);
};
export const requireWritablePage = (page: Page, deleting = false): void => {
  if (page.archived_at && !deleting)
    throw new PlaneError(`Page "${page.name}" is archived. Unarchive it in Plane before editing.`);
  if (page.is_locked)
    throw new PlaneError(`Page "${page.name}" is locked. Unlock it in Plane before editing.`);
};
export const formatPages = (pages: ReadonlyArray<Page>, wiki = false): string =>
  pages.length === 0
    ? "no pages"
    : printColumns(
        pages.map((page) => ({
          name: page.id,
          text: `${oneLine(page.name)}${wiki ? `  ${page.parent ?? "—"}` : ""}${page.updated_at ? `  ${page.updated_at}` : ""}`,
        })),
        "",
      ).join("\n");
export const pageDetail = (page: Page) => {
  const { description_json: document, ...metadata } = page;
  const html = scrubHtml(page.description_html ?? "");
  return {
    ...metadata,
    description_html: page.description_html == null ? page.description_html : html,
    ...pageHtmlToMarkdown(page.description_html ?? "", document),
  };
};
