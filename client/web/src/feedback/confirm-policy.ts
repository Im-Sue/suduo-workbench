export const CONFIRMATION_OPERATIONS = [
  "delete-attachment",
  "archive-session",
  "delete-session",
  "uninstall-skill",
  "delete-mcp-server",
  "logout-requirements",
  "unlink-workspace-mapping",
  "change-requirements-service",
] as const;

export type ConfirmationOperation = (typeof CONFIRMATION_OPERATIONS)[number];

export interface ConfirmationAction {
  operation: string;
  irreversible: boolean;
  impact: "local" | "project" | "account";
  recovery: "easy" | "costly" | "impossible";
}

const CONFIRMATION_POLICIES: Record<ConfirmationOperation, ConfirmationAction> = {
  "delete-attachment": { operation: "delete-attachment", irreversible: true, impact: "project", recovery: "impossible" },
  "archive-session": { operation: "archive-session", irreversible: false, impact: "project", recovery: "costly" },
  "delete-session": { operation: "delete-session", irreversible: true, impact: "project", recovery: "impossible" },
  "uninstall-skill": { operation: "uninstall-skill", irreversible: true, impact: "project", recovery: "costly" },
  "delete-mcp-server": { operation: "delete-mcp-server", irreversible: true, impact: "project", recovery: "costly" },
  "logout-requirements": { operation: "logout-requirements", irreversible: false, impact: "account", recovery: "costly" },
  "unlink-workspace-mapping": { operation: "unlink-workspace-mapping", irreversible: false, impact: "project", recovery: "costly" },
  "change-requirements-service": { operation: "change-requirements-service", irreversible: false, impact: "account", recovery: "costly" },
};

export function needsConfirm(action: ConfirmationOperation | ConfirmationAction): boolean {
  const policy = typeof action === "string" ? CONFIRMATION_POLICIES[action] : action;
  return policy.irreversible || (policy.impact !== "local" && policy.recovery !== "easy");
}
