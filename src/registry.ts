/*
 * One description of every command, used three ways: the guide, the per-command
 * help, and the hint printed when a call is missing something.
 *
 * Keeping them in one place is not tidiness. A guide that drifts from the flags
 * a command actually takes is worse than no guide: it teaches a wrong call
 * confidently, and the caller finds out one failed request later.
 */

export interface Option {
  readonly flag: string;
  /** Placeholder for the value, or undefined for a switch. */
  readonly value?: string;
  readonly summary: string;
}

export interface Command {
  readonly name: string;
  readonly alias?: string;
  readonly args?: string;
  readonly summary: string;
  readonly options?: ReadonlyArray<Option>;
  /** Real invocations, not shapes: an agent copies these. */
  readonly examples?: ReadonlyArray<string>;
  /** What one usually does after this command. */
  readonly next?: ReadonlyArray<string>;
}

export interface Group {
  readonly title: string;
  readonly commands: ReadonlyArray<Command>;
}

const JSON_OPTION: Option = {
  flag: "--json",
  summary: "Print the model behind the output, with every field.",
};

const PROJECT_OPTION: Option = {
  flag: "--project",
  value: "<ref>",
  summary: "Project by identifier (CLOUD), name, or unique name prefix.",
};

export const GROUPS: ReadonlyArray<Group> = [
  {
    title: "LOOK AROUND",
    commands: [
      {
        name: "summary",
        summary: "Projects in the workspace and how much is in each.",
        options: [JSON_OPTION],
        examples: ["i-plane summary"],
        next: ["i-plane list <PROJECT>"],
      },
      {
        name: "projects",
        alias: "ps",
        summary: "Projects with their identifiers.",
        options: [JSON_OPTION],
        examples: ["i-plane projects"],
      },
      {
        name: "list",
        alias: "ls",
        args: "[project]",
        summary: "Work items of one project, one line each.",
        options: [
          {
            flag: "--state",
            value: "<name|group>",
            summary: "Keep one state. Group: backlog, unstarted, started, completed, cancelled.",
          },
          {
            flag: "--priority",
            value: "<level>",
            summary: "Keep one level: urgent, high, medium, low, none.",
          },
          {
            flag: "--limit",
            value: "<n>",
            summary: "Show only the first n rows. The output says how many were hidden.",
          },
          PROJECT_OPTION,
          JSON_OPTION,
        ],
        examples: [
          "i-plane list CLOUD",
          "i-plane list CLOUD --state started",
          "i-plane list CLOUD --priority urgent",
        ],
        next: ["i-plane show <ID>", "i-plane update <ID> --state done"],
      },
      {
        name: "show",
        args: "<ID>",
        summary: "One work item with its description as Markdown.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane show CLOUD-8"],
        next: ["i-plane update CLOUD-8 --priority high", 'i-plane comment CLOUD-8 "..."'],
      },
      {
        name: "search",
        alias: "find",
        args: "<text>",
        summary: "Search work items across the whole workspace, not one project.",
        options: [JSON_OPTION],
        examples: ['i-plane search "resolver"'],
        next: ["i-plane show <ID>"],
      },
    ],
  },
  {
    title: "CHANGE THINGS",
    commands: [
      {
        name: "create",
        alias: "new",
        args: "<title>",
        summary: "Create a work item.",
        options: [
          PROJECT_OPTION,
          {
            flag: "--description",
            value: "<markdown>",
            summary: "Markdown: headings, code fences with a language, tables, lists, quotes.",
          },
          { flag: "--priority", value: "<level>", summary: "urgent, high, medium, low, none." },
          { flag: "--state", value: "<name>", summary: "Starting state; default otherwise." },
          JSON_OPTION,
        ],
        examples: [
          'i-plane create --project CLOUD "Fix the resolver"',
          'i-plane create --project CLOUD "Fix the resolver" --priority urgent --description "## Steps\n\n1. check the cache"',
        ],
      },
      {
        name: "update",
        alias: "set",
        args: "<ID>",
        summary: "Change fields of a work item. Pass at least one flag.",
        options: [
          { flag: "--state", value: "<name>", summary: "State by name or by group." },
          { flag: "--priority", value: "<level>", summary: "urgent, high, medium, low, none." },
          { flag: "--name", value: "<title>", summary: "New title." },
          { flag: "--description", value: "<markdown>", summary: "Replaces the description." },
          PROJECT_OPTION,
          JSON_OPTION,
        ],
        examples: [
          'i-plane update CLOUD-8 --state "in progress"',
          "i-plane update CLOUD-8 --priority urgent",
        ],
      },
      {
        name: "done",
        args: "<ID>",
        summary: "Move to the first completed state. Shorthand for update --state.",
        // done delegates to update, so it accepts what update accepts. Listing
        // fewer flags here rejects calls the implementation handles.
        options: [
          { flag: "--priority", value: "<level>", summary: "Set priority while closing." },
          { flag: "--name", value: "<title>", summary: "Rename while closing." },
          { flag: "--description", value: "<markdown>", summary: "Replace the description." },
          PROJECT_OPTION,
          JSON_OPTION,
        ],
        examples: ["i-plane done CLOUD-8"],
      },
      {
        name: "comment",
        args: "<ID> <text>",
        summary: "Add a comment. Text is Markdown.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ['i-plane comment CLOUD-8 "resolver cache was stale"'],
      },
      {
        name: "delete",
        alias: "rm",
        args: "<ID>",
        summary: "Delete a work item. Refuses without --yes.",
        options: [
          { flag: "--yes", summary: "Confirm. Deleting cannot be undone." },
          PROJECT_OPTION,
          JSON_OPTION,
        ],
        examples: ["i-plane delete CLOUD-8 --yes"],
      },
    ],
  },
  {
    title: "PROJECT SHAPE",
    commands: [
      {
        name: "states",
        args: "[project]",
        summary: "States and their groups — the names --state accepts.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane states CLOUD"],
      },
      {
        name: "labels",
        args: "[project]",
        summary: "Labels of a project.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane labels CLOUD"],
      },
      {
        name: "members",
        summary: "Who is in the workspace.",
        options: [JSON_OPTION],
        examples: ["i-plane members"],
      },
    ],
  },
  {
    title: "SELF",
    commands: [
      {
        name: "config",
        summary: "Which url, token and workspace are in effect, and where each came from.",
        options: [JSON_OPTION],
        examples: ["i-plane config"],
      },
      {
        name: "whoami",
        summary: "The account behind the token.",
        options: [JSON_OPTION],
        examples: ["i-plane whoami"],
      },
      {
        name: "guide",
        summary: "This map, the usual order of work, and how the tool behaves.",
        options: [JSON_OPTION],
        examples: ["i-plane guide"],
      },
    ],
  },
];

