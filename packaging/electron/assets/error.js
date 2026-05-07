const params = new URLSearchParams(location.search);
document.getElementById('title').textContent = params.get('title') || 'Vision failed to start';
document.getElementById('msg').textContent = params.get('msg') || 'Please retry.';
const retryBtn = document.getElementById('retry');
const logsBtn = document.getElementById('logs');
retryBtn.textContent = params.get('retry') || 'Retry';
logsBtn.textContent = params.get('logs') || 'Open logs folder';
retryBtn.addEventListener('click', () => {
  if (window.electronRecovery) window.electronRecovery.retry();
});
logsBtn.addEventListener('click', () => {
  if (window.electronRecovery) window.electronRecovery.openLogs();
});
