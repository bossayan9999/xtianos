import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseGitHubUrl } from "./services/github";

describe("parseGitHubUrl", () => {
  it("parses plain repo URLs", () => {
    const ref = parseGitHubUrl("https://github.com/anthropics/skills");
    assert.deepEqual(ref, { owner: "anthropics", repo: "skills", branch: "main", subdir: "" });
  });

  it("parses tree URLs with branch and subdir", () => {
    const ref = parseGitHubUrl(
      "https://github.com/owner/repo/tree/dev/packages/skills-set",
    );
    assert.equal(ref?.branch, "dev");
    assert.equal(ref?.subdir, "packages/skills-set");
  });

  it("rejects non-github URLs", () => {
    assert.equal(parseGitHubUrl("https://gitlab.com/a/b"), null);
    assert.equal(parseGitHubUrl("not a url"), null);
  });
});
