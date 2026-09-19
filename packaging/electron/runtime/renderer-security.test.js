"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const {
  isAllowedPermissionCheck,
  isTrustedRendererUrl,
} = require("./renderer-security");

const appUrl = "http://localhost:36962";
const errorPage = path.join(__dirname, "..", "assets", "error.html");

test("renderer navigation is limited to the selected backend origin and exact error page", () => {
  assert.equal(
    isTrustedRendererUrl(`${appUrl}/analysis?q=1`, appUrl, errorPage),
    true,
  );
  assert.equal(
    isTrustedRendererUrl(
      `${pathToFileURL(errorPage)}?message=offline`,
      appUrl,
      errorPage,
    ),
    true,
  );
  for (const candidate of [
    "http://localhost:3002/",
    "http://127.0.0.1:36962/",
    "http://localhost.evil.test:36962/",
    "http://user:pass@localhost:36962/",
    pathToFileURL(path.join(__dirname, "..", "preload.js")).href,
    "https://example.com/",
    "data:text/html,hello",
    "not a URL",
  ]) {
    assert.equal(
      isTrustedRendererUrl(candidate, appUrl, errorPage),
      false,
      candidate,
    );
  }
});

test("permission checks permit only app-origin clipboard writes and loopback access", () => {
  for (const permission of [
    "clipboard-sanitized-write",
    "loopback-network",
    "local-network-access",
  ]) {
    assert.equal(isAllowedPermissionCheck(permission, appUrl, appUrl), true);
    assert.equal(
      isAllowedPermissionCheck(permission, "http://localhost:3002", appUrl),
      false,
    );
  }
  for (const permission of [
    "clipboard-read",
    "media",
    "fileSystem",
    "notifications",
    "geolocation",
  ]) {
    assert.equal(isAllowedPermissionCheck(permission, appUrl, appUrl), false);
  }
});
