import fs from "node:fs";
import path from "node:path";

export interface GeneratedDirectoryReplacement {
  destination: string;
  retainedPrevious: string | undefined;
}

export function pathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export function replaceGeneratedDirectory(
  stagingDirectory: string,
  destinationDirectory: string,
): GeneratedDirectoryReplacement {
  const staging = path.resolve(stagingDirectory);
  const destination = path.resolve(destinationDirectory);
  if (!pathExists(staging) || !fs.lstatSync(staging).isDirectory())
    throw new Error("Generated runtime staging directory is missing");
  if (
    path.dirname(staging) === staging ||
    path.dirname(destination) === destination
  )
    throw new Error("Generated runtime directory replacement is unsafe");

  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  const hadDestination = pathExists(destination);
  try {
    if (hadDestination) fs.renameSync(destination, previous);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.renameSync(staging, destination);
  } catch (error) {
    if (!pathExists(destination) && hadDestination && pathExists(previous))
      fs.renameSync(previous, destination);
    throw error;
  }

  let retainedPrevious: string | undefined;
  if (hadDestination) {
    try {
      fs.rmSync(previous, { recursive: true, force: true });
    } catch {
      retainedPrevious = previous;
    }
  }
  return { destination, retainedPrevious };
}
