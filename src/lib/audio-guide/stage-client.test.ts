import { describe, expect, it } from "vitest";
import { problemOf } from "./stage-client";

describe("problemOf", () => {
  it("turns every verifier rejection into one of the messages a person sees", () => {
    expect(problemOf("not_mono")).toBe("not_mono");
    expect(problemOf("too_large")).toBe("too_large");
    for (const r of ["not_ogg", "not_opus", "opus_version_unsupported", "bad_channel_mapping"] as const) expect(problemOf(r)).toBe("not_ogg");
    for (const r of ["empty", "truncated", "crc_mismatch", "bad_page_structure", "missing_opus_tags", "missing_end_of_stream", "trailing_data", "no_audio"] as const) expect(problemOf(r)).toBe("corrupt");
    expect(problemOf(undefined)).toBe("corrupt");
  });
});
