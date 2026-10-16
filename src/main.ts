import './style.css';
import { Game } from './game/Game';

const game = new Game(document.getElementById('app')!);
// handy for debugging in the console
(window as any).game = game;
