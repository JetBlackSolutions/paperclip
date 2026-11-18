import type { OrgPrincipalType } from "./org-principal.js";

export interface HybridOrgNode {
  id: string;
  kind: OrgPrincipalType;
  /** Profile photo for a human member, if available. */
  image?: string | null;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reports: HybridOrgNode[];
}
