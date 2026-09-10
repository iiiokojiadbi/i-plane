declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const taskLists: (parser: InstanceType<typeof MarkdownIt>) => void;
  export default taskLists;
}
