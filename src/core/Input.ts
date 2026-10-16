/**
 * Keyboard + mouse. Uses KeyboardEvent.code (physical keys) so WASD and AZERTY ZQSD both work.
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  /** Normalised device coords (-1..1). */
  ndcX = 0;
  ndcY = 0;
  mouseLeft = false;
  mouseRight = false;
  private rightPressed = false;
  private leftPressed = false;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseLeft = this.mouseRight = false;
    });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      const r = this.el.getBoundingClientRect();
      this.ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.ndcY = -((e.clientY - r.top) / r.height) * 2 + 1;
    });
    this.el.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouseLeft = true;
        this.leftPressed = true;
      }
      if (e.button === 2) {
        this.mouseRight = true;
        this.rightPressed = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(code: string) {
    return this.down.has(code);
  }
  wasPressed(code: string) {
    return this.pressed.has(code);
  }
  wasRightPressed() {
    return this.rightPressed;
  }
  wasLeftPressed() {
    return this.leftPressed;
  }

  /** Movement vector in screen space: x right, y up (forward). */
  moveAxis(): { x: number; y: number } {
    let x = 0,
      y = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) y += 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) y -= 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    const l = Math.hypot(x, y);
    return l > 0 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
  }

  dashPressed() {
    return this.wasPressed('Space') || this.wasPressed('ShiftLeft') || this.wasPressed('ShiftRight') || this.rightPressed;
  }
  overdrivePressed() {
    return this.wasPressed('KeyE') || this.wasPressed('KeyF');
  }
  pausePressed() {
    return this.wasPressed('Escape') || this.wasPressed('KeyP');
  }

  /** Call at end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.rightPressed = false;
    this.leftPressed = false;
  }
}