/**
 * What an agent has to know to make correct calls — the things that are not
 * visible from a command list and cost a failed request to discover.
 */
export const NOTES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Filtering happens here, not on the server",
    body:
      "The list endpoint honours fields and expand — that is where the saving comes from, " +
      "11 KB down to 737 bytes on the wire. But it accepts state_group, priority and order_by " +
      "with a 200 and then ignores them. So --state and --priority narrow rows in this client. " +
      "Never assume a server-side filter worked: it answers success and returns everything.",
  },
  {
    title: "A list is complete unless it says otherwise",
    body:
      "list returns every work item of the project. --limit exists but is not the usual path; " +
      "when it cuts the list, the last line says how many rows were hidden. Read that line " +
      "before concluding anything — a truncated list looks exactly like a complete one.",
  },
  {
    title: "Descriptions are Markdown in both directions",
    body:
      "Plane stores HTML, this tool translates at the edges. Write --description as Markdown: " +
      "code fences keep their language, tables stay tables, ordered lists stay numbered. " +
      "show prints the description back as Markdown.",
  },
  {
    title: "Work items are addressed the way people say them",
    body:
      "CLOUD-8 resolves in one request, no uuid lookup needed. Projects accept an identifier " +
      "(CLOUD), a full name, or a unique name prefix; an ambiguous prefix is reported rather " +
      "than guessed.",
  },
  {
    title: "Nothing ever prompts",
    body:
      "A CLI that waits for input hangs an agent forever. A missing argument is an error that " +
      "names what was expected and shows a real invocation.",
  },
  {
    title: "Exit codes are distinguishable",
    body:
      "2 means the call was wrong — unknown command, missing argument, ambiguous project. " +
      "1 means Plane said no or could not be reached. Branch on the code instead of parsing text.",
  },
  {
    title: "Every command takes --json",
    body:
      "The human form drops fields on purpose. When ids, timestamps or assignees matter, " +
      "add --json and read the model instead.",
  },
];

export const FLOW: ReadonlyArray<{ command: string; summary: string }> = [
  {
    command: "i-plane summary",
    summary: "Start here: which projects exist and how full they are.",
  },
  {
    command: "i-plane list CLOUD",
    summary: "Everything in one project. Narrow with --state, --priority.",
  },
  {
    command: "i-plane show CLOUD-8",
    summary: "Read one before changing it; description included.",
  },
  { command: "i-plane update CLOUD-8", summary: "Change one thing at a time; done closes it." },
  { command: "i-plane <command> --help", summary: "Flags and real examples for that command." },
  {
    command: "i-plane config",
    summary: "When something lands in the wrong place, look here first.",
  },
];

export const ALL_COMMANDS: ReadonlyArray<Command> = GROUPS.flatMap((group) => group.commands);

export const findCommand = (name: string): Command | undefined =>
  ALL_COMMANDS.find((command) => command.name === name || command.alias === name);

/** Flags every command accepts, whatever it is. */
export const GLOBAL_FLAGS: ReadonlyArray<string> = [
  "json",
  "help",
  "version",
  "url",
  "token",
  "workspace",
  "config",
];

/**
 * Flags a command understands. A misspelled filter must fail rather than return
 * an unfiltered list with exit 0: the caller cannot tell that answer apart from
 * a correct one, and acting on it is worse than an error.
 */
export const knownFlags = (command: Command): ReadonlySet<string> =>
  new Set([
    ...GLOBAL_FLAGS,
    ...(command.options ?? []).map((option) => option.flag.replace(/^--/, "")),
  ]);
