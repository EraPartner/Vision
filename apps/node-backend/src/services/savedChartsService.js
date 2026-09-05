/**
 * Saved-charts service — the route-facing seam over savedChartsRepository
 * (eslint vision-local/no-repo-direct-from-route).
 */
import savedChartsRepository from "../repositories/savedChartsRepository.js";
import { ValidationError } from "../middleware/errorHandler.js";

/** @param {unknown} error */
function translateMembershipError(error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23503"
  ) {
    throw new ValidationError(
      "One or more selected saved-chart filters no longer exist.",
      { cause: error },
    );
  }
  throw error;
}

const savedChartsService = {
  ...savedChartsRepository,
  async create(input) {
    try {
      return await savedChartsRepository.create(input);
    } catch (error) {
      return translateMembershipError(error);
    }
  },
  async update(id, patch) {
    try {
      return await savedChartsRepository.update(id, patch);
    } catch (error) {
      return translateMembershipError(error);
    }
  },
};

export default savedChartsService;
