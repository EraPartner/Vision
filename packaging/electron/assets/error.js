const params = new URLSearchParams(location.search);
const hslComponents =
  /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;
for (const [param, property] of [
  ["paletteBase", "--theme-base"],
  ["paletteGlow", "--theme-glow"],
  ["paletteForeground", "--theme-foreground"],
]) {
  const value = params.get(param);
  if (value && value.length <= 32 && hslComponents.test(value)) {
    document.documentElement.style.setProperty(property, value);
  }
}
document.getElementById("title").textContent =
  params.get("title") || "Vision failed to start";
document.getElementById("msg").textContent =
  params.get("msg") || "Please retry.";
const retryBtn = document.getElementById("retry");
const logsBtn = document.getElementById("logs");
retryBtn.textContent = params.get("retry") || "Retry";
logsBtn.textContent = params.get("logs") || "Open logs folder";
retryBtn.addEventListener("click", () => {
  if (window.electronRecovery) window.electronRecovery.retry();
});
logsBtn.addEventListener("click", () => {
  if (window.electronRecovery) window.electronRecovery.openLogs();
});
