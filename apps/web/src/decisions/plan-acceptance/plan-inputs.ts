import { PLAN_ACCEPTANCE_INPUT_LABELS, type PlanAcceptanceInput } from '@craftingtable/domain';

/** The plan-acceptance inputs as the operator reads them (R-C6). */
export const planInputLabels = (inputs: readonly PlanAcceptanceInput[]) =>
  inputs.map((input) => PLAN_ACCEPTANCE_INPUT_LABELS[input]).join(', ');
