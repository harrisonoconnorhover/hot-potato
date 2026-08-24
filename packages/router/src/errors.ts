export class NoMatchingRuleError extends Error {
  constructor() {
    super("No routing rule matched this lead.");
    this.name = "NoMatchingRuleError";
  }
}

export class NoEligibleRepError extends Error {
  constructor(poolId: string) {
    super(`No eligible representative is available in pool ${poolId}.`);
    this.name = "NoEligibleRepError";
  }
}
