/** Index-time actions of transforms and props.conf rules, in words. */
export interface IndexTimeAction {
  action: string;
  targets?: string[];
  conditional?: boolean;
  field?: string;
  expression?: string;
}

export interface IndexTimeRule {
  rule: string;
  transform?: string;
  app?: string;
  action?: string;
  actions?: string[];
  targets?: string[];
  sed?: string;
}

const LABELS: Record<string, string> = {
  drop: "Dropped (nullQueue): never indexed",
  keep: "Kept (everything else dropped)",
  routeToIndex: "Routed to another index",
  forwardTcp: "Forwarded (TCP output group)",
  forwardSyslog: "Forwarded (syslog)",
  forwardHttp: "Forwarded (HTTP output)",
  indexAndForward: "Indexed and forwarded",
  setSourcetype: "Sourcetype changed",
  setHost: "Host changed",
  setSource: "Source changed",
  rewriteRaw: "Event text rewritten",
  mask: "Masked (SEDCMD)",
  indexedField: "Indexed field written",
};

export const actionLabel = (a: string) => LABELS[a] ?? a;

/** Rules that lose or move data: dropped, routed elsewhere, forwarded. */
export const DATA_MOVING = new Set(["drop", "keep", "routeToIndex", "forwardTcp", "forwardSyslog", "forwardHttp", "indexAndForward"]);
