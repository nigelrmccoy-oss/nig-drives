import './style.css';
import { Game } from './game/Game';
import { StartMenu, type StartSelection } from './game/ui/StartMenu';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app missing');

const game = new Game(app);
const menu = new StartMenu(app, async (sel) => {
  menu.hide();
  await game.start(sel);
});

// QA hook for headless play-tests: only in `npm run dev` or with ?debug=1.
if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')) {
  (window as unknown as { __nig: unknown }).__nig = {
    game,
    start: async (sel: StartSelection) => {
      menu.hide();
      await game.start(sel);
    },
  };
}
