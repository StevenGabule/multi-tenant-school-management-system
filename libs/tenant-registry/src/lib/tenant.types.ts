// Mirror of the control-plane Tenant shape exposed by tenant-service.
// We intentionally don't import from tenant-service's generated client —
// libraries should not depend on a particular service's internals.
// If the wire format ever drifts from these types, the integration test
// catches it.

export type TenantTier = 'pool' | 'bridge' | 'silo';

export type TenantStatus =
  | 'pending'
  | 'active'
  | 'suspended'
  | 'migrating'
  | 'terminated';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  tier: TenantTier;
  region: string;
  status: TenantStatus;
  dsn: string | null;
  version: number;
  planId: string | null;
  createdAt: string;
  updatedAt: string;
  suspendedAt: string | null;
}
