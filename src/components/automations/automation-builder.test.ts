import { describe, it, expect } from "vitest";
import { toApiSteps, fromServerSteps, type BuilderStep } from "./automation-builder";

// ---------------------------------------------------------------------------
// feat/automation-durable-followup-media — the new `send_media` step must
// round-trip through the same save/reload path every other step type uses:
// toApiSteps (builder -> POST body) and fromServerSteps (GET response ->
// builder state). Neither function special-cases step types other than
// `condition` (branches), so a send_media step_config with every field set
// — including the temporary ManyChat bridge field — must survive both
// directions byte-for-byte.
// ---------------------------------------------------------------------------

describe("send_media — config round-trips through toApiSteps / fromServerSteps (spec §5)", () => {
  const config = {
    media_type: "image",
    media_url: "https://cdn.example.com/combo.png",
    caption: "Combo XTD",
    filename: "combo.png",
    manychat_bridge_flow_ns: "content2026abc123",
  };

  it("toApiSteps passes step_config through unchanged", () => {
    const builderStep: BuilderStep = {
      cid: "c_1",
      step_type: "send_media",
      step_config: config,
    };
    const api = toApiSteps([builderStep]);
    expect(api).toEqual([{ step_type: "send_media", step_config: config, branches: undefined }]);
  });

  it("fromServerSteps reconstructs the exact same config from a server row", () => {
    const [step] = fromServerSteps([
      {
        id: "s1",
        step_type: "send_media",
        step_config: config,
        branches: { yes: [], no: [] },
      },
    ]);
    expect(step.step_type).toBe("send_media");
    expect(step.step_config).toEqual(config);
    // Not a condition, so it must not be forced into a branches shape.
    expect(step.branches).toBeUndefined();
  });

  it("a full save -> reload cycle (toApiSteps then fromServerSteps) is lossless", () => {
    const builderStep: BuilderStep = {
      cid: "c_1",
      step_type: "send_media",
      step_config: config,
    };
    const [saved] = toApiSteps([builderStep]);
    const [reloaded] = fromServerSteps([
      { id: "s1", step_type: saved.step_type, step_config: saved.step_config, branches: { yes: [], no: [] } },
    ]);
    expect(reloaded.step_config).toEqual(config);
  });

  it("defaults to an empty step_config ({}) when the server row has none, same as any other step", () => {
    const [step] = fromServerSteps([
      { id: "s1", step_type: "send_media", step_config: undefined as unknown as Record<string, unknown>, branches: { yes: [], no: [] } },
    ]);
    expect(step.step_config).toEqual({});
  });
});
