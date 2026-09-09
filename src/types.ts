/*
 * Only the fields this CLI actually reads. Plane returns twenty-nine per work
 * item; naming the six we use keeps the formatters honest and the output small.
 */

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly identifier: string;
  readonly description?: string | null;
  readonly total_members?: number;
  readonly total_cycles?: number;
  readonly total_modules?: number;
  readonly archived_at?: string | null;
}

export interface Issue {
  readonly id: string;
  readonly name: string;
  readonly sequence_id: number;
  readonly project: string;
  readonly state: string;
  readonly priority: string;
  readonly assignees: ReadonlyArray<string>;
  readonly labels?: ReadonlyArray<string>;
  readonly target_date?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly description_html?: string | null;
  readonly parent?: string | null;
}

export interface State {
  readonly id: string;
  readonly name: string;
  /** backlog | unstarted | started | completed | cancelled */
  readonly group: string;
  readonly default?: boolean;
}

export interface Member {
  readonly id: string;
  readonly display_name?: string;
  readonly email?: string;
}

export interface Cycle {
  readonly id: string;
  readonly name: string;
  readonly start_date?: string | null;
  readonly end_date?: string | null;
}

export interface Module {
  readonly id: string;
  readonly name: string;
}

/** Plane stores priority as a word; this is the order humans expect. */
export const PRIORITY_ORDER: ReadonlyArray<string> = ["urgent", "high", "medium", "low", "none"];

export const priorityRank = (priority: string): number => {
  const index = PRIORITY_ORDER.indexOf(priority);
  return index === -1 ? PRIORITY_ORDER.length : index;
};

/** State groups in workflow order, so listings read top to bottom. */
export const STATE_GROUP_ORDER: ReadonlyArray<string> = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
];

export const stateGroupRank = (group: string): number => {
  const index = STATE_GROUP_ORDER.indexOf(group);
  return index === -1 ? STATE_GROUP_ORDER.length : index;
};
