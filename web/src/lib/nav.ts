/** The menu bar: pages grouped into a few menus, and which menu a page belongs to. */

export interface NavItem {
  to: string;
  label: string;
  hint: string;
}
export interface NavMenu {
  id: string;
  label: string;
  items: NavItem[];
  /** Other paths that belong to this menu (object pages, command pages...). */
  also: string[];
}

export const MENUS: NavMenu[] = [
  {
    id: "explore",
    label: "Explore",
    items: [
      { to: "/search", label: "Browse", hint: "Search and filter every object" },
      { to: "/domains", label: "Domains", hint: "Business domains and data products" },
      { to: "/schemas", label: "Schemas", hint: "Fields of sourcetypes, lookups and collections" },
      { to: "/compare", label: "Compare", hint: "Two or more schemas side by side" },
      { to: "/glossary", label: "Glossary", hint: "Business terms and the fields they name" },
    ],
    also: ["/entity/", "/products/", "/properties"],
  },
  {
    id: "quality",
    label: "Quality and risk",
    items: [
      { to: "/findings", label: "Findings", hint: "Problems to fix, by severity" },
      { to: "/health", label: "Health", hint: "Data, searches, forwarders and tokens" },
      { to: "/coverage", label: "Coverage", hint: "Detections against MITRE ATT&CK" },
      { to: "/governance", label: "Governance", hint: "Sensitive data and who can reach it" },
      { to: "/changes", label: "Changes", hint: "What changed since earlier builds" },
    ],
    also: [],
  },
  {
    id: "analyse",
    label: "Analyse",
    items: [
      { to: "/insights", label: "Insights", hint: "Documentation, usage, owners and commands" },
      { to: "/sql", label: "SQL", hint: "Query the catalog with SQL" },
    ],
    also: ["/commands/"],
  },
];

export const HELP: NavItem = { to: "/help", label: "Help", hint: "How to use Licoryx Delvecat" };
export const ADMIN: NavItem[] = [
  { to: "/build", label: "Build", hint: "Build, schedule, export and import the catalog" },
  { to: "/testing", label: "Testing", hint: "Connectivity to other stacks; what limited the build" },
];

/** Every page, for the command palette. */
export const ALL_PAGES: NavItem[] = [
  { to: "/", label: "Home", hint: "Overview of the catalog" },
  ...MENUS.flatMap((m) => m.items),
  HELP,
];

/** The menu a path belongs to (for highlighting), or undefined. */
export function menuOf(pathname: string): string | undefined {
  for (const m of MENUS) {
    if (m.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))) return m.id;
    if (m.also.some((p) => pathname === p || pathname.startsWith(p))) return m.id;
  }
  if (ADMIN.some((i) => pathname.startsWith(i.to))) return "admin";
  return undefined;
}

/** "2 h ago", "3 days ago": how long ago a time was. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const SEEN_KEY = "delvecat.changesSeen";

/** When the viewer last opened the Changes page (to mark builds published since). */
export function changesSeen(): string | null {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}
export function markChangesSeen(generatedAt: string): void {
  try { localStorage.setItem(SEEN_KEY, generatedAt); } catch { /* private mode */ }
}
