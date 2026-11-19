/**
 * Index storage tiers and retention, in Splunk Enterprise's terms (hot, warm, cold,
 * frozen, thawed) and Splunk Cloud's (searchable storage, Active Archive, Self Storage).
 * The ingestion records tiers in Enterprise terms; this adds the other names.
 */
import type { Entity } from "../generated/catalog";

export interface Tier {
  tier: "hot" | "warm" | "cold" | "frozen" | "thawed";
  path?: string;
  remote?: boolean;
  maxSizeMB?: number;
  sizeMB?: number;
  buckets?: number;
  maxBuckets?: number;
  action?: "delete" | "archiveDir" | "archiveScript" | "activeArchive" | "selfStorage";
  provider?: string;
  archiveRetentionDays?: number;
}

export interface Storage {
  model: "classic" | "smartStore";
  tiers: Tier[];
  maxDataSize?: string;
  oldestEventInHome?: string;
}

export function storageOf(e: Entity): Storage | undefined {
  const s = (e.properties as Record<string, unknown> | undefined)?.storage as Storage | undefined;
  return s?.tiers?.length ? s : undefined;
}

/** The tier's name on Splunk Enterprise, and on Splunk Cloud. */
export function tierNames(t: Tier, smartStore: boolean): { enterprise: string; cloud: string } {
  switch (t.tier) {
    case "hot":
      return { enterprise: "Hot (being written)", cloud: "Searchable storage (DDAS)" };
    case "warm":
      return {
        enterprise: smartStore ? "Warm (SmartStore remote store, cached locally)" : "Warm",
        cloud: "Searchable storage (DDAS)",
      };
    case "cold":
      return { enterprise: "Cold", cloud: "Searchable storage (DDAS)" };
    case "thawed":
      return { enterprise: "Thawed (restored from an archive)", cloud: "Restored from Active Archive" };
    case "frozen":
      return frozenNames(t);
  }
}

function frozenNames(t: Tier): { enterprise: string; cloud: string } {
  switch (t.action) {
    case "archiveDir":
      return { enterprise: "Frozen: archived to a directory", cloud: "Frozen: archived" };
    case "archiveScript":
      return { enterprise: "Frozen: archived by a script", cloud: "Frozen: archived" };
    case "activeArchive":
      return { enterprise: "Frozen: Splunk-managed archive", cloud: "Dynamic Data Active Archive (DDAA)" };
    case "selfStorage":
      return { enterprise: "Frozen: copied to your own storage", cloud: "Dynamic Data Self Storage (DDSS)" };
    default:
      return { enterprise: "Frozen: deleted", cloud: "Deleted after searchable retention" };
  }
}

export const fmtMB = (mb?: number) =>
  mb == null ? "—" : mb >= 1024 * 1024 ? `${(mb / 1024 / 1024).toFixed(1)} TB` : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toLocaleString()} MB`;

/** "365 days or 500 GB, whichever comes first". */
export function retentionText(p: Record<string, unknown>): string | undefined {
  const days = p.retentionDays as number | undefined;
  const size = (p.maxGlobalDataSizeMB ?? p.maxTotalDataSizeMB) as number | undefined;
  if (!days && !size) return undefined;
  const parts = [days ? `${days.toLocaleString()} days` : undefined, size ? fmtMB(size) : undefined].filter(Boolean);
  return parts.length === 2 ? `${parts[0]} or ${parts[1]}, whichever comes first` : parts[0];
}
