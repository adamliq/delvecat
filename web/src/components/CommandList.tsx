import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { commandsOf, customCommand, customRisk, RISKY_COMMANDS } from "../lib/commands";
import { commandPath, entityPath } from "../lib/routes";

/** The commands a search runs: custom ones linked, risky ones marked. */
export function CommandList({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const names = commandsOf(entity);
  if (!names.length) return null;
  return (
    <section>
      <h2>Commands</h2>
      <p className="chips">
        {names.map((n) => {
          const custom = customCommand(catalog, entity, n);
          const risk = RISKY_COMMANDS[n] ?? customRisk(custom);
          const label = <code>{n}</code>;
          return (
            <span key={n} className={`chip${risk ? " chip-warn" : ""}`} title={risk ? `Risky: ${risk}` : custom ? "Custom command" : "Built-in command"}>
              {risk && <span aria-hidden>! </span>}
              <Link to={commandPath(n)}>{label}</Link>
              {custom && <> <Link className="muted small" to={entityPath(custom.id)}>custom</Link></>}
            </span>
          );
        })}
      </p>
      {names.some((n) => RISKY_COMMANDS[n] || customRisk(customCommand(catalog, entity, n))) && (
        <p className="muted small">! marks commands that delete data, run programs or a search per result, or send data out of Splunk.</p>
      )}
    </section>
  );
}
