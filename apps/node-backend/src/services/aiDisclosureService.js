import { validateDisclosureGrant } from "./cloudDisclosurePolicy.js";
import * as repository from "../repositories/aiDisclosureRepository.js";

export async function createDisclosureGrant(value) {
  return repository.createGrant(validateDisclosureGrant(value));
}
export const listDisclosureGrants = repository.listGrants;
export const listDisclosureRecords = repository.listRecords;
export const revokeDisclosureGrant = repository.revokeGrant;
export const deleteDisclosureHistory = repository.deleteHistory;
