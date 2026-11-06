import './style.css';
import { Raycaster, Vector3 } from 'three';
import { Game } from './game/Game';
import { StartMenu, type StartSelection } from './game/ui/StartMenu';
import { PauseMenu } from './game/ui/PauseMenu';
import { OptionsMenu } from './game/ui/OptionsMenu';
import { Tutorial } from './game/ui/Tutorial';
import { TunePanel } from './game/ui/TunePanel';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('#app missing');

const game = new Game(app);
const menu = new StartMenu(app, async (sel) => {
  menu.hide();
  await game.start(sel);
});
const pause = new PauseMenu(app);
const options = new OptionsMenu(app);
const tutorial = new Tutorial(app);
const tune = new TunePanel(app);

menu.onTune = (id) => tune.open(id);
menu.onOptions = () => options.show();
menu.onTutorial = () => tutorial.maybeStart(true);
tune.onClose = () => {};

pause.onResume = () => {
  pause.hide();
  game.setPaused(false);
};
pause.onOptions = () => {
  options.show();
};
pause.onMainMenu = () => {
  pause.hide();
  game.returnToMenu();
  menu.show();
};
options.onClose = () => {
  /* stay paused or on menu */
};
options.onBindingsChanged = () => {
  game.reloadInputBindings();
};
tutorial.onDone = () => {
  /* return to menu */
};

game.onPauseRequest = () => {
  if (!menu.isHidden()) return;
  if (options.isVisible()) {
    options.hide();
    return;
  }
  if (pause.isVisible()) {
    pause.hide();
    game.setPaused(false);
  } else {
    game.setPaused(true);
    pause.show();
  }
};

// First-run tutorial after a short beat so the menu paints first
requestAnimationFrame(() => tutorial.maybeStart(false));

window.addEventListener(
  'keydown',
  (e) => {
    if (options.isVisible() && options.handleRebindKey(e.code)) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// QA hook
if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')) {
  (window as unknown as { __nig: unknown }).__nig = {
    game,
    menu,
    pause,
    options,
    tutorial,
    tune,
    THREE: { Raycaster, Vector3 },
    start: async (sel: StartSelection) => {
      menu.hide();
      await game.start(sel);
    },
    returnToMenu: () => {
      pause.hide();
      options.hide();
      game.returnToMenu();
      menu.show();
    },
  };
}
