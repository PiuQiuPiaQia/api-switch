interface UserIdentity {
  username: string;
  displayName: string;
}

export function resolveAccountName(identity: UserIdentity): string {
  return identity.username.trim() || identity.displayName.trim() || "用户";
}
