/**
 * Client-side permission hints. The API enforces every permission; the dashboard
 * only hides navigation and controls the caller cannot use (ch. 04/06).
 */
export type Permission = string;

export interface NavPermissionRule {
  any?: Permission[];
}

export function hasAny(perms: ReadonlySet<string>, any?: Permission[]): boolean {
  if (!any || any.length === 0) return true;
  return any.some((p) => perms.has(p));
}
