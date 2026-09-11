import { PlaneError } from "../client.ts";
import { scrubHtml } from "../html-secrets.ts";
import { oneLine, printColumns } from "../output.ts";
import { pageHtmlToMarkdown } from "../page-html.ts";
import type { PageClient } from "../page-transport.ts";
import { isUuid, resolveNamed } from "../resolve.ts";
import type { Project } from "../types.ts";

export interface Page {
  readonly id: string;
  readonly name: string;
  readonly description_html?: string | null;
  readonly updated_at?: string;
  readonly is_locked?: boolean;
  readonly access?: number;
  readonly archived_at?: string | null;
  readonly parent?: string | null;
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
export const pagesPath = (projectId: string): string => `projects/${projectId}/pages/`;
export const pagesOf = (client: PageClient, projectId: string): Promise<ReadonlyArray<Page>> =>
  client.listAll<Page>(pagesPath(projectId));
export const pageOf = async (client: PageClient, projectId: string, ref: string): Promise<Page> => {
  const id = isUuid(ref) ? ref : resolveNamed(await pagesOf(client, projectId), ref, "page").id;
  return client.request<Page>(`${pagesPath(projectId)}${id}/`);
};
export const requireWritablePage = (page: Page, deleting = false): void => {
  if (page.archived_at && !deleting)
    throw new PlaneError(`Page "${page.name}" is archived. Unarchive it in Plane before editing.`);
  if (page.is_locked)
    throw new PlaneError(`Page "${page.name}" is locked. Unlock it in Plane before editing.`);
};
export const formatPages = (pages: ReadonlyArray<Page>): string =>
  pages.length === 0
    ? "no pages"
    : printColumns(
        pages.map((page) => ({
          name: page.id,
          text: `${oneLine(page.name)}${page.updated_at ? `  ${page.updated_at}` : ""}`,
        })),
        "",
      ).join("\n");
export const pageDetail = (page: Page) => {
  const html = scrubHtml(page.description_html ?? "");
  return {
    ...page,
    description_html: page.description_html == null ? page.description_html : html,
    ...pageHtmlToMarkdown(page.description_html ?? ""),
  };
};
