import { dirname, isAbsolute, resolve } from "node:path";

const quoted = (value) => JSON.stringify(value);

function ancestors(file) {
  const result = [];
  let current = dirname(file);
  while (current !== "/") {
    result.push(`(literal ${quoted(current)})`);
    current = dirname(current);
  }
  return result;
}

// Offline App Server profile. There is intentionally no network permission.
// The Codex process can execute only its own binary and cannot read Vision data.
export function codexOfflineSeatbeltProfile(binary, syntheticRoot) {
  if (
    typeof binary !== "string" ||
    typeof syntheticRoot !== "string" ||
    !isAbsolute(binary) ||
    !isAbsolute(syntheticRoot)
  ) {
    throw new TypeError("Absolute Codex paths required");
  }
  const executable = resolve(binary);
  const root = resolve(syntheticRoot);
  if (root === "/" || root === dirname(root)) {
    throw new TypeError("Synthetic root must be private");
  }
  const parents = [...new Set([...ancestors(executable), ...ancestors(root)])];
  return `(version 1)
(deny default)
(allow process-exec (literal ${quoted(executable)}))
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata ${parents.join(" ")} (subpath "/private/etc") (subpath "/etc"))
(allow file-read* (literal "/") (literal ${quoted(executable)})
  (subpath ${quoted(root)}) (subpath "/System") (subpath "/Library")
  (subpath "/usr") (subpath "/dev") (subpath "/private/var/db"))
(allow file-write* (subpath ${quoted(root)}))`;
}

export function codexProxySeatbeltProfile(binary, syntheticRoot, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("Invalid Codex proxy port");
  }
  return `${codexOfflineSeatbeltProfile(binary, syntheticRoot)}\n(allow network-outbound (remote ip "localhost:${port}"))`;
}
