/** 용역 조회 — 응답 명세 (사용자가 정리한 나라장터 API 명세) 기준. */
export const API_FIELD_LABELS: Record<string, string> = {
  resultCode: "결과코드", resultMsg: "결과메세지", numOfRows: "한 페이지 결과 수", pageNo: "페이지 번호", totalCount: "전체 결과 수",
  bidNtceNo: "입찰공고번호", bidNtceOrd: "입찰공고차수", reNtceYn: "재공고여부", rgstTyNm: "등록유형명", ntceKindNm: "공고종류명",
  intrbidYn: "국제입찰여부", bidNtceDt: "입찰공고일시", refNo: "참조번호", bidNtceNm: "입찰공고명",
  ntceInsttCd: "공고기관코드", ntceInsttNm: "공고기관명", dminsttCd: "수요기관코드", dminsttNm: "수요기관명",
  bidMethdNm: "입찰방식명", cntrctCnclsMthdNm: "계약체결방법명", ntceInsttOfclNm: "공고기관담당자명",
  ntceInsttOfclTelNo: "공고기관담당자전화번호", ntceInsttOfclEmailAdrs: "공고기관담당자이메일주소", exctvNm: "집행관명",
  bidQlfctRgstDt: "입찰참가자격등록마감일시", cmmnSpldmdAgrmntRcptdocMethd: "공동수급협정서접수방식",
  cmmnSpldmdAgrmntClseDt: "공동수급협정마감일시", cmmnSpldmdCorpRgnLmtYn: "공동수급업체지역제한여부",
  bidBeginDt: "입찰개시일시", bidClseDt: "입찰마감일시", opengDt: "개찰일시",
  ntceSpecDocUrl1: "공고규격서URL1", ntceSpecDocUrl2: "공고규격서URL2", ntceSpecDocUrl3: "공고규격서URL3",
  ntceSpecDocUrl4: "공고규격서URL4", ntceSpecDocUrl5: "공고규격서URL5", ntceSpecDocUrl6: "공고규격서URL6",
  ntceSpecDocUrl7: "공고규격서URL7", ntceSpecDocUrl8: "공고규격서URL8", ntceSpecDocUrl9: "공고규격서URL9", ntceSpecDocUrl10: "공고규격서URL10",
  ntceSpecFileNm1: "공고규격파일명1", ntceSpecFileNm2: "공고규격파일명2", ntceSpecFileNm3: "공고규격파일명3",
  ntceSpecFileNm4: "공고규격파일명4", ntceSpecFileNm5: "공고규격파일명5", ntceSpecFileNm6: "공고규격파일명6",
  ntceSpecFileNm7: "공고규격파일명7", ntceSpecFileNm8: "공고규격파일명8", ntceSpecFileNm9: "공고규격파일명9", ntceSpecFileNm10: "공고규격파일명10",
  rbidPermsnYn: "재입찰허용여부", pqApplDocRcptMthdNm: "PQ신청서접수방법명", pqApplDocRcptDt: "PQ신청서접수일시",
  tpEvalApplMthdNm: "TP심사신청방법명", tpEvalApplClseDt: "TP심사신청마감일시",
  jntcontrctDutyRgnNm1: "공동도급의무지역명1", jntcontrctDutyRgnNm2: "공동도급의무지역명2", jntcontrctDutyRgnNm3: "공동도급의무지역명3",
  rgnDutyJntcontrctRt: "지역의무공동도급비율", dtlsBidYn: "내역입찰여부", bidPrtcptLmtYn: "입찰참가제한여부",
  prearngPrceDcsnMthdNm: "예정가격결정방법명", totPrdprcNum: "총예가건수", drwtPrdprcNum: "추첨예가건수",
  asignBdgtAmt: "배정예산금액", presmptPrce: "추정가격", opengPlce: "개찰장소", dcmtgOprtnDt: "설명회실시일시",
  dcmtgOprtnPlce: "설명회실시장소", bidNtceDtlUrl: "입찰공고상세URL", bidNtceUrl: "입찰공고URL",
  bidPrtcptFeePaymntYn: "입찰참가수수료납부여부", bidPrtcptFee: "입찰참가수수료", bidGrntymnyPaymntYn: "입찰보증금납부여부",
  crdtrNm: "채권자명", ppswGnrlSrvceYn: "조달청일반용역여부", srvceDivNm: "용역구분명", prdctClsfcLmtYn: "물품분류제한여부",
  mnfctYn: "제조여부", purchsObjPrdctList: "구매대상물품목록", untyNtceNo: "통합공고번호",
  cmmnSpldmdMethdCd: "공동수급방식코드", cmmnSpldmdMethdNm: "공동수급구성방식명", stdNtceDocUrl: "표준공고서URL",
  brffcBidprcPermsnYn: "지사투찰허용여부", dsgntCmptYn: "지명경쟁여부", arsltCmptYn: "실적경쟁여부",
  pqEvalYn: "PQ심사여부", tpEvalYn: "TP심사여부", ntceDscrptYn: "공고설명여부",
  rsrvtnPrceReMkngMthdNm: "예비가격재작성방법명", arsltApplDocRcptMthdNm: "실적신청서접수방법명",
  arsltReqstdocRcptDt: "실적신청서접수일시", orderPlanUntyNo: "발주계획통합번호", sucsfbidLwltRate: "낙찰하한율",
  rgstDt: "등록일시", bfSpecRgstNo: "사전규격등록번호", infoBizYn: "정보화사업여부",
  sucsfbidMthdCd: "낙찰방법코드", sucsfbidMthdNm: "낙찰방법명", chgDt: "변경일시",
  dminsttOfclEmailAdrs: "수요기관담당자이메일주소", indstrytyLmtYn: "업종제한여부", chgNtceRsn: "변경공고사유",
  rbidOpengDt: "재입찰개찰일시", VAT: "부가가치세", indutyVAT: "주공종부가가치세",
  rgnLmtBidLocplcJdgmBssCd: "지역제한입찰소재지판단기준코드", rgnLmtBidLocplcJdgmBssNm: "지역제한입찰소재지판단기준명",
  pubPrcrmntLrgclsfcNm: "공공조달대분류명", pubPrcrmntMidclsfcNm: "공공조달중분류명",
  pubPrcrmntClsfcNo: "공공조달분류번호", pubPrcrmntClsfcNm: "공공조달분류명",
  techAbltEvlRt: "기술능력평가비율", bidPrceEvlRt: "입찰가격평가비율", sucsfbidMthdAppStd: "낙찰방법적용기준",
  befBidBbancNo: "이전입찰공고번호"
};

/** 명세에 없는 API 키는 오역하지 않고 영문 키를 그대로 표시한다. */
export function apiFieldDisplayName(key: string): string {
  const label = API_FIELD_LABELS[key];
  return label ? `${label}(${key})` : key;
}
