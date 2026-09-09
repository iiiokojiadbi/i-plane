/*
 * turndown-plugin-gfm ships no types and @types/turndown-plugin-gfm does not
 * exist. Only the pieces this project uses are declared; the plugin's shape has
 * been stable since 2018.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
