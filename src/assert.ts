/**
 * Exhaustiveness guard for switches over closed unions: unreachable when the
 * union is fully handled, and a compile error appears here when a new member
 * is added without a case.
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
