// The only writer of document.title: the feed's star (a search match arrived)
// and the watchlist's counter both live here, so neither erases the other.
// Both clear when the visitor comes back to the tab.
import { titleText } from './feed-shared.js';

const base = document.title;
let star = false;
let count = 0;

export function away() {
  return document.hidden || !document.hasFocus();
}

function render() {
  document.title = titleText(base, count, star);
}

export function markStar() {
  if (!away()) return;
  star = true;
  render();
}

export function addCount(n) {
  if (!away() || n <= 0) return;
  count += n;
  render();
}

function reset() {
  if (away() || (!star && !count)) return;
  star = false;
  count = 0;
  render();
}

window.addEventListener('focus', reset);
document.addEventListener('visibilitychange', reset);
