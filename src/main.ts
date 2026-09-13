import './style.css';
import { Game } from './game/Game';
import { StartMenu } from './game/ui/StartMenu';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app missing');

const game = new Game(app);
const menu = new StartMenu(app, async (sel) => {
  menu.hide();
  await game.start(sel);
});
