import { Link } from "react-router-dom";
import type { Rollup } from "../lib/domains";

/** Health, sensitivity and cleanup counts for a domain or data product. */
export function RollupTiles({ r, browse }: { r: Rollup; browse?: string }) {
  return (
    <div className="tiles">
      <div className="tile static"><span className="tile-num">{r.total}</span><span className="tile-label">assets{browse && <> · <Link to={browse}>browse</Link></>}</span></div>
      <div className="tile static"><span className="tile-num">{r.critical + r.warning}</span><span className="tile-label">with health findings{r.critical ? ` (${r.critical} critical)` : ""}</span></div>
      <div className="tile static"><span className="tile-num">{r.atRisk}</span><span className="tile-label">at risk from upstream problems</span></div>
      <div className="tile static"><span className="tile-num">{r.sensitive}</span><span className="tile-label">hold sensitive data</span></div>
      <div className="tile static"><span className="tile-num">{r.undocumented}</span><span className="tile-label">without a description</span></div>
      <div className="tile static"><span className="tile-num">{r.unused}</span><span className="tile-label">unused</span></div>
    </div>
  );
}
