// Phase 3: permission matrix. memberships.role is source of truth for business access.
// users.role is a journey label (customer|merchant|staff) — never used for authz.
export const OWNER_ONLY = new Set(['program.manage', 'reward.manage', 'outlet.manage', 'staff.manage', 'business.edit']);
export const STAFF_ALLOWED = new Set(['qr.issue', 'redeem.decide', 'business.read', 'customers.read', 'transactions.read']);

export function canDo({ membershipRole, action }) {
  if (membershipRole === 'owner') return true; // owners can do everything in their business
  if (membershipRole === 'staff') return STAFF_ALLOWED.has(action);
  return false;
}
