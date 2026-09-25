import { type ParsedArgs, UsageError } from "./args.ts";
import { formatPages, pageDetail, pageOf, pagesOf, placementOf } from "./commands/page-data.ts";
import { printValue, warn } from "./output.ts";
import { type PageClient, PageIdentityChanged } from "./page-transport.ts";
import { required } from "./validation.ts";

type Handler = (client: PageClient, args: ParsedArgs, json: boolean) => Promise<void>;
const contentHandler =
  (command: string, wiki = false): Handler =>
  async (client, args, json) => {
    const { runPageContent } = await import("./commands/page-content.ts");
    await runPageContent(command, client, args, json, wiki);
  };
const listHandler =
  (wiki: boolean): Handler =>
  async (client, args, json) => {
    const placement = await placementOf(
      client,
      wiki ? undefined : required(args.positionals[0], "a project"),
    );
    printValue(await pagesOf(client, placement), json, (pages) => formatPages(pages, wiki));
  };
const showHandler =
  (wiki: boolean): Handler =>
  async (client, args, json) => {
    const ref = required(args.positionals[wiki ? 0 : 1], "a page UUID or name");
    const placement = await placementOf(
      client,
      wiki ? undefined : required(args.positionals[0], "a project"),
    );
    const result = pageDetail(await pageOf(client, placement, ref));
    if (result.losses.length) warn(`Warning: ${result.losses.join("; ")}`);
    printValue(result, json, (page) => page.markdown);
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
    ].flatMap((name) => [
      [name, contentHandler(name)],
      [name.replace("page ", "wiki "), contentHandler(name, true)],
    ]),
  ),
  pages: listHandler(false),
  "wiki list": listHandler(true),
  "page show": showHandler(false),
  "wiki show": showHandler(true),
};
export const isPageCommand = (command: string): boolean =>
  command === "pages" || command.startsWith("page ") || command.startsWith("wiki ");
export const dispatchPageCommand = async (
  command: string,
  client: PageClient,
  args: ParsedArgs,
  json: boolean,
): Promise<void> => {
  const handler = PAGE_HANDLERS[command];
  if (!handler) throw new UsageError(`Unknown page command "${command}".`);
  client.beginPageCommand?.();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await handler(client, args, json);
      return;
    } catch (error) {
      if (!(error instanceof PageIdentityChanged) || attempt > 0) throw error;
    }
  }
};
