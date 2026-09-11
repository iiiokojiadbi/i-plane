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
  readonly required?: boolean;
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
  /** Usage decisions and limitations that matter before running a command. */
  readonly notes?: ReadonlyArray<string>;
}

export interface Group {
  readonly title: string;
  readonly summary?: string;
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

const REQUIRED_PROJECT_OPTION: Option = { ...PROJECT_OPTION, required: true };

const ISSUE_FIELDS: ReadonlyArray<Option> = [
  {
    flag: "--label",
    value: "<names>",
    summary:
      "Add comma-separated label names or IDs; preserve existing labels. Repeat flags keep the last value.",
  },
  {
    flag: "--labels",
    value: "<names|none>",
    summary:
      "Replace all labels with this comma-separated list; none clears them. Cannot combine with --label.",
  },
  {
    flag: "--parent",
    value: "<ID|none>",
    summary: "Parent work item, such as CLOUD-8; none removes the parent.",
  },
  {
    flag: "--assignee",
    value: "<names|none>",
    summary:
      "Replace assignees with comma-separated display names, emails or UUIDs; none clears them.",
  },
  {
    flag: "--due",
    value: "<date|none>",
    summary: "Due date in YYYY-MM-DD format; none clears it.",
  },
  {
    flag: "--start",
    value: "<date|none>",
    summary: "Start date in YYYY-MM-DD format; none clears it.",
  },
];
const COLOR_OPTION: Option = {
  flag: "--color",
  value: "<#RRGGBB>",
  summary: "Six-digit hex color. Quote the value, for example '#336699'.",
};
const DESCRIPTION_OPTION: Option = {
  flag: "--description",
  value: "<text>",
  summary: "Plain-text description; replaces the existing description.",
};
const NAME_OPTION: Option = { flag: "--name", value: "<name>", summary: "New name." };
const IDENTIFIER_OPTION: Option = {
  flag: "--identifier",
  value: "<ABC>",
  summary: "1–12 letters or digits, starting with a letter; normalized to uppercase.",
};
const GROUP_OPTION: Option = {
  flag: "--group",
  value: "<group>",
  summary: "backlog, unstarted, started, completed or cancelled.",
};
const YES_OPTION: Option = {
  flag: "--yes",
  required: true,
  summary: "Confirm permanent deletion.",
};

const PROJECT_FEATURES: ReadonlyArray<Option> = [
  { flag: "--intake", summary: "Enable intake; --intake=false disables it." },
  { flag: "--cycles", summary: "Enable cycles in the project; --cycles=false disables them." },
  { flag: "--modules", summary: "Enable modules in the project; --modules=false disables them." },
];
const START_OPTION: Option = {
  flag: "--start",
  value: "<date>",
  summary: "Start date in YYYY-MM-DD format.",
};
const END_OPTION: Option = {
  flag: "--end",
  value: "<date>",
  summary: "Cycle end date in YYYY-MM-DD format; supply with --start.",
};
const DUE_OPTION: Option = {
  flag: "--due",
  value: "<date>",
  summary: "Target date in YYYY-MM-DD format.",
};
const INTAKE_STATUS_OPTION: Option = {
  flag: "--status",
  value: "<status>",
  summary: "pending, rejected, snoozed, accepted or duplicate.",
};
const INTAKE_FIELDS: ReadonlyArray<Option> = [
  {
    flag: "--description",
    value: "<markdown>",
    summary: "Markdown description; replaces the existing description.",
  },
  { flag: "--priority", value: "<level>", summary: "urgent, high, medium, low or none." },
];

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
        options: [
          PROJECT_OPTION,
          { flag: "--comments", summary: "Include the discussion, converted to Markdown." },
          JSON_OPTION,
        ],
        examples: ["i-plane show CLOUD-8", "i-plane show CLOUD-8 --comments"],
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
          ...ISSUE_FIELDS,
          REQUIRED_PROJECT_OPTION,
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
          'i-plane create "Fix the resolver" --project CLOUD --priority urgent --description "Observed: stale results. Expected: fresh data."',
          'i-plane create "Prepare the documentation" --project CLOUD --label task --parent CLOUD-8 --due 2026-10-14',
        ],
        notes: [
          "Use create for work already accepted into the project. Use intake create for a report or idea that still needs a decision.",
          "The title and --project are required. Use the reference returned by create in subsequent show/update commands.",
          "--label adds labels by name; --labels replaces the complete list. Assignees and dates describe the work itself.",
        ],
        next: ["i-plane show CLOUD-8 --comments", "i-plane update CLOUD-8 --state started"],
      },
      {
        name: "update",
        alias: "set",
        args: "<ID>",
        summary: "Change fields of a work item. Pass at least one flag.",
        options: [
          ...ISSUE_FIELDS,
          { flag: "--state", value: "<name>", summary: "State by name or by group." },
          { flag: "--priority", value: "<level>", summary: "urgent, high, medium, low, none." },
          { flag: "--name", value: "<title>", summary: "New title." },
          { flag: "--description", value: "<markdown>", summary: "Replaces the description." },
          PROJECT_OPTION,
          JSON_OPTION,
        ],
        examples: [
          'i-plane update CLOUD-8 --state started --assignee "Reader"',
          'i-plane update CLOUD-8 --label "task,review" --due 2026-10-14',
          "i-plane update CLOUD-8 --labels none --parent none",
        ],
        notes: [
          "Pass at least one field to change. --project is only needed when the work item is addressed by UUID.",
          "--label preserves current labels; --labels replaces them. none clears labels, parent, assignees or dates where documented.",
        ],
        next: ["i-plane show CLOUD-8 --comments", "i-plane done CLOUD-8"],
      },
      {
        name: "done",
        args: "<ID>",
        summary: "Move to the first completed state. Shorthand for update --state.",
        // done delegates to update, so it accepts what update accepts. Listing
        // fewer flags here rejects calls the implementation handles.
        options: [
          ...ISSUE_FIELDS,
          { flag: "--priority", value: "<level>", summary: "Set priority while closing." },
          { flag: "--name", value: "<title>", summary: "Rename while closing." },
          { flag: "--description", value: "<markdown>", summary: "Replace the description." },
          PROJECT_OPTION,
          JSON_OPTION,
        ],
        examples: ["i-plane done CLOUD-8"],
        notes: [
          "Sets the first completed state and can update the other work item fields in the same call. --state is chosen by this command.",
        ],
        next: ["i-plane show CLOUD-8"],
      },
      {
        name: "comment",
        args: "<ID> <text>",
        summary: "Add a comment. Text is Markdown.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ['i-plane comment CLOUD-8 "resolver cache was stale"'],
      },
      {
        name: "comments",
        args: "<ID>",
        summary: "Read all comments as Markdown, oldest first.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane comments CLOUD-8"],
        notes: [
          "Read discussion before posting an answer. Bodies are Markdown, ordered oldest first; every page is fetched.",
          "show --comments includes the same discussion beside the work item description.",
        ],
        next: ["i-plane show CLOUD-8 --comments"],
      },
      {
        name: "delete",
        alias: "rm",
        args: "<ID>",
        summary: "Delete a work item. Refuses without --yes.",
        options: [
          { flag: "--yes", required: true, summary: "Confirm. Deleting cannot be undone." },
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
        name: "project create",
        args: "<name>",
        summary: "Create a project. Names cannot contain special characters, including hyphens.",
        options: [
          ...PROJECT_FEATURES,
          { ...IDENTIFIER_OPTION, required: true },
          DESCRIPTION_OPTION,
          JSON_OPTION,
        ],
        examples: [
          'i-plane project create "Knowledge Base" --identifier KB --description "Team documentation"',
          'i-plane project create "Product Work" --identifier APP --cycles --modules --intake',
        ],
        notes: [
          "Both name and --identifier are required. Hyphens are not allowed in project names.",
          "Enable the features needed for the workflow. --intake also initializes the incoming queue; a partial setup warning gives a project update command to retry.",
        ],
        next: [
          "i-plane states KB",
          'i-plane label create task --project KB --color "#3B82F6"',
          'i-plane create "Define the structure" --project KB --label task',
        ],
      },
      {
        name: "project update",
        args: "<project>",
        summary: "Change project details or enable cycles, modules and intake.",
        options: [
          ...PROJECT_FEATURES,
          NAME_OPTION,
          IDENTIFIER_OPTION,
          DESCRIPTION_OPTION,
          JSON_OPTION,
        ],
        examples: [
          'i-plane project update CLOUD --description "Product delivery"',
          "i-plane project update CLOUD --modules --cycles --intake",
        ],
        notes: [
          "Change at least one field. --intake=false, --cycles=false and --modules=false disable the corresponding feature.",
        ],
        next: ["i-plane modules CLOUD", "i-plane intake list CLOUD --status pending"],
      },
      {
        name: "project archive",
        args: "<project>",
        summary: "Archive a project and hide it from active lists.",
        options: [JSON_OPTION],
        examples: ["i-plane project archive KB"],
        notes: [
          "Archive hides the project from active lists while preserving its data. Save its UUID before archiving if another operation needs an exact reference.",
        ],
        next: ["i-plane projects"],
      },
      {
        name: "project rm",
        args: "<project>",
        summary: "Permanently delete a project and its contents. Requires --yes.",
        options: [YES_OPTION, JSON_OPTION],
        examples: ["i-plane project rm TEST --yes"],
        notes: [
          "Permanent deletion includes the project contents. Use project archive when the data should be kept.",
        ],
        next: ["i-plane projects"],
      },
      {
        name: "label create",
        args: "<name>",
        summary: "Create a work item label in a project. Default color: #808080.",
        options: [REQUIRED_PROJECT_OPTION, COLOR_OPTION, DESCRIPTION_OPTION, JSON_OPTION],
        examples: ['i-plane label create task --project KB --color "#336699"'],
        notes: [
          "A label categorizes work items, for example bug, task or epic. --color is optional; the default is #808080.",
          "Creating a label does not assign it to any work item. Use create/update --label with its name.",
        ],
        next: ["i-plane labels CLOUD", "i-plane update CLOUD-8 --label task"],
      },
      {
        name: "label rm",
        args: "<label>",
        summary: "Delete a label by name or UUID. Requires --yes.",
        options: [REQUIRED_PROJECT_OPTION, YES_OPTION, JSON_OPTION],
        examples: ["i-plane label rm unused --project KB --yes"],
        notes: [
          "Removes the project label. Review the label name and project before confirming with --yes.",
        ],
        next: ["i-plane labels CLOUD"],
      },
      {
        name: "state create",
        args: "<name>",
        summary: "Create a state. Requires --project, --color and --group.",
        options: [
          REQUIRED_PROJECT_OPTION,
          { ...COLOR_OPTION, required: true },
          { ...GROUP_OPTION, required: true },
          DESCRIPTION_OPTION,
          JSON_OPTION,
        ],
        examples: ['i-plane state create Review --project KB --color "#336699" --group started'],
        notes: [
          "A state names a stage of the project workflow. --group determines its ordering and whether done considers it completed.",
          "Both --color and --group are required. Creating a state does not move existing work items.",
        ],
        next: ["i-plane states CLOUD", "i-plane update CLOUD-8 --state Review"],
      },
      {
        name: "state update",
        args: "<state>",
        summary: "Change a state by name or UUID. An ambiguous name is an error.",
        options: [
          REQUIRED_PROJECT_OPTION,
          NAME_OPTION,
          COLOR_OPTION,
          GROUP_OPTION,
          DESCRIPTION_OPTION,
          JSON_OPTION,
        ],
        examples: ['i-plane state update Review --project KB --name "In Review"'],
        notes: [
          "Change name, color, description or group. Changing the group also changes how work items in this state are classified.",
        ],
        next: ["i-plane states CLOUD"],
      },
      {
        name: "state rm",
        args: "<state>",
        summary: "Delete a state by name or UUID. Requires --yes; Plane may refuse states in use.",
        options: [REQUIRED_PROJECT_OPTION, YES_OPTION, JSON_OPTION],
        examples: ["i-plane state rm unused --project KB --yes"],
        notes: [
          "Plane can refuse deletion of a state still in use. Inspect its work items and move them before retrying.",
        ],
        next: ["i-plane states CLOUD"],
      },

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
    title: "PLANNING",
    summary:
      "Cycles schedule a time window. Modules group related work toward a goal and can span cycles.",
    commands: [
      {
        name: "cycles",
        args: "[project]",
        summary: "All cycles and their dates. A cycle groups work by time.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane cycles CLOUD"],
        notes: [
          "Cycles are time windows for planned work. Supply a project positionally or through --project.",
          "Dates are shown in the project timezone. JSON keeps the server timestamps and includes the timezone.",
        ],
        next: ['i-plane cycle issues "Sprint 1" --project CLOUD'],
      },
      {
        name: "cycle create",
        args: "<name>",
        summary: "Create a cycle. Supply --start and --end together; omit both for a draft.",
        options: [
          REQUIRED_PROJECT_OPTION,
          DESCRIPTION_OPTION,
          START_OPTION,
          END_OPTION,
          {
            flag: "--owner",
            value: "<member>",
            summary: "Owner by name, email or UUID; defaults to the token's user.",
          },
          JSON_OPTION,
        ],
        examples: [
          'i-plane cycle create "Sprint 1" --project CLOUD --start 2026-10-01 --end 2026-10-14',
          'i-plane cycle create "Next iteration" --project CLOUD',
        ],
        notes: [
          "Enable the feature first if needed: i-plane project update CLOUD --cycles.",
          "Supply both --start and --end, or neither for a draft. The owner defaults to the token user; --owner selects another member.",
        ],
        next: [
          'i-plane cycle add CLOUD-8 CLOUD-9 --project CLOUD --cycle "Sprint 1"',
          'i-plane cycle issues "Sprint 1" --project CLOUD',
        ],
      },
      {
        name: "cycle update",
        args: "<cycle>",
        summary:
          "Change a cycle name, description, owner or dates. Change --start and --end together; none clears both dates.",
        options: [
          REQUIRED_PROJECT_OPTION,
          NAME_OPTION,
          DESCRIPTION_OPTION,
          START_OPTION,
          END_OPTION,
          { flag: "--owner", value: "<member>", summary: "Owner by name, email or UUID." },
          JSON_OPTION,
        ],
        examples: [
          'i-plane cycle update "Sprint 1" --project CLOUD --start 2026-10-01 --end 2026-10-14',
          'i-plane cycle update "Next iteration" --project CLOUD --start none --end none',
        ],
        notes: [
          "An omitted --owner preserves the current owner. Change both dates together, including when clearing them with none.",
          "Plane may refuse changes to completed cycles. Dates are displayed in the project timezone.",
        ],
        next: ["i-plane cycles CLOUD"],
      },
      {
        name: "cycle add",
        args: "<ID...>",
        summary:
          "Add work items to a cycle. All must belong to the selected project; this can move them from another cycle.",
        options: [
          REQUIRED_PROJECT_OPTION,
          {
            flag: "--cycle",
            required: true,
            value: "<cycle>",
            summary: "Cycle by name, unique prefix or UUID.",
          },
          JSON_OPTION,
        ],
        examples: ['i-plane cycle add CLOUD-8 CLOUD-9 --project CLOUD --cycle "Sprint 1"'],
        notes: [
          "A work item belongs to one cycle. Adding it to another cycle moves its cycle assignment.",
          "All references are resolved and checked against --project before the write.",
        ],
        next: ['i-plane cycle issues "Sprint 1" --project CLOUD'],
      },
      {
        name: "cycle issues",
        args: "<cycle>",
        summary: "All work items in a cycle, one line each.",
        options: [REQUIRED_PROJECT_OPTION, JSON_OPTION],
        examples: ['i-plane cycle issues "Sprint 1" --project CLOUD'],
        notes: [
          "Read the work planned for this time window. Names, state and priority are shown for every work item.",
        ],
        next: ["i-plane show CLOUD-8 --comments"],
      },
      {
        name: "cycle transfer",
        args: "<from> <to>",
        summary:
          "Move unfinished work to another cycle. The source cycle must have ended; completed and cancelled work stays behind.",
        options: [REQUIRED_PROJECT_OPTION, JSON_OPTION],
        examples: ['i-plane cycle transfer "Sprint 1" "Sprint 2" --project CLOUD'],
        notes: [
          "Use at the end of an iteration to carry unfinished work forward. Completed and cancelled work stays in the source cycle.",
          "Supply different source and target cycles from the same project. A dated source must have ended; an undated draft has no end-date check.",
        ],
        next: ['i-plane cycle issues "Sprint 2" --project CLOUD'],
      },
      {
        name: "modules",
        args: "[project]",
        summary: "List feature, milestone or workstream modules and their overall status.",
        options: [PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane modules CLOUD"],
        notes: [
          "A module groups work toward a goal, such as a feature, launch or documentation effort. It can span several cycles.",
          "A work item can belong to several modules. Module status and work item state are separate.",
        ],
        next: [
          "i-plane module issues Documentation --project CLOUD",
          "i-plane module create Documentation --project CLOUD --status planned",
        ],
      },
      {
        name: "module create",
        args: "<name>",
        summary: "Create a module for a feature, milestone or related workstream.",
        options: [
          REQUIRED_PROJECT_OPTION,
          DESCRIPTION_OPTION,
          START_OPTION,
          DUE_OPTION,
          {
            flag: "--status",
            value: "<status>",
            summary: "backlog, planned, in-progress, paused, completed or cancelled.",
          },
          JSON_OPTION,
        ],
        examples: [
          'i-plane module create Documentation --project CLOUD --description "Goal: publish the operator guide. Scope: setup and recovery. Done: all examples verified." --status planned',
          'i-plane module create "Autumn launch" --project CLOUD --start 2026-10-01 --due 2026-10-31 --status planned',
        ],
        notes: [
          "Enable the feature first if needed: i-plane project update CLOUD --modules.",
          "This CLI fills the name, plain-text description, optional start/due dates and overall status. The dates do not have to be a paired sprint window.",
          "Describe the goal, scope and completion criteria. Pass --status explicitly when its initial value matters: API and UI defaults can differ.",
          "Plane also supports a module lead and members, independently of work item assignees. This CLI does not yet set those fields or edit module details.",
        ],
        next: [
          "i-plane module add CLOUD-8 CLOUD-9 --project CLOUD --module Documentation",
          "i-plane module issues Documentation --project CLOUD",
        ],
      },
      {
        name: "module add",
        args: "<ID...>",
        summary: "Add related work items to a module; they may belong to other modules too.",
        options: [
          REQUIRED_PROJECT_OPTION,
          {
            flag: "--module",
            required: true,
            value: "<module>",
            summary: "Module by name, unique prefix or UUID.",
          },
          JSON_OPTION,
        ],
        examples: ["i-plane module add CLOUD-8 CLOUD-9 --project CLOUD --module Documentation"],
        notes: [
          "Module membership groups work by goal. It does not change the work item state, assignees or cycle.",
          "Keep each referenced work item in the selected project. Check the module contents after adding.",
        ],
        next: ["i-plane module issues Documentation --project CLOUD"],
      },
      {
        name: "module issues",
        args: "<module>",
        summary: "All work items in a module, one line each.",
        options: [REQUIRED_PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane module issues Documentation --project CLOUD"],
        notes: [
          "Use the list to assess what remains for the module goal. Work item states show progress; the module status is a separate planning field.",
        ],
        next: ["i-plane show CLOUD-8 --comments", "i-plane update CLOUD-8 --state started"],
      },
    ],
  },
  {
    title: "INTAKE",
    summary:
      "Collect undecided reports and requests, add context, then accept, reject, snooze or link a duplicate.",
    commands: [
      {
        name: "intake list",
        args: "[project]",
        summary: "Review incoming reports and requests before committing them to project work.",
        options: [PROJECT_OPTION, INTAKE_STATUS_OPTION, JSON_OPTION],
        examples: [
          "i-plane intake list CLOUD --status pending",
          "i-plane intake list CLOUD --status snoozed --json",
        ],
        notes: [
          "Intake is a triage queue for bug reports, ideas and support requests. Pending means no acceptance decision has been made.",
          "--status filters locally: pending, rejected, snoozed, accepted or duplicate. Triage status is separate from a normal work item state.",
          "Some servers hide expired snoozes from list/show. Keep issueId from JSON so update/rm can still address a hidden entry.",
        ],
        next: [
          "i-plane intake show CLOUD-9 --project CLOUD",
          "i-plane intake update CLOUD-9 --project CLOUD --status accepted",
        ],
      },
      {
        name: "intake create",
        args: "<title>",
        summary: "Submit a report or idea to triage without adding committed work to the board.",
        options: [REQUIRED_PROJECT_OPTION, ...INTAKE_FIELDS, JSON_OPTION],
        examples: [
          'i-plane intake create "Search returns stale results" --project CLOUD --priority high --description "**Observed:** stale search results. **Expected:** fresh results. **Reproduce:** update a record, then search. **Impact:** outdated data." --json',
          'i-plane intake create "Export documentation as PDF" --project CLOUD --priority low',
        ],
        notes: [
          "Enable intake first: i-plane project update CLOUD --intake. Requests start pending in the separate Triage state.",
          "Fill a clear title, Markdown description and optional priority. Include observations, expected behavior, reproduction steps and impact.",
          "Use --json and retain issueId for later triage actions. This CLI does not configure public intake forms or email channels.",
        ],
        next: [
          "i-plane intake list CLOUD --status pending",
          "i-plane intake show CLOUD-9 --project CLOUD",
        ],
      },
      {
        name: "intake show",
        args: "<ID>",
        summary:
          "Read an intake work item by readable reference or underlying work item UUID (issueId in JSON).",
        options: [REQUIRED_PROJECT_OPTION, JSON_OPTION],
        examples: ["i-plane intake show CLOUD-8 --project CLOUD"],
        notes: [
          "Read the request and its current triage decision before changing it. The description is Markdown.",
          "Use the readable work item number or underlying issueId from JSON, not the intake entry id. Expired snoozes may be hidden even from this read command.",
        ],
        next: [
          "i-plane intake update CLOUD-9 --project CLOUD --status accepted",
          "i-plane intake update CLOUD-9 --project CLOUD --status rejected",
        ],
      },
      {
        name: "intake update",
        args: "<ID>",
        summary: "Clarify a request or decide to accept, reject, snooze or mark it duplicate.",
        options: [
          REQUIRED_PROJECT_OPTION,
          NAME_OPTION,
          ...INTAKE_FIELDS,
          INTAKE_STATUS_OPTION,
          {
            flag: "--snooze-until",
            value: "<date>",
            summary: "Required with --status snoozed; YYYY-MM-DD at midnight UTC.",
          },
          {
            flag: "--duplicate-of",
            value: "<ID>",
            summary:
              "Required with --status duplicate; readable reference or UUID in the same project.",
          },
          JSON_OPTION,
        ],
        examples: [
          'i-plane intake update CLOUD-9 --project CLOUD --name "Search cache is not invalidated" --priority high --status accepted',
          "i-plane intake update CLOUD-9 --project CLOUD --status rejected",
          "i-plane intake update CLOUD-9 --project CLOUD --status snoozed --snooze-until 2026-10-01",
          "i-plane intake update CLOUD-9 --project CLOUD --status duplicate --duplicate-of CLOUD-8",
          "i-plane intake update 11111111-1111-4111-8111-111111111111 --project CLOUD --status accepted",
        ],
        notes: [
          "Edit title, Markdown description and priority while triaging. pending is undecided; rejected declines the request without deleting it.",
          "accepted moves triage work into the project default state through this API. Then use normal update to choose a state, assign people, labels and work dates.",
          "snoozed postpones the decision until --snooze-until. duplicate points to an existing work item via --duplicate-of. Other status changes clear stale snooze/duplicate metadata.",
          "When a snoozed entry has disappeared from lookup, pass its saved issueId UUID directly. UUID writes do not require list/show to find the entry.",
          "The Plane UI offers more properties during intake. This CLI currently edits title, description, priority and the triage decision; it does not set assignees, labels or due dates before acceptance.",
        ],
        next: [
          "i-plane show CLOUD-9 --comments",
          'i-plane update CLOUD-9 --state started --assignee "Reader" --label task',
        ],
      },
      {
        name: "intake rm",
        args: "<ID>",
        summary:
          "Delete an intake entry. Unaccepted work items are deleted too; accepted work items stay on the board. Requires --yes.",
        options: [REQUIRED_PROJECT_OPTION, YES_OPTION, JSON_OPTION],
        examples: [
          "i-plane intake rm CLOUD-9 --project CLOUD --yes",
          "i-plane intake rm 11111111-1111-4111-8111-111111111111 --project CLOUD --yes",
        ],
        notes: [
          "Use rejected to decline a request while keeping its record. rm is permanent and requires --yes.",
          "Deleting an unaccepted entry also deletes its work item. Deleting an accepted entry keeps the work item on the board.",
          "For an expired snooze hidden by the server, pass the saved issueId UUID directly.",
        ],
        next: ["i-plane intake list CLOUD"],
      },
    ],
  },
  {
    title: "PAGES",
    summary:
      "Project knowledge pages. All commands use the configured API key and require the for-plane API-key pages extension.",
    commands: [
      {
        name: "pages",
        args: "<project>",
        summary: "List project pages by UUID, name and modification date.",
        options: [JSON_OPTION],
        examples: ["i-plane pages DEBUG"],
        notes: [
          "Reads page metadata through the API-key pages endpoint. Page names accept exact or unique prefix matches; ambiguous names are errors.",
        ],
        next: ['i-plane page show DEBUG "Project Design Spec"'],
      },
      {
        name: "page show",
        args: "<project> <page>",
        summary: "Read a project's saved page content as Markdown.",
        options: [JSON_OPTION],
        examples: ['i-plane page show DEBUG "Project Design Spec"'],
        notes: [
          "Reads saved HTML, which may lag behind the live editor, usually by about ten seconds with no guaranteed upper bound. Content is returned as Markdown.",
          "Requires PLANE_URL, PLANE_WORKSPACE and PLANE_API_KEY, as with other commands.",
        ],
        next: ["i-plane pages DEBUG"],
      },
      {
        name: "page outline",
        args: "<project> <page>",
        summary: "Read the live top-level blocks: index, anchor, kind and preview.",
        options: [
          {
            flag: "--json",
            summary: "Print the model behind the output, with every field.",
          },
        ],
        examples: ['i-plane page outline DEBUG "Project Design Spec"'],
        notes: [
          "Live reads do not stamp or modify the document. Run page stamp explicitly when anchors are missing.",
        ],
        next: ['i-plane page read DEBUG "Project Design Spec" --block a1b2c3d4 --json'],
      },
      {
        name: "page read",
        args: "<project> <page>",
        summary: "Read one live block as Markdown, with a content fingerprint in JSON.",
        options: [
          {
            flag: "--block",
            summary: "Top-level block UUID or unique prefix from page outline.",
            value: "<anchor>",
            required: true,
          },
          {
            flag: "--json",
            summary: "Print the model behind the output, with every field.",
          },
        ],
        examples: ['i-plane page read DEBUG "Project Design Spec" --block a1b2c3d4 --json'],
        notes: [
          "Live reads do not stamp or modify the document. Run page stamp explicitly when anchors are missing.",
          "The fingerprint describes block content, not its anchor. Set FINGERPRINT to the value returned by page read --json before using the next command. Read again after concurrent edits. Markdown cannot represent every rich-text feature; losses are reported.",
        ],
        next: [
          'i-plane page set DEBUG "Project Design Spec" --block a1b2c3d4 --if-match "$FINGERPRINT" --text "Updated paragraph"',
        ],
      },
      {
        name: "page stamp",
        args: "<project> <page>",
        summary: "Assign missing anchors to top-level blocks; explicit live write.",
        options: [
          {
            flag: "--json",
            summary: "Print the model behind the output, with every field.",
          },
        ],
        examples: ['i-plane page stamp DEBUG "Project Design Spec"'],
        notes: [
          "Success confirms delivery to the live server, not database persistence. Saved HTML can lag, usually about ten seconds with no guaranteed upper bound. No automatic mutation retries.",
        ],
        next: ['i-plane page outline DEBUG "Project Design Spec"'],
      },
      {
        name: "page create",
        args: "<project>",
        summary: "Create a project page, optionally with Markdown content.",
        options: [
          {
            flag: "--name",
            summary: "Name of the new page.",
            value: "<name>",
            required: true,
          },
          {
            flag: "--file",
            summary: "Read Markdown from a UTF-8 file; mutually exclusive with --text.",
            value: "<path>",
          },
          {
            flag: "--text",
            summary: "Markdown content; mutually exclusive with --file.",
            value: "<markdown>",
          },
          {
            flag: "--allow-loss",
            summary: "Accept reported conversion or Markdown representation losses.",
          },
          {
            flag: "--json",
            summary: "Print the model behind the output, with every field.",
          },
        ],
        examples: ['i-plane page create DEBUG --name "Release notes" --text "# Release notes"'],
        notes: [
          "Success confirms delivery to the live server, not database persistence. Saved HTML can lag, usually about ten seconds with no guaranteed upper bound. No automatic mutation retries.",
          "Conversion losses require --allow-loss. Unsupported rich nodes or marks are reported; code-block languages are repaired before writing. Nested pages and --parent are unsupported by the project-page API.",
          "Creation with content uses two steps. If writing fails after creation, the error includes the created page UUID; inspect it before retrying.",
        ],
        next: ['i-plane page outline DEBUG "Release notes"'],
      },
      {
        name: "page set",
        args: "<project> <page>",
        summary: "Replace a page or one anchored block with Markdown.",
        options: [
          {
            flag: "--block",
            summary: "Top-level block UUID or unique prefix from page outline.",
            value: "<anchor>",
          },
          {
            flag: "--file",
            summary: "Read Markdown from a UTF-8 file; mutually exclusive with --text.",
            value: "<path>",
          },
          {
            flag: "--text",
            summary: "Markdown content; mutually exclusive with --file.",
            value: "<markdown>",
          },
          {
            flag: "--if-match",
            summary: "Require the block content fingerprint from page read --json.",
            value: "<fingerprint>",
          },
          {
            flag: "--force",
            summary: "Override a stale block fingerprint only; does not accept conversion losses.",
          },
          {
            flag: "--allow-loss",
            summary: "Accept reported conversion or Markdown representation losses.",
          },
          {
            flag: "--json",
            summary: "Print the model behind the output, with every field.",
          },
        ],
        examples: [
          'i-plane page set DEBUG "Release notes" --text "# Updated release notes"',
          'i-plane page set DEBUG "Release notes" --block a1b2c3d4 --if-match "$FINGERPRINT" --text "Updated paragraph"',
        ],
        notes: [
          "Success confirms delivery to the live server, not database persistence. Saved HTML can lag, usually about ten seconds with no guaranteed upper bound. No automatic mutation retries.",
          "For a block edit, read with --json first and pass its fingerprint as --if-match. The first replacement block inherits the anchor; additional blocks receive new anchors. Repeating a command is not idempotent.",
          "Conversion losses require --allow-loss. Unsupported rich nodes or marks are reported; code-block languages are repaired before writing. Nested pages and --parent are unsupported by the project-page API.",
        ],
        next: ['i-plane page outline DEBUG "Release notes"'],
      },
      {
        name: "page insert",
        args: "<project> <page>",
        summary: "Insert Markdown after a block or at the end.",
        options: [
          {
            flag: "--after",
            summary: "Insert after this top-level anchor; mutually exclusive with --at-end.",
            value: "<anchor>",
          },
          {
            flag: "--at-end",
            summary: "Append to the live document; mutually exclusive with --after.",
          },
          {
            flag: "--file",
            summary: "Read Markdown from a UTF-8 file; mutually exclusive with --text.",
            value: "<path>",
          },
          {
            flag: "--text",
            summary: "Markdown content; mutually exclusive with --file.",
            value: "<markdown>",
          },
          {
            flag: "--allow-loss",
            summary: "Accept reported conversion or Markdown representation losses.",
          },
          {
            flag: "--json",
            summary: "Print the model behind the output, with every field.",
          },
        ],
        examples: [
          'i-plane page insert DEBUG "Release notes" --at-end --text "New paragraph"',
          'i-plane page insert DEBUG "Release notes" --after a1b2c3d4 --file appendix.md',
        ],
        notes: [
          "Success confirms delivery to the live server, not database persistence. Saved HTML can lag, usually about ten seconds with no guaranteed upper bound. No automatic mutation retries.",
          "Conversion losses require --allow-loss. Unsupported rich nodes or marks are reported; code-block languages are repaired before writing. Nested pages and --parent are unsupported by the project-page API.",
        ],
        next: ['i-plane page outline DEBUG "Release notes"'],
      },
      {
        name: "page rm",
        args: "<project> <page>",
        summary: "Delete a page or one anchored block with explicit confirmation.",
        options: [
          {
            flag: "--block",
            summary: "Top-level block UUID or unique prefix from page outline.",
            value: "<anchor>",
          },
          {
            flag: "--if-match",
            summary: "Require the block content fingerprint from page read --json.",
            value: "<fingerprint>",
          },
          {
            flag: "--force",
            summary: "Override a stale block fingerprint only; does not accept conversion losses.",
          },
          {
            flag: "--yes",
            summary: "Confirm deletion. --yes=false does not confirm.",
            required: true,
          },
          {
            flag: "--json",
            summary: "Print the model behind the output, with every field.",
          },
        ],
        examples: ['i-plane page rm DEBUG "Release notes" --yes'],
        notes: [
          "Whole-page deletion archives the page first, as required by Plane. If deletion fails, the error reports the archived page UUID for recovery.",
          "Success confirms delivery to the live server, not database persistence. Saved HTML can lag, usually about ten seconds with no guaranteed upper bound. No automatic mutation retries.",
          "For a block edit, read with --json first and pass its fingerprint as --if-match. The first replacement block inherits the anchor; additional blocks receive new anchors. Repeating a command is not idempotent.",
        ],
        next: ["i-plane pages DEBUG"],
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
    title: "Pages have a live editing workflow",
    body: "Use pages, page outline and page read --json before page set --block --if-match. Page commands require a login and password. Live acknowledgement confirms delivery; saved HTML can lag. Run page --help for examples.",
  },
  {
    title: "Choose where the work belongs",
    body: "Use create for accepted project work, intake create for a report needing a decision, modules for a shared goal and cycles for a time window. The same work item can be in a cycle and several modules.",
  },
  {
    title: "Examples use sample references",
    body: "Replace CLOUD, work item numbers, names and sample UUIDs with values from your own commands. Required options are marked in --help; USUALLY NEXT shows common follow-up calls.",
  },

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
      "Work item and intake descriptions, and comments, use Markdown; the CLI converts HTML at the edges. " +
      "Project, label, state, cycle and module descriptions are plain text. " +
      "show and comments return work item text as Markdown.",
  },
  {
    title: "Work items are addressed the way people say them",
    body:
      "Normal work item references such as CLOUD-8 resolve directly. Hidden expired intake entries need " +
      "the saved issueId UUID; list/show may no longer find them. Projects accept an identifier " +
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
  {
    command: "i-plane update CLOUD-8 --state started",
    summary: "Start accepted work; done closes it.",
  },
  { command: "i-plane <command> --help", summary: "Flags and real examples for that command." },
  {
    command: "i-plane project update CLOUD --modules --cycles --intake",
    summary: "Enable planning and incoming requests for an existing project.",
  },
  {
    command: "i-plane intake list CLOUD --status pending",
    summary: "Review reports before accepting them into project work.",
  },
  {
    command: "i-plane module issues Documentation --project CLOUD",
    summary: "Inspect a goal's work across cycles.",
  },
  {
    command: "i-plane config",
    summary: "When something lands in the wrong place, look here first.",
  },
];

export const ALL_COMMANDS: ReadonlyArray<Command> = GROUPS.flatMap((group) => group.commands);

export const findCommand = (name: string): Command | undefined =>
  ALL_COMMANDS.find((command) => command.name === name || command.alias === name);

/** Flags every command accepts, whatever it is. */
export const GLOBAL_OPTIONS: ReadonlyArray<Option> = [
  JSON_OPTION,
  { flag: "--help", summary: "Show help." },
  { flag: "--version", summary: "Show the installed version." },
  { flag: "--url", value: "<url>", summary: "Plane base URL." },
  { flag: "--token", value: "<token>", summary: "API token." },
  { flag: "--workspace", value: "<slug>", summary: "Workspace slug." },
  { flag: "--config", value: "<path>", summary: "Credentials file." },
];

export const GLOBAL_FLAGS: ReadonlyArray<string> = GLOBAL_OPTIONS.map((option) =>
  option.flag.slice(2),
);

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

/** Multiword commands share a help page at their first word. */
export const commandFamily = (name: string): ReadonlyArray<Command> =>
  ALL_COMMANDS.filter((command) => command.name.startsWith(`${name} `));
