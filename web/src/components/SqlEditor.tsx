import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Table } from "../lib/sql";
import { suggestions as suggest, tokenize, wordAt, type Suggestion } from "../lib/sqlEditor";

export interface SqlEditorHandle {
  /** Insert text at the cursor (replacing a selection) and focus the editor. */
  insert(text: string): void;
  focus(): void;
}

/** A SQL editor: highlighting under a transparent textarea (typing stays native),
 * table and column suggestions as you type (Tab or Enter to take one), Ctrl+Enter
 * to run. */
export const SqlEditor = forwardRef<SqlEditorHandle, {
  value: string;
  onChange: (sql: string) => void;
  onRun: () => void;
  tables: Table[];
  errorLine?: number;
}>(function SqlEditor({ value, onChange, onRun, tables, errorLine }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLPreElement>(null);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const tokens = useMemo(() => tokenize(value, tables), [value, tables]);
  const list: Suggestion[] = useMemo(() => (open ? suggest(value, cursor, tables) : []), [open, value, cursor, tables]);

  const setText = (next: string, caret: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
      setCursor(caret);
    });
  };

  useImperativeHandle(ref, () => ({
    insert(text: string) {
      const el = area.current;
      const start = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? value.length;
      setText(value.slice(0, start) + text + value.slice(end), start + text.length);
    },
    focus: () => area.current?.focus(),
  }));

  const accept = (s: Suggestion) => {
    const [start, end] = wordAt(value, cursor);
    const text = s.kind === "function" ? `${s.text}(` : s.text;
    setText(value.slice(0, start) + text + value.slice(end), start + text.length);
    setOpen(false);
  };

  return (
    <div className="sql-editor-wrap">
      <div className="sql-editor-box">
        <pre ref={highlight} className="sql-highlight" aria-hidden="true">
          {tokens.map((t, i) => (t.kind === "text" || t.kind === "punct" ? t.text : <span key={i} className={`tok-${t.kind}`}>{t.text}</span>))}
          {"\n"}
        </pre>
        <textarea
          ref={area}
          className={`sql-editor${errorLine ? " has-error" : ""}`}
          aria-label="SQL query"
          aria-autocomplete="list"
          aria-expanded={list.length > 0}
          spellCheck={false}
          wrap="off"
          value={value}
          rows={Math.min(18, Math.max(6, value.split("\n").length + 1))}
          onChange={(e) => {
            onChange(e.target.value);
            setCursor(e.target.selectionStart);
            setOpen(true);
            setActive(0);
          }}
          onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
          onScroll={(e) => {
            if (highlight.current) {
              highlight.current.scrollTop = e.currentTarget.scrollTop;
              highlight.current.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              setOpen(false);
              onRun();
              return;
            }
            if (!list.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % list.length); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + list.length) % list.length); }
            else if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); accept(list[Math.min(active, list.length - 1)]); }
            else if (e.key === "Escape") setOpen(false);
          }}
        />
      </div>
      {list.length > 0 && (
        <ul className="sql-suggest" role="listbox" aria-label="Suggestions">
          {list.map((s, i) => (
            <li key={`${s.kind}:${s.text}:${s.detail}`} role="option" aria-selected={i === active}
              className={i === active ? "active" : undefined}
              onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
              <code>{s.text}</code> <span className="muted small">{s.kind}{s.detail ? ` · ${s.detail}` : ""}</span>
            </li>
          ))}
          <li className="muted small sql-suggest-hint" aria-hidden="true">Tab or Enter to insert · Esc to close</li>
        </ul>
      )}
    </div>
  );
});
