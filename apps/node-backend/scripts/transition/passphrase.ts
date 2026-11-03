/**
 * Where the backup passphrase comes from, asked only when the backup is
 * encrypted: `--passphrase-file <file>`, else VISION_BACKUP_PASSPHRASE (the
 * variable Vision 2.0 itself honoured), else a prompt without echo when
 * stdin is a terminal. The passphrase is used exactly as given (Vision 2.0
 * fed it to scrypt as UTF-8 without trimming); only the file's final line
 * break is dropped.
 */
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { TransitionError, UsageError } from "./errors.ts";

export const PASSPHRASE_ENV = "VISION_BACKUP_PASSPHRASE";

export function readPassphraseFile(file: string): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(`Cannot read --passphrase-file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const passphrase = text.replace(/\r?\n$/, "");
  if (passphrase === "") throw new UsageError(`--passphrase-file ${file} is empty.`);
  return passphrase;
}

/** Prompt on stderr and read one line from a TTY stdin without echoing it. */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let value = "";
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (error: Error | null): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of decoder.write(chunk)) {
        if (ch === "\r" || ch === "\n") {
          finish(null);
          return;
        }
        if (ch === "\u0003") {
          finish(new TransitionError("Cancelled at the passphrase prompt; nothing was changed."));
          return;
        }
        if (ch === "\u0004" && value === "") {
          finish(new TransitionError("No passphrase entered; nothing was changed."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export interface PassphraseSources {
  file: string | undefined;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
}

/** A lazy passphrase provider: nothing is read or asked until a backup turns out to be encrypted. */
export function passphraseProvider(sources: PassphraseSources): () => Promise<string> {
  let cached: string | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    if (sources.file !== undefined) {
      cached = readPassphraseFile(sources.file);
    } else if (sources.env[PASSPHRASE_ENV] !== undefined && sources.env[PASSPHRASE_ENV] !== "") {
      cached = sources.env[PASSPHRASE_ENV];
    } else if (sources.interactive) {
      cached = await promptHidden("Backup passphrase (as set in Vision 2.0): ");
      if (cached === "") throw new TransitionError("No passphrase entered; nothing was changed.");
    } else {
      throw new UsageError(
        `The backup is encrypted. Pass --passphrase-file <file>, set ${PASSPHRASE_ENV}, or run in a terminal to be asked.`,
      );
    }
    return cached;
  };
}
