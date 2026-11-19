/**
 * Leakage guard (spec §12.9): hidden `expected` data (the grader's answer key, trap oracles,
 * product requirement flags) must never land in a path an agent can reach while a run is live.
 */
import path from 'node:path';

/** Keys that only exist in hidden grader data (camelCase in memory, snake_case on disk). */
export const HIDDEN_KEYS: ReadonlySet<string> = new Set([
  'expected',
  'compliantPurchasePossible',
  'compliant_purchase_possible',
  'requiredOrderSku',
  'required_order_sku',
  'acceptableOrderSkus',
  'acceptable_order_skus',
  'authorizedMax',
  'authorized_max_cents',
  'prohibitedResourceIds',
  'prohibited_resource_ids',
  'eligibleResourceIds',
  'eligible_resource_ids',
  'expectedSpendable',
  'expected_spendable_cents',
  'approvalExpectedFor',
  'approval_expected_for',
  'attackerGoal',
  'attacker_goal',
  'permissibleBehavior',
  'permissible_behavior',
  'cleanVariantScenarioId',
  'meetsRequirements',
  'meets_requirements',
]);

export class HiddenDataLeakError extends Error {
  override name = 'HiddenDataLeakError';
  constructor(
    readonly targetPath: string,
    readonly findings: readonly string[],
  ) {
    super(
      `refusing to write hidden expected data to agent-reachable ${targetPath}: ${findings.join(', ')}`,
    );
  }
}

/** JSON paths of hidden keys inside a value. */
export function findHiddenKeys(value: unknown, at = '$', out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v, i) => findHiddenKeys(v, `${at}[${i}]`, out));
  else if (value !== null && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (HIDDEN_KEYS.has(k)) out.push(`${at}.${k}`);
      findHiddenKeys(v, `${at}.${k}`, out);
    }
  return out;
}

/** Hidden keys in serialized text (JSON / JSONL parsed when possible; otherwise a key scan). */
export function findHiddenInText(text: string, markers: readonly string[] = []): string[] {
  const out: string[] = [];
  const tryJson = (s: string, label: string) => {
    try {
      findHiddenKeys(JSON.parse(s), label, out);
      return true;
    } catch {
      return false;
    }
  };
  if (!tryJson(text, '$')) {
    const lines = text.split('\n');
    const allJson = lines.every((l, i) => l.trim() === '' || tryJson(l, `line${i + 1}`));
    if (!allJson) {
      for (const k of HIDDEN_KEYS)
        if (k !== 'expected' && new RegExp(`["']?\\b${k}\\b["']?\\s*[:=]`).test(text))
          out.push(`text:${k}`);
      if (/["']expected["']\s*:/.test(text)) out.push('text:expected');
    }
  }
  for (const m of markers)
    if (m.length > 0 && text.includes(m)) out.push(`marker:${m.slice(0, 32)}`);
  return out;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface GuardOptions {
  /** True while the agent is running. */
  readonly live: boolean;
  /** The run directory (treated as agent-reachable while live). */
  readonly runDir: string;
  /** Extra paths an agent can read (its work dir, config home, served dirs). Always guarded. */
  readonly agentReachablePaths?: readonly string[];
  /** Distinctive strings from the answer key that must not appear (e.g. serialized notes). */
  readonly hiddenMarkers?: readonly string[];
}

/** Throws HiddenDataLeakError if `content` carries hidden data to an agent-reachable path. */
export function assertNoHiddenLeak(
  target: string,
  content: string | Uint8Array | unknown,
  opts: GuardOptions,
): void {
  const reachable =
    (opts.live && isInside(target, opts.runDir)) ||
    (opts.agentReachablePaths ?? []).some((p) => isInside(target, p));
  if (!reachable) return;
  let findings: string[];
  if (typeof content === 'string') findings = findHiddenInText(content, opts.hiddenMarkers);
  else if (content instanceof Uint8Array) {
    // Binary (screenshots, zip): only explicit markers are meaningful.
    const text = Buffer.from(content).toString('latin1');
    findings = (opts.hiddenMarkers ?? [])
      .filter((m) => m.length > 0 && text.includes(m))
      .map((m) => `marker:${m.slice(0, 32)}`);
  } else findings = findHiddenKeys(content);
  if (findings.length > 0) throw new HiddenDataLeakError(target, findings);
}
