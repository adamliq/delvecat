import { Link } from "react-router-dom";
import { CopyButton } from "./CopyButton";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { entityPath } from "../lib/routes";
import { splTokens } from "../lib/splHighlight";

/** SPL with commands, keywords, strings and macros highlighted, and the macros, lookups,
 * indexes, data models and saved searches it names linked to their catalog pages. */
export function SplCode({ text, catalog, entity }: { text: string; catalog: Catalog; entity: Entity }) {
  // Macros are named with their argument count (name(2)); splTokens names them so.
  const find = (type: string, name: string): Entity | undefined => catalog.findOne(entity.instance, type, name);
  return (
    <div className="code-block">
    <CopyButton text={text} label="Copy" className="btn btn-small code-copy" />
    <pre className="code spl">
      {splTokens(text).map((t, i) => {
        const target = t.ref ? find(t.ref.type, t.ref.name) : undefined;
        const body = t.kind === "text" ? t.text : <span className={`spl-${t.kind}`}>{t.text}</span>;
        return target ? (
          <Link key={i} to={entityPath(target.id)} className="spl-link" title={`Open ${target.type} ${target.name}`}>{body}</Link>
        ) : (
          <span key={i}>{body}</span>
        );
      })}
    </pre>
    </div>
  );
}
