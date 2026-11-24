interface ScopedRole {
  roleName: string;
  baseRole: string;
  modelId: string | null;
  connectionId: string | null;
  resolved: boolean;
  priority: number;
  from: { type: string };
}

export function isDirectUserModelRole(role: ScopedRole): boolean {
  // Omni may emit an unresolved, zero-priority NO_ACCESS placeholder when the
  // membership has no direct assignment.
  return (role.from.type === 'USER' || role.from.type === 'User Role')
    && !(role.roleName === 'NO_ACCESS' && role.baseRole === 'NO_ACCESS' && role.priority === 0 && !role.resolved);
}

export function effectiveUserModelRole<Role extends ScopedRole>(
  results: Role[],
  assignment: Pick<ScopedRole, 'roleName' | 'modelId' | 'connectionId'>,
) {
  const resolved = results.filter(role => role.resolved && role.modelId === assignment.modelId
    && role.connectionId === assignment.connectionId);
  if (resolved.length !== 1) return { status: 'unverified' as const, role: null };
  const role = resolved[0];
  const matches = role.roleName === assignment.roleName && role.baseRole === assignment.roleName;
  return { status: matches ? 'requested_role_effective' as const : 'different_role_effective' as const, role };
}
