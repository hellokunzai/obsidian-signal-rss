// Obsidian ships moment as a module namespace, so the exported binding is typed
// as `typeof Moment` and is not callable directly. This wrapper restores the
// callable factory without pulling in the moment package as a dependency.

import { moment } from "obsidian";

export interface MomentLike {
  isValid(): boolean;
  valueOf(): number;
  format(format?: string): string;
  fromNow(): string;
}

const create = moment as unknown as (
  input?: unknown,
  format?: unknown,
  strict?: boolean
) => MomentLike;

export function toMoment(input?: unknown, format?: unknown, strict?: boolean): MomentLike {
  return create(input, format, strict);
}

export function currentLocale(): string {
  return moment.locale();
}
