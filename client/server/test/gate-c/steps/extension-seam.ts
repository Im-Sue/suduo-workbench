import type { GateCStep } from "./types.js";

/** A no-op registration that proves later slices can add a standalone step module. */
export const extensionSeamStep: GateCStep = {
  id: "extension-seam",
  async run() {
    // Intentionally empty.
  },
};
