import { isAbsolute } from "node:path";
import { createExperimentalCodexSession } from "../src/integrations/codex/experimentalSession.js";

const binary = process.env.VISION_EXPERIMENTAL_CODEX_BINARY;
if (process.platform !== "darwin" || !binary || !isAbsolute(binary)) {
  console.error("Set an absolute VISION_EXPERIMENTAL_CODEX_BINARY on macOS.");
  process.exitCode = 1;
} else {
  const traffic = [];
  const events = [];
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
        code: error.code || error.message,
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
          code: error.code || error.message,
        }),
      );
      process.exitCode = 1;
    }
  }
}
