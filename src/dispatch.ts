import { type ParsedArgs, UsageError, validatePositionals } from "./args.ts";
import type { PlaneClient } from "./client.ts";
import { formatComments, listComments } from "./commands/comments.ts";
import {
  createIntake,
  deleteIntake,
  formatIntake,
  formatIntakeList,
  listIntake,
  showIntake,
  updateIntake,
} from "./commands/intake.ts";
import {
  commentIssue,
  completeIssue,
  createIssue,
  deleteIssue,
  findIssues,
  formatDetail,
  formatFound,
  formatListing,
  listIssues,
  showIssue,
  updateIssue,
} from "./commands/issues.ts";
import {
  addPlanIssues,
  createPlan,
  formatPlan,
  formatPlanChange,
  formatPlans,
  formatTransfer,
  listPlans,
  planIssues,
  transferCycle,
  updateCycle,
} from "./commands/planning.ts";
import {
  archiveProject,
  createLabel,
  createProject,
  createState,
  deleteLabel,
  deleteProject,
  deleteState,
  formatProject,
  updateProject,
  updateState,
} from "./commands/structure.ts";
import {
  formatLabels,
  formatMe,
  formatMembers,
  formatProjects,
  formatStates,
  formatSummary,
  labelsOf,
  membersOf,
  statesOf,
  summarize,
  whoami,
} from "./commands/workspace.ts";
import type { Config } from "./config.ts";
import { oneLine, printValue } from "./output.ts";
import { listProjects } from "./resolve.ts";

interface Context {
  readonly client: PlaneClient;
  readonly args: ParsedArgs;
  readonly config: Config;
}

type Handler = (context: Context, json: boolean) => Promise<void>;
const handler =
  <T>(run: (context: Context) => Promise<T>, format: (value: T) => string): Handler =>
  async (context, json) =>
    printValue(await run(context), json, format);

export const HANDLERS: Readonly<Record<string, Handler>> = {
  cycles: handler(({ client, args }) => listPlans(client, args, "cycle"), formatPlans),
  "cycle create": handler(
    ({ client, args }) => createPlan(client, args, "cycle"),
    (plan) => `created ${formatPlan(plan)}`,
  ),
  "cycle update": handler(({ client, args }) => updateCycle(client, args), formatPlan),
  "cycle add": handler(
    ({ client, args }) => addPlanIssues(client, args, "cycle"),
    formatPlanChange,
  ),
  "cycle issues": handler(({ client, args }) => planIssues(client, args, "cycle"), formatListing),
  "cycle transfer": handler(({ client, args }) => transferCycle(client, args), formatTransfer),
  modules: handler(({ client, args }) => listPlans(client, args, "module"), formatPlans),
  "module create": handler(
    ({ client, args }) => createPlan(client, args, "module"),
    (plan) => `created ${formatPlan(plan)}`,
  ),
  "module add": handler(
    ({ client, args }) => addPlanIssues(client, args, "module"),
    formatPlanChange,
  ),
  "module issues": handler(({ client, args }) => planIssues(client, args, "module"), formatListing),
  "intake list": handler(({ client, args }) => listIntake(client, args), formatIntakeList),
  "intake create": handler(
    ({ client, args }) => createIntake(client, args),
    (row) => `created ${formatIntake(row)}`,
  ),
  "intake show": handler(({ client, args }) => showIntake(client, args), formatIntake),
  "intake update": handler(({ client, args }) => updateIntake(client, args), formatIntake),
  "intake rm": handler(
    ({ client, args }) => deleteIntake(client, args),
    (row) => `deleted intake entry ${row.ref}`,
  ),
  summary: handler(({ client, config }) => summarize(client, config), formatSummary),
  projects: handler(({ client }) => listProjects(client), formatProjects),
  list: handler(({ client, args }) => listIssues(client, args), formatListing),
  show: handler(
    ({ client, args, config }) => showIssue(client, args, config.workspace.value, config.url.value),
    formatDetail,
  ),
  create: handler(
    ({ client, args }) => createIssue(client, args),
    (row) => `created ${row.ref}  ${row.name}`,
  ),
  update: handler(
    ({ client, args }) => updateIssue(client, args),
    (row) => `${row.ref}  ${row.name} (${row.state})`,
  ),
  done: handler(
    ({ client, args }) => completeIssue(client, args),
    (row) => `${row.ref}  ${row.state}`,
  ),
  delete: handler(
    ({ client, args }) => deleteIssue(client, args),
    (text) => text,
  ),
  comment: handler(
    ({ client, args }) => commentIssue(client, args),
    (text) => text,
  ),
  comments: handler(({ client, args }) => listComments(client, args), formatComments),
  search: handler(({ client, args }) => findIssues(client, args), formatFound),
  states: handler(({ client, args }) => statesOf(client, args), formatStates),
  labels: handler(({ client, args }) => labelsOf(client, args), formatLabels),
  members: handler(({ client }) => membersOf(client), formatMembers),
  whoami: handler(({ client }) => whoami(client), formatMe),
  "project create": handler(
    ({ client, args }) => createProject(client, args),
    (project) => `created ${formatProject(project)}`,
  ),
  "project update": handler(({ client, args }) => updateProject(client, args), formatProject),
  "project archive": handler(
    ({ client, args }) => archiveProject(client, args),
    (project) => `archived ${formatProject(project)}`,
  ),
  "project rm": handler(
    ({ client, args }) => deleteProject(client, args),
    (project) => `deleted ${formatProject(project)}`,
  ),
  "label create": handler(
    ({ client, args }) => createLabel(client, args),
    (label) => `created ${oneLine(label.name)}  ${label.id}`,
  ),
  "label rm": handler(
    ({ client, args }) => deleteLabel(client, args),
    (label) => `deleted ${oneLine(label.name)}`,
  ),
  "state create": handler(
    ({ client, args }) => createState(client, args),
    (state) => `created ${oneLine(state.name)}  ${state.group}`,
  ),
  "state update": handler(
    ({ client, args }) => updateState(client, args),
    (state) => `${oneLine(state.name)}  ${state.group}`,
  ),
  "state rm": handler(
    ({ client, args }) => deleteState(client, args),
    (state) => `deleted ${oneLine(state.name)}`,
  ),
};

/** Run online commands through the same output boundary used by the CLI. */
export const dispatchCommand = async (
  command: string | undefined,
  client: PlaneClient,
  args: ParsedArgs,
  config: Config,
  json: boolean,
): Promise<void> => {
  const run = command === undefined ? undefined : HANDLERS[command];
  if (run === undefined) throw new UsageError(`No command "${command}". Run i-plane for the map.`);
  validatePositionals(command, args);
  await run({ client, args, config }, json);
};
