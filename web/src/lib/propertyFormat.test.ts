import { describe, expect, it } from "vitest";
import { fmtDuration, isIsoDate, numberWithUnit, propLabel, relative, valueLabel } from "./propertyFormat";

describe("readable properties", () => {
  it("labels keys", () => {
    expect(propLabel("retentionDays")).toBe("Retention (days)");
    expect(propLabel("lastAccess")).toBe("Last used");
    expect(propLabel("storageAccount")).toBe("Storage account");
    expect(propLabel("summaryId")).toBe("Summary ID");
    expect(propLabel("hecWindow")).toBe("HEC window");
    expect(propLabel("group_by")).toBe("Group by");
    expect(propLabel("useAck")).toBe("Indexer acknowledgement");
    // Splunk's own setting names stay as they are.
    for (const k of ["DEST_KEY", "REGEX", "action.email.to", "TRANSFORMS-route", "remote.azure.endpoint"]) {
      expect(propLabel(k)).toBe(k);
    }
  });
  it("formats values by their key", () => {
    expect(numberWithUnit("sizeMB", 2048)).toBe("2.0 GB");
    expect(numberWithUnit("maxTotalDataSizeMB", 500000)).toBe("488.3 GB");
    expect(numberWithUnit("timeRangeSecs", 604800)).toBe("7 days");
    expect(numberWithUnit("lastRunSecs", 3.28)).toBe("3.3 s");
    expect(numberWithUnit("completePercent", 98)).toBe("98%");
    expect(numberWithUnit("retentionDays", 1)).toBe("1 day");
    expect(numberWithUnit("port", 8089)).toBeUndefined();
    expect(fmtDuration(5400)).toBe("90 min");
  });
  it("recognises dates and says how long ago", () => {
    expect(isIsoDate("2026-11-19T20:50:17Z")).toBe(true);
    expect(isIsoDate("2026-11-20 05:53:20.952807Z")).toBe(true);
    expect(isIsoDate("acme_web")).toBe(false);
    const now = Date.parse("2026-11-20T00:00:00Z");
    expect(relative("2026-11-17T00:00:00Z", now)).toBe("3 days ago");
    expect(relative("2026-11-20T05:00:00Z", now)).toBe("in 5 hours");
  });
  it("puts coded values in words", () => {
    expect(valueLabel("frozenAction", "archiveDir")).toBe("Archived to a directory");
    expect(valueLabel("protocol", "v2")).toBe("v2 (chunked)");
    expect(valueLabel("frozenAction", "somethingNew")).toBe("somethingNew");
    expect(valueLabel(undefined, "x")).toBe("x");
  });
});
