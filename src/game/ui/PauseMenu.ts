/** In-drive pause overlay: resume, options, return to main menu. */
export class PauseMenu {
  private root: HTMLElement;
  private visible = false;
  onResume: (() => void) | null = null;
  onOptions: (() => void) | null = null;
  onMainMenu: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'pause-menu';
    this.root.className = 'overlay-menu hidden';
    this.root.innerHTML = `
      <div class="menu-card pause-card">
        <h2>Paused</h2>
        <div class="choice-row" style="grid-template-columns:1fr">
          <button type="button" class="choice" data-act="resume"><strong>Resume</strong><span>Esc</span></button>
          <button type="button" class="choice" data-act="options"><strong>Options</strong><span>Graphics · units · audio · binds</span></button>
          <button type="button" class="choice" data-act="menu"><strong>Main menu</strong><span>Driver / car select</span></button>
        </div>
      </div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = (btn as HTMLElement).dataset.act;
        if (a === 'resume') this.onResume?.();
        if (a === 'options') this.onOptions?.();
        if (a === 'menu') this.onMainMenu?.();
      });
    });
  }

  show(): void {
    this.visible = true;
    this.root.classList.remove('hidden');
  }
  hide(): void {
    this.visible = false;
    this.root.classList.add('hidden');
  }
  isVisible(): boolean {
    return this.visible;
  }
}
