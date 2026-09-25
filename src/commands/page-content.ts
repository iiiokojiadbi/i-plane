import { readFile } from "node:fs/promises";
import { flagBool, flagValue, type ParsedArgs, UsageError } from "../args.ts";
import { PlaneError } from "../client.ts";
import { printValue, scrub } from "../output.ts";
import {
  outline,
  type PreparedDocument,
  prepareMarkdown,
  readBlock,
  requiredNodeReaders,
  stamp,
} from "../page-document.ts";
import { allowLosses, editDocument } from "../page-edit.ts";
import { openLive } from "../page-live.ts";
import { assertNodeReaders, type PageClient } from "../page-transport.ts";
import { required, requiredFlag } from "../validation.ts";
import { type Page, pageOf, pagesPath, placementOf, requireWritablePage } from "./page-data.ts";

const input = async (args: ParsedArgs, optional = false): Promise<string | undefined> => {
  const file = flagValue(args, "file"),
    text = flagValue(args, "text");
  if (file !== undefined && text !== undefined)
    throw new UsageError("--file and --text are mutually exclusive.");
  if (file !== undefined) {
    try {
      return await readFile(file, "utf8");
    } catch {
      throw new UsageError(`Cannot read Markdown file "${file}".`);
    }
  }
  if (text !== undefined || optional) return text;
  throw new UsageError("Expected --file <path> or --text <markdown>.");
};
const reportLosses = (losses: ReadonlyArray<string>): void => {
  if (losses.length) console.error(scrub(`Warning: ${losses.join("; ")}`));
};
const receipt = (result: {
  id: string;
  delivery?: string;
  stamped?: number;
  deleted?: boolean;
}): string =>
  `${result.id}  ${result.deleted ? "deleted" : (result.delivery ?? "created")}${result.stamped !== undefined ? `; stamped ${result.stamped} blocks` : ""}${result.delivery ? "; database persistence is asynchronous" : ""}`;

export const runPageContent = async (
  command: string,
  client: PageClient,
  args: ParsedArgs,
  json: boolean,
  wiki = false,
): Promise<void> => {
  const projectRef = wiki ? undefined : required(args.positionals[0], "a project");
  const creating = command === "page create",
    removing = command === "page rm";
  const ref = creating
    ? requiredFlag(args, "name")
    : required(args.positionals[wiki ? 0 : 1], "a page UUID or name");
  const parentRef =
    wiki && creating && args.flags.has("parent") ? requiredFlag(args, "parent") : undefined;
  const block = args.flags.has("block") ? requiredFlag(args, "block") : undefined,
    after = args.flags.has("after") ? requiredFlag(args, "after") : undefined,
    atEnd = flagBool(args, "at-end");
  const ifMatch = flagValue(args, "if-match"),
    force = flagBool(args, "force"),
    allowLoss = flagBool(args, "allow-loss");
  if (removing && !flagBool(args, "yes")) throw new UsageError("Deletion requires --yes.");
  if ((ifMatch !== undefined || force) && !block)
    throw new UsageError("--if-match and --force require --block.");
  if (ifMatch !== undefined && !/^[a-f0-9]{64}$/i.test(ifMatch))
    throw new UsageError("--if-match expects the SHA-256 fingerprint from page read --json.");
  if (command === "page read" && !block) throw new UsageError("Expected --block <anchor>.");
  if (command === "page insert" && Boolean(after) === atEnd)
    throw new UsageError("Choose exactly one of --after <anchor> or --at-end.");
  const markdown =
    creating || command === "page set" || command === "page insert"
      ? await input(args, creating)
      : undefined;
  const placement = await placementOf(client, projectRef);
  const parent =
    parentRef === undefined ? undefined : (await pageOf(client, placement, parentRef)).id;
  let prepared: PreparedDocument | undefined;
  let created: Page | undefined;
  try {
    if (markdown !== undefined) {
      prepared = await prepareMarkdown(client, markdown);
      allowLosses(prepared.losses, allowLoss);
    }
    const page = creating
      ? await client.request<Page>(pagesPath(placement), {
          method: "POST",
          body: { name: ref, access: 0, ...(parent === undefined ? {} : { parent }) },
        })
      : await pageOf(client, placement, ref);
    if (creating) created = page;
    if (creating && !prepared) {
      printValue({ id: page.id, name: page.name }, json, receipt);
      return;
    }
    if (removing && !block) {
      if (!wiki) requireWritablePage(page, true);
      const path = `${pagesPath(placement)}${page.id}/`;
      if (!wiki && !page.archived_at) {
        try {
          await client.request(`${path}archive/`, { method: "POST" });
        } catch (error) {
          throw new PlaneError(
            `Archiving page ${page.id} was not confirmed: ${error instanceof Error ? error.message : String(error)}. Inspect this UUID before retrying; deletion was not attempted.`,
          );
        }
      }
      try {
        await client.request(path, { method: "DELETE" });
      } catch (error) {
        throw new PlaneError(
          `${wiki ? `Deletion of wiki page ${page.id} was not confirmed` : `Page ${page.id} was archived, but deletion was not confirmed`}: ${error instanceof Error ? error.message : String(error)}. Inspect it by UUID before retrying.`,
        );
      }
      printValue({ id: page.id, deleted: true }, json, receipt);
      return;
    }
    const reading = command === "page outline" || command === "page read";
    if (!reading) requireWritablePage(page);
    const live = await openLive(client, placement, page.id, { writable: !reading });
    try {
      if (command === "page outline") {
        printValue(outline(live.fragment), json, (rows) =>
          rows
            .map(
              (row) =>
                `${row.index}  ${row.shortAnchor ?? "(no anchor)"}  ${row.kind}  ${row.preview}`,
            )
            .join("\n"),
        );
      } else if (command === "page read") {
        const result = readBlock(live.fragment, required(block, "--block <anchor>"));
        reportLosses(result.losses);
        printValue(result, json, (value) => value.markdown);
      } else {
        const required = requiredNodeReaders([
          ...live.fragment.toArray(),
          ...(prepared?.fragment.toArray() ?? []),
        ]);
        const nodeReaders = required.length ? ((await client.nodeReaders?.()) ?? []) : [];
        let stamped: number | undefined,
          losses: string[] = [];
        client.markPageMutation?.();
        const delivered = await live.write((fragment) => {
          if (command === "page stamp") {
            assertNodeReaders(requiredNodeReaders(fragment.toArray()), nodeReaders);
            stamped = stamp(fragment);
          } else
            losses = editDocument(
              fragment,
              {
                kind: removing ? "rm" : command === "page insert" ? "insert" : "set",
                block,
                after,
                atEnd,
                ifMatch: ifMatch?.toLowerCase(),
                force,
                allowLoss,
                nodeReaders,
              },
              prepared,
            );
        });
        reportLosses(losses);
        printValue({ id: page.id, ...delivered, stamped, losses }, json, receipt);
      }
    } finally {
      live.destroy();
    }
  } catch (error) {
    if (created)
      throw new PlaneError(
        `Page ${created.id} was created, but its content operation did not complete: ${error instanceof Error ? error.message : String(error)}. Inspect this page before retrying; do not create a duplicate.`,
      );
    throw error;
  } finally {
    prepared?.doc.destroy();
  }
};
