import { flagValue, type ParsedArgs, UsageError } from "../args.ts";
import type { PlaneClient } from "../client.ts";
import { findState, isUuid, listStates, resolveIssue, resolveNamed } from "../resolve.ts";
import { markdownToHtml } from "../richtext.ts";
import { type Issue, type Member, PRIORITY_ORDER } from "../types.ts";
import { choice, dateValue, references, required } from "../validation.ts";
import type { Label } from "./workspace.ts";

export const resolveMember = async (client: PlaneClient, ref: string): Promise<string> => {
  if (isUuid(ref)) return ref;
  const members = await client.listAll<Member>("members-lite/", { query: { per_page: 100 } });
  const exact = members.filter((member) => member.email?.toLowerCase() === ref.toLowerCase());
  if (exact.length === 1 && exact[0] !== undefined) return exact[0].id;
  if (exact.length > 1) throw new UsageError(`Ambiguous member "${ref}".`);
  return resolveNamed(
    members.map((member) => ({
      ...member,
      name: member.display_name ?? member.email ?? member.id,
    })),
    ref,
    "member",
  ).id;
};

/** Build one issue PATCH, resolving names before any write takes place. */
export const issueFields = async (
  client: PlaneClient,
  args: ParsedArgs,
  projectId: string,
  existing?: Issue,
): Promise<Record<string, unknown>> => {
  const body: Record<string, unknown> = {};
  const name = flagValue(args, "name");
  if (name !== undefined) body.name = required(name, "a work item name");
  const priority = flagValue(args, "priority");
  if (priority !== undefined) body.priority = choice(priority, PRIORITY_ORDER, "priority");
  const description = flagValue(args, "description");
  if (description !== undefined) body.description_html = markdownToHtml(description);
  const due = flagValue(args, "due");
  if (due !== undefined) body.target_date = dateValue(due, "due");
  const start = flagValue(args, "start");
  if (start !== undefined) body.start_date = dateValue(start, "start");
  const addLabels = flagValue(args, "label");
  const replaceLabels = flagValue(args, "labels");
  if (addLabels !== undefined && replaceLabels !== undefined) {
    throw new UsageError("Use either --label to add labels or --labels to replace them.");
  }
  const state = flagValue(args, "state");
  if (state !== undefined) body.state = findState(await listStates(client, projectId), state).id;
  const parent = flagValue(args, "parent");
  if (parent !== undefined) {
    if (parent === "none") body.parent = null;
    else {
      const resolved = await resolveIssue(client, parent, projectId);
      if (resolved.issue.id === existing?.id)
        throw new UsageError("A work item cannot be its own parent.");
      body.parent = resolved.issue.id;
    }
  }
  const assignee = flagValue(args, "assignee");
  if (assignee !== undefined) {
    const ids: string[] = [];
    for (const ref of references(assignee)) ids.push(await resolveMember(client, ref));
    body.assignees = [...new Set(ids)];
  }
  const labelRefs = addLabels ?? replaceLabels;
  if (labelRefs !== undefined) {
    const refs = references(labelRefs);
    if (addLabels !== undefined && refs.length === 0)
      throw new UsageError("--label expects labels to add. Use --labels none to clear all labels.");
    const labels =
      refs.length === 0
        ? []
        : await client.listAll<Label>(`projects/${projectId}/labels/`, {
            query: { fields: "id,name", per_page: 100 },
          });
    const ids = refs.map((ref) => resolveNamed(labels, ref, "label").id);
    // Plane replaces the entire array. Preserve the labels read with the issue
    // only for the explicitly additive flag.
    body.labels = [
      ...new Set([...(addLabels === undefined ? [] : (existing?.labels ?? [])), ...ids]),
    ];
  }
  return body;
};
