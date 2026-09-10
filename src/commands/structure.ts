import { flagBool, flagValue, type ParsedArgs, UsageError } from "../args.ts";
import type { PlaneClient } from "../client.ts";
import { oneLine, warn } from "../output.ts";
import { listStates, resolveNamed, resolveProject } from "../resolve.ts";
import { type Project, STATE_GROUP_ORDER, type State } from "../types.ts";
import { choice, colorValue, requireChanges, required, requiredFlag } from "../validation.ts";
import type { Label } from "./workspace.ts";

const projectName = (value: string): string => {
  const name = required(value, "a project name");
  if (name.length > 255 || /[&+,:;$^}{*=?@#|'<>.()%!-]/.test(name)) {
    throw new UsageError(
      "Project name cannot contain special characters (including hyphens) or exceed 255 characters.",
    );
  }
  return name;
};

const identifierValue = (value: string): string => {
  const identifier = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,11}$/.test(identifier)) {
    throw new UsageError("--identifier expects 1–12 letters or digits, starting with a letter.");
  }
  return identifier;
};

const featureFields = (args: ParsedArgs): Record<string, boolean> => {
  const body: Record<string, boolean> = {};
  for (const [flag, field] of [
    ["intake", "intake_view"],
    ["cycles", "cycle_view"],
    ["modules", "module_view"],
  ] as const) {
    if (args.flags.has(flag)) body[field] = flagBool(args, flag);
  }
  return body;
};

export const createProject = async (client: PlaneClient, args: ParsedArgs): Promise<Project> => {
  const body: Record<string, unknown> = {
    ...featureFields(args),
    name: projectName(args.positionals.join(" ")),
    identifier: identifierValue(requiredFlag(args, "identifier")),
  };
  const description = flagValue(args, "description");
  if (description !== undefined) body.description = description;
  const enableIntake = body.intake_view === true;
  // Plane initializes the intake queue on project PATCH, not on project POST.
  // Setting only the creation flag leaves no queue and intake writes return 500.
  if (enableIntake) delete body.intake_view;
  const created = await client.request<Project>("projects/", { method: "POST", body });
  if (!enableIntake) return created;
  try {
    const initialized = await client.request<Project | undefined>(`projects/${created.id}/`, {
      method: "PATCH",
      body: { intake_view: true },
    });
    return initialized ?? { ...created, intake_view: true };
  } catch (error) {
    // The project already exists. An error exit would invite a duplicate create.
    warn(
      `${created.identifier} was created, but intake setup failed: ${error instanceof Error ? error.message : String(error)}. Retry with i-plane project update ${created.id} --intake.`,
    );
    return created;
  }
};

export const updateProject = async (client: PlaneClient, args: ParsedArgs): Promise<Project> => {
  const ref = required(args.positionals[0], "a project reference");
  const body: Record<string, unknown> = { ...featureFields(args) };
  const name = flagValue(args, "name");
  if (name !== undefined) body.name = projectName(name);
  const description = flagValue(args, "description");
  if (description !== undefined) body.description = description;
  const identifier = flagValue(args, "identifier");
  if (identifier !== undefined) body.identifier = identifierValue(identifier);
  requireChanges(body);
  const project = await resolveProject(client, ref);
  const updated = await client.request<Project | undefined>(`projects/${project.id}/`, {
    method: "PATCH",
    body,
  });
  return updated ?? { ...project, ...body };
};

export const archiveProject = async (client: PlaneClient, args: ParsedArgs): Promise<Project> => {
  const project = await resolveProject(
    client,
    required(args.positionals[0], "a project reference"),
  );
  await client.request(`projects/${project.id}/archive/`, { method: "POST" });
  return project;
};

export const formatProject = (project: Project): string =>
  `${project.identifier}  ${oneLine(project.name)}`;

export const createLabel = async (client: PlaneClient, args: ParsedArgs): Promise<Label> => {
  const body: Record<string, unknown> = {
    name: required(args.positionals.join(" "), "a label name"),
  };
  const projectRef = requiredFlag(args, "project");
  const color = flagValue(args, "color");
  body.color = colorValue(color ?? "#808080");
  const description = flagValue(args, "description");
  if (description !== undefined) body.description = description;
  const project = await resolveProject(client, projectRef);
  return client.request<Label>(`projects/${project.id}/labels/`, { method: "POST", body });
};

const stateBody = (args: ParsedArgs): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  const name = flagValue(args, "name");
  if (name !== undefined) body.name = required(name, "a state name");
  const color = flagValue(args, "color");
  if (color !== undefined) body.color = colorValue(color);
  const group = flagValue(args, "group");
  if (group !== undefined) body.group = choice(group, STATE_GROUP_ORDER, "group");
  const description = flagValue(args, "description");
  if (description !== undefined) body.description = description;
  return body;
};

export const createState = async (client: PlaneClient, args: ParsedArgs): Promise<State> => {
  const name = required(args.positionals.join(" "), "a state name");
  const color = colorValue(requiredFlag(args, "color"));
  const group = choice(requiredFlag(args, "group"), STATE_GROUP_ORDER, "group");
  const body = { ...stateBody(args), name, color, group };
  const project = await resolveProject(client, requiredFlag(args, "project"));
  return client.request<State>(`projects/${project.id}/states/`, { method: "POST", body });
};

export const updateState = async (client: PlaneClient, args: ParsedArgs): Promise<State> => {
  const ref = required(args.positionals[0], "a state name or UUID");
  const body = stateBody(args);
  requireChanges(body);
  const project = await resolveProject(client, requiredFlag(args, "project"));
  const state = resolveNamed(await listStates(client, project.id), ref, "state");
  const updated = await client.request<State | undefined>(
    `projects/${project.id}/states/${state.id}/`,
    { method: "PATCH", body },
  );
  return updated ?? { ...state, ...body };
};

const confirmDelete = (args: ParsedArgs): void => {
  if (!flagBool(args, "yes")) throw new UsageError("Deleting cannot be undone. Repeat with --yes.");
};

export const deleteProject = async (client: PlaneClient, args: ParsedArgs): Promise<Project> => {
  confirmDelete(args);
  const project = await resolveProject(
    client,
    required(args.positionals[0], "a project reference"),
  );
  await client.request(`projects/${project.id}/`, { method: "DELETE" });
  return project;
};

export const deleteLabel = async (client: PlaneClient, args: ParsedArgs): Promise<Label> => {
  confirmDelete(args);
  const ref = required(args.positionals[0], "a label name or UUID");
  const project = await resolveProject(client, requiredFlag(args, "project"));
  const labels = await client.listAll<Label>(`projects/${project.id}/labels/`, {
    query: { fields: "id,name", per_page: 100 },
  });
  const label = resolveNamed(labels, ref, "label");
  await client.request(`projects/${project.id}/labels/${label.id}/`, { method: "DELETE" });
  return label;
};

export const deleteState = async (client: PlaneClient, args: ParsedArgs): Promise<State> => {
  confirmDelete(args);
  const ref = required(args.positionals[0], "a state name or UUID");
  const project = await resolveProject(client, requiredFlag(args, "project"));
  const state = resolveNamed(await listStates(client, project.id), ref, "state");
  await client.request(`projects/${project.id}/states/${state.id}/`, { method: "DELETE" });
  return state;
};
