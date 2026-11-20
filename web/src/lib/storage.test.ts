import { describe, expect, it } from "vitest";
import { fmtMB, retentionText, storeText, tierNames } from "./storage";

describe("storage terminology", () => {
  it("names tiers in Splunk Enterprise and Splunk Cloud terms", () => {
    expect(tierNames({ tier: "cold" }, false)).toEqual({ enterprise: "Cold", cloud: "Searchable storage (DDAS)" });
    expect(tierNames({ tier: "warm", remote: true }, true).enterprise).toContain("SmartStore");
    expect(tierNames({ tier: "frozen", action: "activeArchive" }, false).cloud).toBe("Dynamic Data Active Archive (DDAA)");
    expect(tierNames({ tier: "frozen", action: "selfStorage" }, false).cloud).toBe("Dynamic Data Self Storage (DDSS)");
    expect(tierNames({ tier: "frozen", action: "delete" }, false).enterprise).toBe("Frozen: deleted");
  });
  it("describes retention", () => {
    expect(retentionText({ retentionDays: 365, maxTotalDataSizeMB: 500000 })).toBe("365 days or 488.3 GB, whichever comes first");
    expect(retentionText({ retentionDays: 90 })).toBe("90 days");
    expect(retentionText({})).toBeUndefined();
    expect(fmtMB(20)).toBe("20 MB");
  });
  it("describes object stores", () => {
    expect(storeText({ tier: "warm", provider: "Azure Blob Storage", bucket: "splunk-warm", storageAccount: "acmesplunk", volume: "azure_store" }))
      .toBe("Azure Blob Storage: account acmesplunk, container splunk-warm (volume azure_store)");
    expect(storeText({ tier: "frozen", provider: "Amazon S3", bucket: "acme-frozen" })).toBe("Amazon S3: bucket acme-frozen");
    expect(storeText({ tier: "cold" })).toBeUndefined();
  });
});
