import { Link } from "react-router-dom";
import type { Entity } from "../generated/catalog";
import type { Catalog } from "../lib/catalog";
import { detectionStatus, STATE_LABELS } from "../lib/coverage";
import { typeLabel } from "../lib/labels";
import { impact } from "../lib/lineage";
import { entityPath } from "../lib/routes";

const RESPONSE_TYPES = new Set(["adaptiveResponseAction", "soarLabel", "soarPlaybook", "uebaOutputConnector"]);

export function DetectionPanel({ catalog, entity }: { catalog: Catalog; entity: Entity }) {
  const p = (entity.properties ?? {}) as Record<string, unknown>;
  const status = detectionStatus(catalog, entity);
  const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as string[]) : []);
  const response = impact(catalog, entity.id, 4).filter(
    (e) => RESPONSE_TYPES.has(e.type) || (e.type === "index" && ["notable", "risk"].includes(e.name)),
  );
  const order = ["index", "adaptiveResponseAction", "soarLabel", "soarPlaybook", "uebaOutputConnector"];
  response.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
  const stories = list("analyticStories");

  return (
    <section className="detection">
      <h2>Detection</h2>
      <dl className="facts">
        <dt>Status</dt>
        <dd>
          <span className={`status-label ${status.state === "ready" ? "status-good" : "status-warning"}`}>
            {status.state === "ready" ? "✓" : "!"} {STATE_LABELS[status.state]}
          </span>
        </dd>
        {list("mitreAttack").length > 0 && (
          <>
            <dt>MITRE ATT&CK</dt>
            <dd className="chips">
              {list("mitreAttack").map((t) => (
                <Link key={t} className="chip" to={`/coverage?technique=${encodeURIComponent(t)}`}>{t}</Link>
              ))}
            </dd>
          </>
        )}
        {list("killChainPhases").length > 0 && (<><dt>Kill chain</dt><dd>{list("killChainPhases").join(", ")}</dd></>)}
        {p.securityDomain ? (<><dt>Security domain</dt><dd>{String(p.securityDomain)}</dd></>) : null}
        {p.severity ? (<><dt>Severity</dt><dd>{String(p.severity)}</dd></>) : null}
        {stories.length > 0 && (
          <>
            <dt>Analytic stories</dt>
            <dd>
              {stories.map((s, i) => {
                const story = catalog.byId.get(`${entity.instance}:analyticStory:${s}`);
                return <span key={s}>{i > 0 && ", "}{story ? <Link to={entityPath(story.id)}>{s}</Link> : s}</span>;
              })}
            </dd>
          </>
        )}
        {status.dataModels.length > 0 && (<><dt>Data models</dt><dd>{status.dataModels.join(", ")}</dd></>)}
      </dl>
      <h3>Response chain</h3>
      {response.length ? (
        <ol className="chain">
          {response.map((e) => (
            <li key={e.id}>
              <span className="muted rel-type">{typeLabel(e.type)}</span>{" "}
              <Link to={`${entityPath(e.id)}?tab=lineage`}>{e.displayName ?? e.name}</Link>
              {e.disabled && <span className="muted small"> (disabled)</span>}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No alert actions or SOAR playbooks are connected to this detection.</p>
      )}
    </section>
  );
}
