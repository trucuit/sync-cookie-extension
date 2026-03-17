export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Math.random()}`.slice(2);
  return `${prefix}-${random}`;
}
