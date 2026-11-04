"use client";

import type { ReactNode } from "react";
import "../../app/compact-accordion.css";

type CompactAccordionProps = {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
};

/** 표 셀 안에서도 한 줄로 표시되는 작은 기본 HTML 아코디언. */
export function CompactAccordion({
  title,
  children,
  defaultOpen = false,
  className = "",
}: CompactAccordionProps) {
  return (
    <details
      className={`compact-accordion${className ? ` ${className}` : ""}`}
      open={defaultOpen || undefined}
    >
      <summary>{title}</summary>
      <div className="compact-accordion-content">{children}</div>
    </details>
  );
}
