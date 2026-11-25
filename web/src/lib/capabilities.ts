import type { Entity } from "../generated/catalog";
import type { Catalog } from "./catalog";

type RoleProps = { capabilities?: string[]; importedCapabilities?: string[] };
const props = (r: Entity) => (r.properties ?? {}) as RoleProps;

export const isHighRisk = (cap: Entity | undefined) => (cap?.properties as { risk?: string } | undefined)?.risk === "high";

/** A role's capabilities: its own and those it inherits from the roles it imports. */
export function roleCapabilities(role: Entity): { own: string[]; inherited: string[] } {
  const own = props(role).capabilities ?? [];
  return { own, inherited: (props(role).importedCapabilities ?? []).filter((c) => !own.includes(c)) };
}

/** The roles a user holds (directly; inherited roles' capabilities are in importedCapabilities). */
export function userRoles(catalog: Catalog, user: Entity): Entity[] {
  return catalog.edgesFrom(user.id).filter((x) => x.type === "memberOf").map((x) => catalog.byId.get(x.to))
    .filter((r): r is Entity => r?.type === "role");
}

/** A user's capabilities, through all their roles. */
export function userCapabilities(catalog: Catalog, user: Entity): Map<string, string[]> {
  const out = new Map<string, string[]>(); // capability -> roles giving it
  for (const r of userRoles(catalog, user)) {
    const { own, inherited } = roleCapabilities(r);
    for (const c of [...own, ...inherited]) out.set(c, [...(out.get(c) ?? []), r.name]);
  }
  return out;
}

export interface Holders {
  direct: Entity[]; // roles granting it themselves
  inherited: Entity[]; // roles that get it from a role they import
  users: Entity[];
}

const cache = new WeakMap<Catalog, Map<string, Holders>>();

/** Who holds each capability on its stack: roles granting it, roles inheriting it, users. */
export function holders(catalog: Catalog, cap: Entity): Holders {
  let all = cache.get(catalog);
  if (!all) {
    all = new Map();
    const roles = catalog.ofType("role");
    const members = new Map<string, Entity[]>(); // role id -> users
    for (const u of catalog.ofType("user")) {
      for (const r of userRoles(catalog, u)) members.set(r.id, [...(members.get(r.id) ?? []), u]);
    }
    for (const r of roles) {
      const { own, inherited } = roleCapabilities(r);
      for (const [list, key] of [[own, "direct"], [inherited, "inherited"]] as const) {
        for (const c of list) {
          const id = `${r.instance}\u0000${c}`;
          const h = all.get(id) ?? { direct: [], inherited: [], users: [] };
          h[key].push(r);
          for (const u of members.get(r.id) ?? []) if (!h.users.includes(u)) h.users.push(u);
          all.set(id, h);
        }
      }
    }
    cache.set(catalog, all);
  }
  return all.get(`${cap.instance}\u0000${cap.name}`) ?? { direct: [], inherited: [], users: [] };
}
