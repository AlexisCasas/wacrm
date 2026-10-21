// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { IssueLine } from "./validation-panel";
import en from "../../../messages/en.json";
import es from "../../../messages/es.json";
import ko from "../../../messages/ko.json";

type Msgs = { Flows: { validation: { issues: Record<string, string> }; editorState: { activationRefused: Record<string, string> } } };
let current: Msgs = en as unknown as Msgs;
vi.mock("next-intl", () => ({
  useTranslations: () => Object.assign((key: string, values?: Record<string, string | number>) => {
    const text = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], current.Flows.validation) as string;
    return text.replace(/\{(\w+)\}/g, (_, v) => String(values?.[v] ?? ""));
  }, { has: (key: string) => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], current.Flows.validation) !== undefined }),
}));
afterEach(cleanup);

const CODES = ["execute_flow_target_missing", "execute_flow_return_missing", "execute_flow_return_unknown", "execute_flow_reference_invalid", "execute_flow_policy_invalid", "execute_flow_not_enabled", "execute_flow_target_not_found", "execute_flow_target_not_active", "execute_flow_cycle", "execute_flow_too_deep", "execute_flow_callee_never_returns", "durable_wait_not_enabled", "customer_activity_not_enabled", "customer_activity_operator", "customer_activity_reference_missing", "customer_activity_reference_type", "end_scope_invalid"];

describe("validation messages", () => {
  it("every code has a text in Spanish, English and Korean, and none of them blames F06 / versioned execution", () => {
    for (const [name, msgs] of [["en", en], ["es", es], ["ko", ko]] as const) for (const code of CODES) {
      const text = (msgs as unknown as Msgs).Flows.validation.issues[code]; expect(text, `${name}:${code}`).toBeTruthy(); expect(text).not.toMatch(/F06|versioned|versionada|버전/i);
    }
    for (const msgs of [en, es, ko]) for (const code of ["subflow_execution_disabled", "durable_wait_execution_disabled", "customer_reply_condition_disabled"]) expect((msgs as unknown as Msgs).Flows.editorState.activationRefused[code]).toBeTruthy();
  });
  it("a coded issue is shown translated, with its parameters; an uncoded one keeps its English message", () => {
    current = es as unknown as Msgs;
    render(<><IssueLine issue={{ severity: "error", scope: "node", field: "x", code: "execute_flow_too_deep", params: { max: 3 }, message: "English fallback" }} /><IssueLine issue={{ severity: "warning", scope: "flow", message: "Plain English" }} /></>);
    expect(screen.getByText(/máximo 3 llamadas/)).toBeTruthy(); expect(screen.queryByText("English fallback")).toBeNull(); expect(screen.getByText("Plain English")).toBeTruthy();
    current = ko as unknown as Msgs; cleanup(); render(<IssueLine issue={{ severity: "error", scope: "node", code: "execute_flow_target_missing", message: "x" }} />);
    expect(screen.getByText("실행할 플로우를 선택하세요.")).toBeTruthy(); current = en as unknown as Msgs;
  });
});
