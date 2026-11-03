// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SectionTextBlocks } from "./SectionTextBlocks";

afterEach(cleanup);

it("문단 순서·반복·줄바꿈을 유지하고 공백 본문은 표시하지 않습니다", () => {
  const { container } = render(<SectionTextBlocks blocks={[
    { text: "첫째\n둘째", visible: true }, { text: "반복", visible: true },
    { text: "반복", visible: true }, { text: "  ", visible: true },
  ]} />);
  expect([...container.querySelectorAll("p")].map(element => element.textContent)).toEqual(["첫째\n둘째", "반복", "반복"]);
});

it("사용자 화면에서는 숨긴 본문과 숨긴 섹션의 본문을 표시하지 않습니다", () => {
  const blocks = [{ text: "공개 안내", visible: true }, { text: "숨긴 안내", visible: false }];
  const { rerender, container } = render(<SectionTextBlocks blocks={blocks} />);
  expect(screen.getByText("공개 안내")).toBeInTheDocument();
  expect(screen.queryByText("숨긴 안내")).not.toBeInTheDocument();
  rerender(<SectionTextBlocks blocks={blocks} sectionVisible={false} />);
  expect(container).toBeEmptyDOMElement();
});

it("관리자 화면에서는 숨김 여부를 본문별로 표시하고 상위 숨김 상태도 반영합니다", () => {
  const blocks = [{ text: "공개 안내", visible: true }, { text: "숨긴 안내", visible: false }];
  const { rerender } = render(<SectionTextBlocks blocks={blocks} includeHidden />);
  expect(within(screen.getByText("숨긴 안내").parentElement!).getByText("숨김")).toBeInTheDocument();
  expect(screen.getAllByText("숨김")).toHaveLength(1);
  rerender(<SectionTextBlocks blocks={blocks} includeHidden sectionVisible={false} />);
  expect(screen.getAllByText("숨김")).toHaveLength(2);
});

it("HTML 형태의 원문도 태그나 링크로 해석하지 않고 텍스트로 표시합니다", () => {
  const text = '<img src=x onerror="alert(1)"><script>run()</script>https://example.com';
  const { container } = render(<SectionTextBlocks blocks={[{ text, visible: true }]} />);
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(container.querySelector("img,script,a")).toBeNull();
});

it("본문 속성이 없는 과거 자료는 빈 본문 요소를 만들지 않습니다", () => {
  const { container } = render(<SectionTextBlocks />);
  expect(container).toBeEmptyDOMElement();
});
