/** Credential-free account projection shared by browser and local clients. */
export interface AccountClientState {
  state: 'unavailable' | 'disconnected' | 'pending' | 'linked' | 'denied' | 'expired' | 'revoked';
  portal?: string; userCode?: string; expiresAt?: number;
  account?: { id: string; email: string; emailVerifiedAt: number };
}
export interface AccountClientPort {
  status(): Promise<AccountClientState>;
  begin(surface: 'cli' | 'workbench'): Promise<AccountClientState>;
  disconnect(): Promise<AccountClientState>;
}
