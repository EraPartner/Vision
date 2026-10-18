import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { uploadTempPath } from "../src/lib/csvUpload.ts";
import { ValidationError } from "../src/middleware/errorHandler.ts";

describe("uploadTempPath", () => {
  it("keeps multer's generated name inside the temp directory", () => {
    expect(uploadTempPath("/elsewhere/../etc/0a1b2c3d")).toBe(
      path.join(os.tmpdir(), "0a1b2c3d"),
    );
  });

  it("refuses a basename outside the allowlist", () => {
    expect(() => uploadTempPath("/tmp/bad name")).toThrow(ValidationError);
    expect(() => uploadTempPath("..")).toThrow(ValidationError);
  });
});
