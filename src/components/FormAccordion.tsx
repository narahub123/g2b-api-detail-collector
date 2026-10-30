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
  size?: 'default' | 'compact';
  onOpenChange?: (open: boolean) => void;
};

/** 공고 상세와 관리자 화면에서 크기를 선택해 사용하는 공통 아코디언입니다. */
export function FormAccordion({ title, description, defaultOpen = false, children, className = "", size = 'default', onOpenChange }: Props) {
  return (
    <details className={`user-section form-accordion ${size === 'compact' ? 'form-accordion-compact ' : ''}${className}`.trim()} open={defaultOpen}
      onToggle={event => onOpenChange?.(event.currentTarget.open)}>
      <summary>
        <span>{title}</span>
        <ChevronRight className="form-accordion-chevron" size={size === 'compact' ? 16 : 20} aria-hidden="true" />
      </summary>
      <div className="user-section-content form-accordion-body">
        {description && <p className="form-accordion-description">{description}</p>}
        {children}
      </div>
    </details>
  );
}
