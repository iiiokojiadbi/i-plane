import { flagValue, type ParsedArgs } from "../args.ts";
import type { PlaneClient } from "../client.ts";
import { resolveIssue } from "../resolve.ts";
import { htmlToMarkdown } from "../richtext.ts";
import { required } from "../validation.ts";

interface Comment {
  readonly id: string;
  readonly comment_html?: string | null;
  readonly created_at: string;
  readonly actor?: string | { readonly id: string; readonly display_name?: string };
}

export interface CommentRow {
  readonly id: string;
  readonly author: string;
  readonly created_at: string;
  readonly body: string;
}

export const commentsOf = async (
  client: PlaneClient,
  projectId: string,
  issueId: string,
): Promise<ReadonlyArray<CommentRow>> => {
  const comments = await client.listAll<Comment>(
    `projects/${projectId}/issues/${issueId}/comments/`,
    {
      query: { fields: "id,comment_html,created_at,actor", per_page: 100 },
    },
  );
  return comments
    .map((comment) => ({
      id: comment.id,
      author:
        typeof comment.actor === "object" && comment.actor !== null
          ? (comment.actor.display_name ?? comment.actor.id)
          : (comment.actor ?? "?"),
      created_at: comment.created_at,
      body: htmlToMarkdown(comment.comment_html),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
};

export const listComments = async (
  client: PlaneClient,
  args: ParsedArgs,
): Promise<ReadonlyArray<CommentRow>> => {
  const ref = required(args.positionals[0], "a work item reference");
  const { issue, projectId } = await resolveIssue(client, ref, flagValue(args, "project"));
  return commentsOf(client, projectId, issue.id);
};

export const formatComments = (comments: ReadonlyArray<CommentRow>): string =>
  comments.length === 0
    ? "no comments"
    : comments
        .map(
          (comment) =>
            `${comment.created_at}  ${comment.author}  [${comment.id}]\n\n${comment.body}`,
        )
        .join("\n\n");
