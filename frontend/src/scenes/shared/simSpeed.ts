/** Simulator pacing: every simulated delay / interval is multiplied by SIM_SLOW, so viewers can follow what happens. */
export const SIM_SLOW = 1.7;
export const slow = (ms: number) => ms * SIM_SLOW;
