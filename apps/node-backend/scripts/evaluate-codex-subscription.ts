import { isAbsolute } from "node:path";
import type { CodexConnectTrace } from "../src/integrations/codex/connectProxy.ts";
import {
  createExperimentalCodexSession,
  type CodexProtocolEvent,
} from "../src/integrations/codex/experimentalSession.ts";

/** `error.code || error.message`, as the report prints it for any thrown value. */
function failureCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const code = "code" in error ? error.code : undefined;
  return code || ("message" in error ? error.message : undefined);
}

const binary = process.env.VISION_EXPERIMENTAL_CODEX_BINARY;
if (process.platform !== "darwin" || !binary || !isAbsolute(binary)) {
  console.error("Set an absolute VISION_EXPERIMENTAL_CODEX_BINARY on macOS.");
  process.exitCode = 1;
} else {
  const traffic: CodexConnectTrace[] = [];
  const events: CodexProtocolEvent[] = [];
  const session = createExperimentalCodexSession({
    binary,
    onTrace: (entry) => traffic.push(entry),
    onProtocolEvent: (event) => events.push(event),
  });
  try {
    await session.start();
    const login = await session.login();
    console.log(
      `Open ${login.verificationUrl} and enter code ${login.userCode}`,
    );
    const deadline = Date.now() + 5 * 60_000;
    let authenticated = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await session.status();
      if (status.authenticated) {
        authenticated = true;
        console.log(
          `ChatGPT account active (${status.planType || "plan unknown"}).`,
        );
        break;
      }
    }
    if (!authenticated) throw new Error("CODEX_LOGIN_TIMED_OUT");
    const result = await session.runSynthetic();
    console.log(
      JSON.stringify({
        passed: true,
        question: result.question,
        answer: result.answer,
        traffic,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        passed: false,
        code: failureCode(error),
        traffic,
        events,
      }),
    );
    process.exitCode = 1;
  } finally {
    try {
      const closed = await session.logout();
      console.log(
        JSON.stringify({
          localDisposed: closed.localDisposed,
          logoutVerified: closed.logoutVerified,
        }),
      );
    } catch (error) {
      await session.stop().catch(() => {});
      console.error(
        JSON.stringify({
          logoutVerified: false,
          code: failureCode(error),
        }),
      );
      process.exitCode = 1;
    }
  }
}
