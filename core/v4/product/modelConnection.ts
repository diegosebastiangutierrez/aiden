/** Presentation groups only. Selecting a group never changes execution authority. */
export type ModelConnectionKind = 'local' | 'byok' | 'oauth';

export const MODEL_CONNECTION_CHOICES: ReadonlyArray<{ id: ModelConnectionKind; title: string; detail: string }> = [
  { id: 'local', title: 'Local model', detail: 'Use Ollama on this computer. No cloud API key or Aiden account required.' },
  { id: 'byok', title: 'Cloud · your API key', detail: 'Connect a supported cloud provider. Usage is billed by that provider.' },
  { id: 'oauth', title: 'Subscription sign-in', detail: 'Sign in through a supported provider. Subscription access and limits apply.' },
];

export function modelConnectionKind(authKinds: readonly string[]): ModelConnectionKind | null {
  if (authKinds.includes('local')) return 'local';
  if (authKinds.includes('oauth') || authKinds.includes('device_code')) return 'oauth';
  if (authKinds.includes('api_key')) return 'byok';
  return null;
}

export function isModelConnectionKind(value: unknown): value is ModelConnectionKind {
  return value === 'local' || value === 'byok' || value === 'oauth';
}
