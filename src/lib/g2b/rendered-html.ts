/**
 * 현재 폼 값을 복제본의 HTML 속성에 반영해 직렬화 후에도 선택 상태를 보존합니다.
 * 브라우저 evaluateAll에 직접 전달하므로 외부 변수나 모듈에 의존하지 않습니다.
 * @param nodes 스냅샷을 만들 DOM 루트
 * @param dialogsOnly 표시 중이며 내용이 있는 모달만 수집할지 여부
 * @returns 같은 시점의 식별 정보와 원본 DOM을 변경하지 않은 HTML 스냅샷
 */
export function captureRenderedElements(nodes: Element[], dialogsOnly = false): {
  id: string; title: string | null; text: string; html: string;
}[] {
  return nodes.flatMap(root => {
    const element = root as HTMLElement;
    if (dialogsOnly) {
      const style = window.getComputedStyle(element);
      // 탐색 중 남아 있는 숨김 모달은 깊은 복제 전에 제외합니다.
      if (!element.getClientRects().length || style.visibility === "hidden" || style.display === "none") return [];
      if (!(element.innerText || "").trim() && !element.querySelector("td[data-title],td[col_id]")) return [];
    }
    const clone = root.cloneNode(true) as Element;
    const originals = [root, ...root.querySelectorAll("input,textarea,select")];
    const copies = [clone, ...clone.querySelectorAll("input,textarea,select")];
    originals.forEach((control, index) => {
      const target = copies[index];
      if (control instanceof HTMLInputElement) target.setAttribute("value", control.value);
      if (control instanceof HTMLTextAreaElement) target.textContent = control.value;
      if (control instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
        // selected 프로퍼티는 outerHTML에 남지 않으므로 속성으로 명시합니다.
        Array.from(target.options).forEach((option, optionIndex) => {
          option.toggleAttribute("selected", control.options[optionIndex].selected);
        });
        // 선택 없음은 HTML에서 첫 항목으로 바뀌므로 명시적으로 기록합니다.
        target.toggleAttribute("data-g2b-no-selection", control.selectedIndex < 0);
      }
    });
    return [{ id: element.id, html: clone.outerHTML,
      title: dialogsOnly ? element.querySelector("[id$='_header_title'],.w2window_header_title,h1,h2,h3")?.textContent?.trim() || null : null,
      text: dialogsOnly ? (element.innerText || "").trim() : "" }];
  });
}
