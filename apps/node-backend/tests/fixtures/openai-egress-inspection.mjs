const mode = process.env.VISION_EGRESS_TEST_MODE;

globalThis.fetch = async (url, init) => {
  process.stderr.write(
    `${JSON.stringify({
      type: "request",
      url: String(url),
      method: init.method,
      redirect: init.redirect,
      headers: Object.fromEntries(new Headers(init.headers)),
      bodyBase64: Buffer.from(init.body).toString("base64"),
    })}\n`,
  );

  if (mode === "timeout") {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          process.stderr.write(`${JSON.stringify({ type: "abort" })}\n`);
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  if (mode !== "success") throw new Error("Unexpected synthetic fetch mode");
  return Response.json({ id: "resp_child_synthetic", output_text: "{}" });
};
