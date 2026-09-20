#!/usr/bin/env node

import {
  CLOUD_PRIVACY_EVALUATION_CASES,
  CLOUD_PRIVACY_SYNTHETIC_POLICY,
} from "../src/services/aiEvaluation/cloudPrivacyCases.js";
import { evaluateCloudPrivacyTrace } from "../src/services/aiEvaluation/cloudPrivacy.js";

function unique(values) {
  return [...new Set(values)].sort();
}

const cases = CLOUD_PRIVACY_EVALUATION_CASES.map((testCase) => {
  const result = evaluateCloudPrivacyTrace(
    testCase.trace,
    CLOUD_PRIVACY_SYNTHETIC_POLICY,
  );
  const actual = unique(result.violations.map((entry) => entry.code));
  const expected = unique(testCase.expectedViolationCodes);
  return {
    id: testCase.id,
    detectorPassed: JSON.stringify(actual) === JSON.stringify(expected),
    expectedViolationCodes: expected,
    actualViolationCodes: actual,
    inspectedRequests: result.inspectedRequests,
    inspectedBytes: result.inspectedBytes,
  };
});

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  syntheticDetectorPassed: cases.every((testCase) => testCase.detectorPassed),
  releaseAccepted: false,
  releaseBlockers: [
    "Live OpenAI API traffic, account entitlement, and current retention controls have not been verified.",
    "The separate macOS Seatbelt smoke check does not verify live provider traffic or network confinement.",
    "The experimental Codex route completed one fictional turn, but encrypted provider payloads, provider-side logout, and independent route acceptance remain unverified.",
    "Local-only, cloud-plan, and approved-summary utility have not been compared on identical financial tasks.",
  ],
  utility: { evaluated: false },
  cases,
};

console.log(JSON.stringify(report, null, 2));
if (!report.syntheticDetectorPassed) process.exitCode = 1;
