// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { JsonTree } from "./JsonTree";

it("shows types and exact primitive values, including null and empty values", () => {
  render(<JsonTree value={{ name: "", count: 0, enabled: false, missing: null, items: [] }} />);
  expect(screen.getByText('""')).toBeInTheDocument();
  expect(screen.getByText("0")).toBeInTheDocument();
  expect(screen.getByText("false")).toBeInTheDocument();
  expect(screen.getAllByText("null")).toHaveLength(2);
  expect(screen.getByText("array (0)")).toBeInTheDocument();
});

it("expands and collapses nested modal capture properties", () => {
  render(<JsonTree value={{ detail: { modalCaptures: [{ trigger: { label: "조회" }, modal: { title: "팝업", fields: [{ label: "금액", value: "1" }], tables: [{ columns: ["금액"], rows: [["1"]] }] }, settling: { status: "settled" } }] } }} />);
  fireEvent.click(screen.getByRole("button", { name: /detail/ }));
  fireEvent.click(screen.getByRole("button", { name: /modalCaptures/ }));
  fireEvent.click(screen.getByRole("button", { name: /\[0\]/ }));
  for (const name of ["trigger", "modal", "settling"]) expect(screen.getByRole("button", { name: new RegExp(`^${name} `) })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^modal / }));
  for (const name of ["fields", "tables"]) expect(screen.getByRole("button", { name: new RegExp(`^${name} `) })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /trigger/ }));
  expect(screen.getByText('"조회"')).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /trigger/ }));
  expect(screen.queryByText('"조회"')).not.toBeInTheDocument();
});
