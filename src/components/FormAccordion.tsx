"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import "../app/form-accordion.css";

type Props = {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
};

/** 공고 상세와 관리자 화면에서 공통으로 사용하는 아코디언. */
export function FormAccordion({ title, description, defaultOpen = false, children, className = "" }: Props) {
  return (
    <details className={`user-section form-accordion ${className}`.trim()} open={defaultOpen}>
      <summary>
        <span>{title}</span>
        <ChevronRight className="form-accordion-chevron" size={20} aria-hidden="true" />
      </summary>
      <div className="user-section-content form-accordion-body">
        {description && <p className="form-accordion-description">{description}</p>}
        {children}
      </div>
    </details>
  );
}
