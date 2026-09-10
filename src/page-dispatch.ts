import { type ParsedArgs, UsageError } from "./args.ts";
import { formatPages, pageDetail, pageOf, pagesOf, projectOfPage } from "./commands/page-data.ts";
import { printValue } from "./output.ts";
import type { SessionClient } from "./session.ts";
import { required } from "./validation.ts";

type Handler = (client: SessionClient, args: ParsedArgs, json: boolean) => Promise<void>;
const contentHandler =
  (command: string): Handler =>
  async (client, args, json) => {
    const { runPageContent } = await import("./commands/page-content.ts");
    await runPageContent(command, client, args, json);
  };
export const PAGE_HANDLERS: Readonly<Record<string, Handler>> = {
  ...Object.fromEntries(
    [
      "page outline",
      "page read",
      "page stamp",
      "page create",
      "page set",
      "page insert",
      "page rm",
    ].map((name) => [name, contentHandler(name)]),
  ),
  pages: async (client, args, json) => {
    const project = await projectOfPage(client, required(args.positionals[0], "a project"));
    printValue(await pagesOf(client, project.id), json, formatPages);
  },
  "page show": async (client, args, json) => {
    const projectRef = required(args.positionals[0], "a project");
    const ref = required(args.positionals[1], "a page UUID or name");
    const project = await projectOfPage(client, projectRef);
    printValue(pageDetail(await pageOf(client, project.id, ref)), json, (page) => page.markdown);
  },
};
export const isPageCommand = (command: string): boolean =>
  command === "pages" || command.startsWith("page ");
export const dispatchPageCommand = async (
  command: string,
  client: SessionClient,
  args: ParsedArgs,
  json: boolean,
): Promise<void> => {
  const handler = PAGE_HANDLERS[command];
  if (!handler) throw new UsageError(`Unknown page command "${command}".`);
  await handler(client, args, json);
};
