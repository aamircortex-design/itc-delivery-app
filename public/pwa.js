let installPrompt;

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  document.querySelectorAll('[data-install-app]').forEach(button => {
    button.hidden = false;
  });
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.querySelectorAll('[data-install-app]').forEach(button => {
    button.hidden = true;
  });
});

document.querySelectorAll('[data-install-app]').forEach(button => {
  button.addEventListener('click', async () => {
    if (!installPrompt) return;
    button.disabled = true;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        button.hidden = true;
      }
      installPrompt = null;
    } catch (error) {
      console.error('Could not start app installation:', error);
    } finally {
      button.disabled = false;
    }
  });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .catch(error => console.error('Could not register the app service worker:', error));
  });
}
