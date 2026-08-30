"use strict";

const http = require("node:http");

function getJson(url, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy(
            new Error("Docker runtime health response is too large"),
          );
        }
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Docker runtime health timeout")),
    );
  });
}

function createDockerRuntime(options) {
  if (!options?.compose)
    throw new Error("Docker runtime requires the Compose adapter");
  const compose = options.compose;
  const workDir = () => options.workDir();
  const overrideFiles = () => options.overrideFiles?.() || [];
  const appPort = () => Number(options.appPort());

  return Object.freeze({
    mode: "docker",
    check: () => compose.checkDocker(workDir()),
    start: (startOptions = {}) =>
      compose.composeStartOrUp(
        workDir(),
        overrideFiles(),
        startOptions.skipBuild === true,
      ),
    stop: () => compose.stopContainers(workDir(), overrideFiles()),
    restart: async (startOptions = {}) => {
      await compose.stopContainers(workDir(), overrideFiles());
      return compose.composeStartOrUp(
        workDir(),
        overrideFiles(),
        startOptions.skipBuild === true,
      );
    },
    health: ({ detailed = false, timeoutMs = 2_000 } = {}) =>
      getJson(
        `http://127.0.0.1:${appPort()}${detailed ? "/health/detailed" : "/health"}`,
        timeoutMs,
      ),
  });
}

module.exports = { createDockerRuntime };
