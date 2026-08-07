/**
 * Rollenmodell (M2.1).
 *
 * Bewusst klein gehalten: `player` entsteht automatisch mit dem Konto,
 * `world_admin` verwaltet Zugänge und Rollen innerhalb genau einer Welt.
 * Weitere Rollen (etwa für Aufsicht, M9.4) kommen erst mit dem Milestone, der
 * sie tatsächlich braucht.
 */

export const ROLES = ["player", "world_admin"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
