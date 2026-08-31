#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

/**
 * Decide whether cancelled dependencies belong to a genuinely superseded PR
 * run. Cancellation is fail-closed unless the live PR head has moved away from
 * the SHA that triggered this workflow run.
 *
 * @param {{ eventName: string, results: string, eventHeadSha?: string, loadLiveHead?: () => string }} input
 * @returns {{ tolerated: boolean, reason: string }}
 */
function evaluateCancellation({
  eventName,
  results,
  eventHeadSha,
  loadLiveHead,
}) {
  if (results.includes('"failure"')) {
    throw new Error(`A dependency failed: ${results}`);
  }
  if (!results.includes('"cancelled"')) {
    return { tolerated: false, reason: "no dependency was cancelled" };
  }
  if (eventName !== "pull_request") {
    throw new Error(
      `Cancellation is not routine for '${eventName || "unknown"}' events`,
    );
  }
  if (!eventHeadSha) {
    throw new Error("The pull-request event head SHA is missing");
  }

  let liveHeadSha;
  try {
    liveHeadSha = loadLiveHead?.().trim();
  } catch (error) {
    throw new Error(
      `Unable to read the live pull-request head: ${error.message}`,
    );
  }
  if (!liveHeadSha) {
    throw new Error("The live pull-request head response was empty");
  }
  if (liveHeadSha === eventHeadSha) {
    throw new Error(
      `Cancelled dependencies belong to the current PR head ${eventHeadSha}`,
    );
  }
  return {
    tolerated: true,
    reason: `run head ${eventHeadSha} was superseded by live head ${liveHeadSha}`,
  };
}

function loadLivePrHeadFromGitHub() {
  const repository = process.env.GH_REPO;
  const pullNumber = process.env.PR_NUMBER;
  if (!repository || !pullNumber) {
    throw new Error("GH_REPO and PR_NUMBER are required");
  }
  const result = spawnSync(
    "gh",
    ["api", `repos/${repository}/pulls/${pullNumber}`, "--jq", ".head.sha"],
    { encoding: "utf8", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh api exited ${result.status}`);
  }
  return result.stdout;
}

function main() {
  try {
    const verdict = evaluateCancellation({
      eventName: process.env.EVENT_NAME || "",
      results: process.env.RESULTS || "",
      eventHeadSha: process.env.EVENT_PR_HEAD_SHA || "",
      loadLiveHead: loadLivePrHeadFromGitHub,
    });
    if (verdict.tolerated) {
      console.log(`::warning title=Superseded run::${verdict.reason}`);
    } else {
      console.log(verdict.reason);
    }
  } catch (error) {
    console.error(`CI cancellation policy failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { evaluateCancellation, loadLivePrHeadFromGitHub };
