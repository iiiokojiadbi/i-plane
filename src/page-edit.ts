import * as Y from "yjs";
import { UsageError } from "./args.ts";
import { PlaneError } from "./client.ts";
import {
  type Block,
  findBlock,
  fingerprint,
  lossesFor,
  type PreparedDocument,
} from "./page-document.ts";

export interface EditOptions {
  kind: "set" | "insert" | "rm";
  block?: string;
  after?: string;
  atEnd?: boolean;
  ifMatch?: string;
  force?: boolean;
  allowLoss?: boolean;
}
export const allowLosses = (losses: ReadonlyArray<string>, allowed = false): void => {
  if (losses.length && !allowed)
    throw new UsageError(
      `This edit can lose content or formatting: ${losses.join("; ")}. Inspect the document, then pass --allow-loss to accept these losses.`,
    );
};

/** Called inside the live transaction, after every asynchronous preparation. */
export const editDocument = (
  fragment: Y.XmlFragment,
  options: EditOptions,
  prepared?: PreparedDocument,
): string[] => {
  const target = options.block ? findBlock(fragment, options.block) : undefined;
  if (target && options.ifMatch && !options.force && fingerprint(target.node) !== options.ifMatch)
    throw new PlaneError(
      "Block content changed since page read. Read it again and use its new --if-match fingerprint, or pass --force to overwrite the concurrent edit.",
      409,
    );
  const count = prepared?.fragment.length ?? 0;
  if (options.kind !== "rm" && !prepared) throw new UsageError("Expected Markdown content.");
  if ((options.kind === "insert" || (target && options.kind === "set")) && count === 0)
    throw new UsageError("Empty block content. Use page rm --block to remove a block.");
  const affected =
    options.kind === "insert" ? [] : target ? [target.node] : (fragment.toArray() as Block[]);
  const losses = [...new Set([...(prepared?.losses ?? []), ...lossesFor(affected)])];
  // Deletion explicitly discards the selected content; conversion losses only
  // apply to replacement, not a confirmed removal.
  if (options.kind !== "rm") allowLosses(losses, options.allowLoss);
  let index = target?.index ?? 0;
  if (options.kind === "insert")
    index = options.after ? findBlock(fragment, options.after).index + 1 : fragment.length;
  const clones =
    prepared?.fragment.toArray().map((node) => {
      if (!(node instanceof Y.XmlElement) && !(node instanceof Y.XmlText))
        throw new PlaneError("Unsupported document block; no changes were made.");
      return node.clone();
    }) ?? [];
  if (options.kind !== "insert") fragment.delete(index, target ? 1 : fragment.length);
  if (options.kind !== "rm" && clones.length) {
    fragment.insert(index, clones);
    if (target && clones[0] && "setAttribute" in clones[0])
      clones[0].setAttribute("id", target.anchor);
  }
  return options.kind === "rm" ? [] : losses;
};
