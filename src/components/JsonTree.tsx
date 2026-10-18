"use client";

import { useState } from "react";

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array (${value.length})`;
  if (typeof value === "object") return `object (${Object.keys(value).length})`;
  return typeof value;
}

function Node({ name, value, initiallyOpen = false }: { name: string; value: unknown; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const expandable = value !== null && typeof value === "object";
  const entries = expandable ? Array.isArray(value)
    ? value.map((item, index) => [`[${index}]`, item] as const)
    : Object.entries(value as Record<string, unknown>) : [];
  return <li className="json-node">
    <div className="json-line">
      {expandable ? <button type="button" className="json-toggle" aria-expanded={open} onClick={() => setOpen(!open)}
        aria-label={`${name} ${kind(value)} ${open ? "접기" : "펼치기"}`}>{open ? "▾" : "▸"}</button>
        : <span className="json-spacer" aria-hidden="true" />}
      <span className="json-key">{name}</span><span className="json-type">{kind(value)}</span>
      {!expandable && <span className="json-value">{JSON.stringify(value)}</span>}
    </div>
    {expandable && open && entries.length > 0 && <ul className="json-children">
      {entries.map(([key, child]) => <Node key={key} name={key} value={child} />)}
    </ul>}
  </li>;
}

export function JsonTree({ value }: { value: unknown }) {
  return <ul className="json-tree" aria-label="원본 JSON 데이터"><Node name="$" value={value} initiallyOpen /></ul>;
}
