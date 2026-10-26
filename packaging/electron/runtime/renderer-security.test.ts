import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { appRoot } from "../paths";
import {
  externalBrowserUrl,
  isAllowedPermissionCheck,
  isTrustedRendererUrl,
} from "./renderer-security";

const appUrl = "http://localhost:36962";
const errorPage = path.join(appRoot, "assets", "error.html");

void test("renderer navigation is limited to the selected backend origin and exact error page", () => {
  assert.equal(
    isTrustedRendererUrl(`${appUrl}/analysis?q=1`, appUrl, errorPage),
    true,
  );
  assert.equal(
    isTrustedRendererUrl(
      `${pathToFileURL(errorPage).href}?message=offline`,
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

void test("only public http(s) links leave the app for the OS browser", () => {
  for (const candidate of [
    "https://ollama.com/download",
    "http://example.com/news?id=1",
    "https://github.com/owner/repo/releases/tag/v1.0.2",
    "http://[2001:db8::1]/",
    "http://[::ffff:8.8.8.8]/",
  ]) {
    assert.equal(
      externalBrowserUrl(candidate, appUrl),
      new URL(candidate).href,
      candidate,
    );
  }
  for (const candidate of [
    `${appUrl}/api/attachments/3/download`,
    "http://localhost:3002/",
    "http://127.0.0.1:11434/",
    "http://127.8.9.1/",
    "http://[::1]:36962/",
    "http://0.0.0.0:36962/",
    "http://vision.localhost/",
    "http://localhost./",
    "http://[::ffff:127.0.0.1]:3940/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:0:127.0.0.1]/",
    "http://[::127.0.0.1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::]/",
    "http://[::ffff:0.0.0.0]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://0/",
    "https://user:secret@example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "vision://open",
    "mailto:someone@example.com",
    "//example.com/relative",
    "/relative/path",
    "not a URL",
  ]) {
    assert.equal(externalBrowserUrl(candidate, appUrl), undefined, candidate);
  }
});

void test("permission checks permit only app-origin clipboard writes and loopback access", () => {
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
