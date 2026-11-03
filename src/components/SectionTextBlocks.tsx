import type { StructuredTextBlock } from "@/lib/g2b/detail-page";
import "../app/section-text-blocks.css";

/** 화면에 사용할 본문이 있는지 표시 조건과 같은 기준으로 판단합니다. */
export function hasTextBlocks(blocks?: StructuredTextBlock[], includeHidden = false): boolean {
  return Boolean(blocks?.some(block => block.text.trim() && (includeHidden || block.visible !== false)));
}

/** 저장된 문단을 순서대로 표시하고 관리자에게만 숨긴 본문과 상태를 함께 보여줍니다. */
export function SectionTextBlocks({ blocks, includeHidden = false, sectionVisible = true }: {
  blocks?: StructuredTextBlock[]; includeHidden?: boolean; sectionVisible?: boolean;
}) {
  if (!includeHidden && !sectionVisible) return null;
  const shown = blocks?.filter(block => block.text.trim() && (includeHidden || block.visible !== false));
  if (!shown?.length) return null;
  return <div className="section-text-blocks">{shown.map((block, index) => {
    const hidden = !sectionVisible || block.visible === false;
    return <div className={`section-text-block${hidden ? " section-text-block--hidden" : ""}`} key={index}>
      {includeHidden && hidden && <span className="section-text-hidden-label">숨김</span>}
      <p>{block.text}</p>
    </div>;
  })}</div>;
}
