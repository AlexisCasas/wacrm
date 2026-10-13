// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { FlowPicker, type PickableFlow } from "./flow-picker";

const FLOWS: PickableFlow[] = [
  { id: "id-bienvenida", name: "Bienvenida clientes", status: "draft" },
  { id: "id-cotizacion", name: "Cotización Ñandú", status: "active" },
  { id: "id-lead", name: "QA - Lead capture", status: "draft" },
  { id: "id-seguimiento", name: "Seguimiento Post-Venta", status: "archived" },
];
const statusLabel = (s: string) => s;

function Harness({ initial = "", options = FLOWS, onChange = () => {}, disabled = false }: { initial?: string; options?: PickableFlow[]; onChange?: (id: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <FlowPicker
      options={options} value={value} disabled={disabled}
      onChange={(id) => { setValue(id); onChange(id); }}
      ariaLabel="Flow to run" placeholder="Pick a flow" unavailableLabel="Selected flow is not available"
      searchPlaceholder="Search flows by name…" emptyLabel="No flows match your search."
      cappedLabel={(shown, total) => `Showing ${shown} of ${total}`} statusLabel={statusLabel}
    />
  );
}
const trigger = () => screen.getByRole("combobox", { name: "Flow to run" }) as HTMLElement;
const optionNames = () => screen.queryAllByRole("option").map((o) => o.textContent ?? "");
async function open() { fireEvent.click(trigger()); return screen.findByPlaceholderText("Search flows by name…"); }

afterEach(cleanup);

describe("FlowPicker", () => {
  it("shows the placeholder when nothing is selected and a search box once opened (B01)", async () => {
    render(<Harness />);
    expect(trigger().textContent).toContain("Pick a flow");
    const search = await open();
    expect(search).toBeTruthy();
    await waitFor(() => expect(optionNames()).toHaveLength(4));
  });

  it("filters while typing: partial, case-insensitive and accent-insensitive (B02)", async () => {
    render(<Harness />);
    const search = await open();
    fireEvent.change(search, { target: { value: "BIENV" } });
    await waitFor(() => expect(optionNames()).toEqual([expect.stringContaining("Bienvenida clientes")]));
    fireEvent.change(search, { target: { value: "cotizacion" } });
    await waitFor(() => expect(optionNames()).toEqual([expect.stringContaining("Cotización Ñandú")]));
    fireEvent.change(search, { target: { value: "nandu" } });
    await waitFor(() => expect(optionNames()).toHaveLength(1));
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(optionNames()).toHaveLength(4));
  });

  it("choosing a result reports the correct id and shows the choice in the field (B03)", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const search = await open();
    fireEvent.change(search, { target: { value: "lead" } });
    const option = await screen.findByRole("option", { name: /QA - Lead capture/ });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("id-lead");
    await waitFor(() => expect(trigger().textContent).toContain("QA - Lead capture"));
  });

  it("keeps showing the stored selection when the node is edited again, and marks it in the list (B04)", async () => {
    render(<Harness initial="id-cotizacion" />);
    expect(trigger().textContent).toContain("Cotización Ñandú");
    expect(trigger().textContent).toContain("active");
    await open();
    await waitFor(() => expect(optionNames()).toHaveLength(4));
    const selectedOption = screen.getAllByRole("option").find((o) => o.textContent?.includes("Cotización"))!;
    expect(selectedOption.getAttribute("aria-selected")).toBe("true");
  });

  it("changing the selection works and reports the new id (B05)", async () => {
    const onChange = vi.fn();
    render(<Harness initial="id-cotizacion" onChange={onChange} />);
    await open();
    fireEvent.click(await screen.findByRole("option", { name: /Seguimiento Post-Venta/ }));
    expect(onChange).toHaveBeenLastCalledWith("id-seguimiento");
    await waitFor(() => expect(trigger().textContent).toContain("Seguimiento Post-Venta"));
  });

  it("shows an empty state when nothing matches (B06) and recovers when the search is cleared", async () => {
    render(<Harness />);
    const search = await open();
    fireEvent.change(search, { target: { value: "no existe ese flujo" } });
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("No flows match your search.");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(optionNames()).toHaveLength(4));
  });

  it("works from the keyboard: type, ArrowDown to move, Enter to choose, Escape to close", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const search = await open();
    fireEvent.change(search, { target: { value: "e" } });
    await waitFor(() => expect(optionNames().length).toBeGreaterThan(1));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(FLOWS.map((f) => f.id)).toContain(onChange.mock.calls[0][0]);
    // reopen and close with Escape without choosing
    onChange.mockClear();
    const again = await open();
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search flows by name…")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a stored target that is not in the catalog (deleted / another company) is shown as unavailable and offers nothing foreign", async () => {
    render(<Harness initial="id-de-otra-empresa" />);
    expect(trigger().textContent).toContain("Selected flow is not available");
    await open();
    await waitFor(() => expect(optionNames()).toHaveLength(4));
    expect(optionNames().join("|")).not.toContain("otra");
  });

  it("closing the popup resets the search so the next opening shows everything", async () => {
    render(<Harness />);
    const search = await open();
    fireEvent.change(search, { target: { value: "lead" } });
    await waitFor(() => expect(optionNames()).toHaveLength(1));
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search flows by name…")).toBeNull());
    const reopened = await open();
    expect((reopened as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(optionNames()).toHaveLength(4));
  });

  it("caps what it renders on a large catalog, says so, and still finds a flow beyond the cap by typing (B-perf)", async () => {
    const many: PickableFlow[] = Array.from({ length: 800 }, (_, i) => ({ id: `f${i}`, name: `Automatización ${i}`, status: "draft" }));
    const onChange = vi.fn();
    render(<Harness options={many} onChange={onChange} />);
    const search = await open();
    await waitFor(() => expect(optionNames().length).toBe(100));
    expect(screen.getByText("Showing 100 of 800")).toBeTruthy();
    fireEvent.change(search, { target: { value: "automatizacion 799" } });
    const hit = await screen.findByRole("option", { name: /Automatización 799/ });
    fireEvent.click(hit);
    expect(onChange).toHaveBeenCalledWith("f799");
  });

  it("is inert when disabled (account without the pilot flag)", () => {
    render(<Harness disabled />);
    fireEvent.click(trigger());
    expect(screen.queryByPlaceholderText("Search flows by name…")).toBeNull();
  });
});
