/** Groups and one-line descriptions for the SQL console's examples (lib/sql.ts EXAMPLES). */
export const EXAMPLE_GROUPS = [
  "Searches and alerts",
  "Data and storage",
  "Security and detections",
  "Access and governance",
  "Add-ons, inputs and forwarding",
  "Hygiene and quality",
  "Lineage and dependencies",
] as const;

export type ExampleGroup = (typeof EXAMPLE_GROUPS)[number];

export const EXAMPLE_INFO: Record<string, { group: ExampleGroup; description: string }> = {
  "Searches scheduled every 15 minutes or more often": { group: "Searches and alerts", description: "Frequent schedules: candidates for load review." },
  "Who alert emails go to": { group: "Searches and alerts", description: "Every recipient address, how many alerts and which." },
  "Alerts by how often they fire": { group: "Searches and alerts", description: "Triggers and throttled triggers per alert and detection." },
  "Custom search commands and the searches that run them": { group: "Searches and alerts", description: "Which app adds each command and who uses it." },
  "SPL2 modules, who can read them and what they read": { group: "Searches and alerts", description: "SPL2 modules with their readers and datasets." },
  "Index retention and storage": { group: "Data and storage", description: "Retention, size limit, size, frozen action, storage model." },
  "Index sizes": { group: "Data and storage", description: "Indexes by size on disk." },
  "Acceleration summaries by size and last use": { group: "Data and storage", description: "Data model and report acceleration cost and use." },
  "Federated indexes and where their data lives": { group: "Data and storage", description: "Federated indexes, providers and remote datasets." },
  "External datastores (Azure, AWS, Snowflake) and their connections": { group: "Data and storage", description: "SPL2-native datastores, locations and connections." },
  "Detections with no annotated owner": { group: "Security and detections", description: "Detections nobody is named as owning." },
  "Detections muted, grouped or automated in ES": { group: "Security and detections", description: "Suppressions, aggregation and automation per detection." },
  "Detections that break if a field disappears": { group: "Security and detections", description: "Fields detections depend on." },
  "Authentication tokens to review": { group: "Access and governance", description: "Expired, expiring, stale and orphaned tokens." },
  "Sensitive data every role can read": { group: "Access and governance", description: "Classified data readable by everyone." },
  "Microsoft add-on inputs, the service they read and their account": { group: "Add-ons, inputs and forwarding", description: "Microsoft inputs by service, account and tenant." },
  "Where data is forwarded": { group: "Add-ons, inputs and forwarding", description: "Output groups, destinations and what sends to them." },
  "Data dropped, rerouted or forwarded at index time": { group: "Add-ons, inputs and forwarding", description: "Index-time routing, nullQueue drops and masking per sourcetype." },
  "Unused objects by app": { group: "Hygiene and quality", description: "Cleanup candidates, counted per app." },
  "Health findings by domain": { group: "Hygiene and quality", description: "Warnings and critical findings per data domain." },
  "Missing required properties by owner": { group: "Hygiene and quality", description: "Annotation gaps per owner." },
  "Fields missing from most events": { group: "Hygiene and quality", description: "Sparse fields per sourcetype." },
  "Sourcetype fields nobody uses": { group: "Hygiene and quality", description: "Extracted fields no search reads." },
  "Most depended-on objects": { group: "Lineage and dependencies", description: "Objects the most others read or use." },
  "Problems that put the most objects at risk": { group: "Lineage and dependencies", description: "Root causes ranked by what depends on them." },
};

export const exampleInfo = (title: string) =>
  EXAMPLE_INFO[title] ?? { group: "Hygiene and quality" as ExampleGroup, description: "" };
