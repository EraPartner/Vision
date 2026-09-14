#!/usr/bin/env node

import {
  CLOUD_PRIVACY_EVALUATION_CASES,
  CLOUD_PRIVACY_SYNTHETIC_POLICY,
  CLOUD_UTILITY_REFERENCE,
} from "../src/services/aiEvaluation/cloudPrivacyCases.js";
import {
  evaluateCloudPrivacyTrace,
  scoreCloudUtility,
} from "../src/services/aiEvaluation/cloudPrivacy.js";

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

const utility = {
  cloudPlan: scoreCloudUtility(
    CLOUD_UTILITY_REFERENCE.localOnly,
    CLOUD_UTILITY_REFERENCE.cloudPlan,
  ),
  approvedSummary: scoreCloudUtility(
    CLOUD_UTILITY_REFERENCE.localOnly,
    CLOUD_UTILITY_REFERENCE.approvedSummary,
  ),
};
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  syntheticDetectorPassed: cases.every((testCase) => testCase.detectorPassed),
  releaseAccepted: false,
  releaseBlockers: [
    "Live OpenAI API traffic, account entitlement, and current retention controls have not been verified.",
    "The enclosing managed sandbox blocks a nested macOS Seatbelt runtime smoke test.",
    "No isolated Codex subscription adapter exists to inspect.",
    "Synthetic utility parity is contract evidence, not a live model comparison.",
  ],
  utility,
  cases,
};

console.log(JSON.stringify(report, null, 2));
if (!report.syntheticDetectorPassed) process.exitCode = 1;
