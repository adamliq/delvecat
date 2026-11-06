import { useState } from "react";
import type { AnnotationSource, Entity } from "../generated/catalog";
import { annotationSnippet, editLinks } from "../lib/annotate";

export function AnnotationsTab({ entity, source }: { entity: Entity; source?: AnnotationSource }) {
  const [copied, setCopied] = useState(false);
  const snippet = annotationSnippet(entity);
  const links = source ? editLinks(entity, source) : undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="stack">
      <section>
        <h2>Where this comes from</h2>
        {entity.annotations?.sources?.length ? (
          <ul className="plain-list">
            {(links?.sources ?? entity.annotations.sources.map((s) => ({ label: s, view: "", edit: "" }))).map((s) => (
              <li key={s.label}>
                <code>{s.label}</code>
                {s.label === entity.annotations?.primarySource ? <span className="muted small"> (this object)</span> : <span className="muted small"> (shared rule)</span>}
                {s.view && <> · <a href={s.view} target="_blank" rel="noreferrer">view</a> · <a href={s.edit} target="_blank" rel="noreferrer">edit</a></>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing annotates this object yet.</p>
        )}
        <p className="muted small">
          Annotations live in the repository's <code>{source?.path ?? "annotations"}/</code> folder and change
          through pull requests. They are never written to Splunk.
        </p>
      </section>

      <section>
        <h2>Suggest an edit</h2>
        {links?.primary ? (
          <p>
            <a className="btn btn-primary" href={links.primary.edit} target="_blank" rel="noreferrer">
              Edit this object's annotation on GitHub
            </a>{" "}
            <span className="muted small">
              <code>{links.primary.label}</code> · or{" "}
              <a href={links.create} target="_blank" rel="noreferrer">propose a separate file</a>
            </span>
          </p>
        ) : links ? (
          <p>
            <a className="btn btn-primary" href={links.create} target="_blank" rel="noreferrer">
              Propose an annotation on GitHub
            </a>{" "}
            <span className="muted small">Opens a new file with the entry below filled in.</span>
          </p>
        ) : (
          <p className="muted small">
            This bundle does not say which repository holds its annotations (build with{" "}
            <code>--annotation-repo</code>). Copy the entry below into a file under <code>annotations/</code>.
          </p>
        )}
        <div className="snippet-head">
          <span className="muted small">YAML entry</span>
          <button type="button" className="btn btn-small" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
        <pre className="code">{snippet}</pre>
      </section>
    </div>
  );
}
