"use strict";

const { pathToFileURL } = require("node:url");

function isTrustedRendererUrl(candidate, appUrl, errorPagePath) {
  try {
    const url = new URL(candidate);
    const appOrigin = new URL(appUrl).origin;
    if (url.protocol === "http:") {
      return url.origin === appOrigin && !url.username && !url.password;
    }
    if (url.protocol === "file:") {
      const errorUrl = pathToFileURL(errorPagePath);
      return url.host === "" && url.pathname === errorUrl.pathname;
    }
  } catch {
    // Malformed or relative destinations are never a renderer document.
  }
  return false;
}

function isAllowedPermissionCheck(permission, requestingOrigin, appUrl) {
  try {
    if (new URL(requestingOrigin).origin !== new URL(appUrl).origin)
      return false;
  } catch {
    return false;
  }
  // The renderer writes share links to the clipboard and talks to its own
  // loopback backend. It has no camera, microphone, file-system or notification
  // permission; main-process file dialogs and notifications remain separate.
  return [
    "clipboard-sanitized-write",
    "loopback-network",
    "local-network-access",
  ].includes(permission);
}

module.exports = { isTrustedRendererUrl, isAllowedPermissionCheck };
