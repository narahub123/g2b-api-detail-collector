// Windows에서도 실제 Next 종료 처리기에 신호를 전달하여 정리 대기를 검증합니다.
process.on("message", message => {
  if (message === "shutdown") process.emit("SIGTERM", "SIGTERM");
});
