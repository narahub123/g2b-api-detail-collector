/** 공고번호와 차수에 해당하는 나라장터 입찰공고 원문 주소를 만듭니다. */
export function serviceDetailUrl(number: string, order: string): string {
  const url = new URL("https://www.g2b.go.kr/link/PNPE027_01/single/");
  url.searchParams.set("bidPbancNo", number);
  url.searchParams.set("bidPbancOrd", order);
  return url.toString();
}
