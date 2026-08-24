import type { AssignmentState, Rep } from "./types.js";

export function pickWeightedRep(
  reps: Rep[],
  assignmentState: AssignmentState[],
): Rep | undefined {
  const state = new Map(assignmentState.map((item) => [item.repId, item]));

  return [...reps].sort((left, right) => {
    const leftState = state.get(left.id);
    const rightState = state.get(right.id);
    const leftScore = (leftState?.assignments ?? 0) / Math.max(left.weight, 1);
    const rightScore =
      (rightState?.assignments ?? 0) / Math.max(right.weight, 1);
    if (leftScore !== rightScore) return leftScore - rightScore;

    const leftLast = leftState?.lastAssignedAt?.getTime() ?? 0;
    const rightLast = rightState?.lastAssignedAt?.getTime() ?? 0;
    if (leftLast !== rightLast) return leftLast - rightLast;
    return left.id.localeCompare(right.id);
  })[0];
}
