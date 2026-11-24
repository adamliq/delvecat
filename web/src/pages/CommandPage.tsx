import { Link, useParams } from "react-router-dom";
import { DataTable } from "../components/DataTable";
import type { Entity } from "../generated/catalog";
import { useCatalog } from "../lib/CatalogContext";
import { commandsOf, customRisk, RISKY_COMMANDS } from "../lib/commands";
import { splTitleClass, typeLabel } from "../lib/labels";
import { entityPath, searchPath } from "../lib/routes";

/** One command, built-in or custom: what it is, whether it is risky, and every search that
 * runs it (with the stack it runs on). */
export function CommandPage() {
  const { catalog } = useCatalog();
  const name = useParams().name ?? "";
  const searches = catalog.entities.filter((e) => commandsOf(e).includes(name));
  const custom = new Map<string, Entity>(); // stack -> the custom command of this name there
  for (const c of catalog.ofType("searchCommand")) if (c.name === name) custom.set(c.instance, c);
  const risk = RISKY_COMMANDS[name] ?? [...custom.values()].map(customRisk).find(Boolean);
  const stacks = new Set(searches.map((s) => s.instance));
  const multi = catalog.bundle.instances.length > 1;
  const stackName = (id: string) => catalog.bundle.instances.find((i) => i.id === id)?.name ?? id;

  return (
    <div className="stack">
      <div>
        <p className="muted small"><Link to="/insights">Insights</Link> · command</p>
        <h1><code>{name}</code></h1>
        <p className="lede">
          {custom.size ? <>Custom search command{custom.size > 1 ? ` on ${custom.size} stacks` : ""}: {[...custom.values()].map((c, i) => (
            <span key={c.id}>{i > 0 && ", "}<Link to={entityPath(c.id)}>{c.app ?? c.name}{multi ? ` (${stackName(c.instance)})` : ""}</Link></span>
          ))}.</> : <>Built-in Splunk command.</>}{" "}
          Run by {searches.length.toLocaleString()} search{searches.length === 1 ? "" : "es"}{multi && stacks.size ? ` on ${stacks.size} stack${stacks.size === 1 ? "" : "s"}` : ""}.
        </p>
        {risk && <p className="notice"><strong>! Risky:</strong> it {risk}. Check that the searches below are still wanted and that only the right roles can edit them.</p>}
      </div>
      {searches.length === 0 ? (
        <p className="muted">No search in the catalog runs this command.</p>
      ) : (
        <DataTable
          rows={searches}
          rowKey={(s) => s.id}
          csvName={`delvecat-command-${name}.csv`}
          columns={[
            { label: "Search", value: (s) => s.displayName ?? s.name, render: (s) => <Link to={entityPath(s.id)} className={splTitleClass(s)}>{s.displayName ?? s.name}</Link> },
            { label: "Type", value: (s) => typeLabel(s.type) },
            { label: "App", value: (s) => s.app ?? "" },
            ...(multi ? [{ label: "Stack", value: (s: Entity) => stackName(s.instance) }] : []),
            { label: "Owner", value: (s) => s.owner ?? "" },
            { label: "Status", value: (s) => (s.disabled ? "disabled" : "enabled") },
            { label: "Runs", value: (s) => s.usage?.runs ?? 0 },
          ]}
        />
      )}
      <p className="small"><Link to={searchPath({ command: name })}>Open these in Browse</Link> to filter them further.</p>
    </div>
  );
}
