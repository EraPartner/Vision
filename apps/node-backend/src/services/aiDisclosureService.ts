import { validateDisclosureGrant } from "./cloudDisclosurePolicy.ts";
import * as repository from "../repositories/aiDisclosureRepository.ts";

export async function createDisclosureGrant(value: unknown) {
  return repository.createGrant(validateDisclosureGrant(value));
}
export const listDisclosureGrants = repository.listGrants;
export const listDisclosureRecords = repository.listRecords;
export const revokeDisclosureGrant = repository.revokeGrant;
export const deleteDisclosureHistory = repository.deleteHistory;
