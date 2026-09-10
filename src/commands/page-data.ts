import { UsageError } from "../args.ts";
import { PlaneError } from "../client.ts";
import { scrubHtml } from "../html-secrets.ts";
import { oneLine, printColumns } from "../output.ts";
import { isUuid, resolveNamed } from "../resolve.ts";
import { htmlToMarkdown } from "../richtext.ts";
import type { SessionClient } from "../session.ts";
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
export const projectOfPage = async (client: SessionClient, ref: string): Promise<Project> => {
  if (isUuid(ref)) return client.request<Project>(`projects/${ref}/`);
  const projects = await client.listAll<Project>("projects/");
  const identifier = projects.filter(
    (project) => project.identifier.toLowerCase() === ref.toLowerCase(),
  );
  if (identifier.length === 1 && identifier[0]) return identifier[0];
  return resolveNamed(projects, ref, "project");
};
export const pagesPath = (projectId: string): string => `projects/${projectId}/pages/`;
export const pagesOf = (client: SessionClient, projectId: string): Promise<ReadonlyArray<Page>> =>
  client.listAll<Page>(pagesPath(projectId));
export const pageOf = async (
  client: SessionClient,
  projectId: string,
  ref: string,
): Promise<Page> => {
  const id = isUuid(ref) ? ref : resolveNamed(await pagesOf(client, projectId), ref, "page").id;
  return client.request<Page>(`${pagesPath(projectId)}${id}/`);
};
export const requireWritablePage = (page: Page, deleting = false): void => {
  if (page.archived_at && !deleting)
    throw new PlaneError(`Page "${page.name}" is archived. Unarchive it in Plane before editing.`);
  if (page.is_locked)
    throw new PlaneError(`Page "${page.name}" is locked. Unlock it in Plane before editing.`);
  if (page.parent)
    throw new UsageError("Nested project pages are outside this command's supported scope.");
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
    markdown: htmlToMarkdown(html),
  };
};
