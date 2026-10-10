import '@fontsource/fredoka/latin-600.css';
import '@fontsource/fredoka/latin-700.css';
import '@fontsource/nunito-sans/latin-400.css';
import '@fontsource/nunito-sans/latin-700.css';
import '@fontsource/nunito-sans/latin-800.css';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
let dispose: (() => void) | undefined;
let routeId = 0;
async function route() {
  const id = ++routeId;
  dispose?.(); dispose = undefined;
  app.className = '';
  app.inert = false;
  document.body.classList.remove('controller-mode', 'host-mode', 'joy-active');
  const hash = location.hash.slice(1);
  const smallTouch = matchMedia('(pointer: coarse)').matches && innerWidth < 900;
  const controller = hash.startsWith('join') || (hash === '' && smallTouch);
  app.innerHTML = '<div class="boot"><span class="boot-bounce"></span><p>Inflating the good times...</p></div>';
  try {
    if (controller) {
      const { mountController } = await import('./ui/controller');
      if (id !== routeId) return;
      dispose = mountController(app, hash.split('/')[1] ?? '');
    } else {
      const { mountHost } = await import('./ui/host');
      if (id !== routeId) return;
      dispose = mountHost(app, hash === 'practice');
    }
  } catch (error) {
    app.inert = false;
    console.error('Bounce Riot could not start', error);
    app.innerHTML = '<main class="fatal"><h1>That bounce did not land.</h1><p>This browser could not start the game. Try a current Chrome-based TV browser or connect a laptop to your TV.</p><button class="button primary" id="reload">Try again</button><a class="button text" href="#join">Use this device as a controller</a></main>';
    app.querySelector('#reload')?.addEventListener('click', () => location.reload());
  }
}
window.addEventListener('hashchange', () => void route());
void route();
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => { /* Online play does not require offline caching. */ });
  });
}
