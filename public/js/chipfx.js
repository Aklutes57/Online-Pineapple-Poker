// Chips you can watch move.
//
// Money changing hands used to be an instant: bet chips vanished, a stack
// number jumped, and the pot line reset — all in the same frame. This flies a
// token between two points on the felt so the table can see where the chips
// actually went, which is most of what makes a pot feel won.
//
// It is decoration and nothing more. Every number it describes is already on
// screen in the stacks, the pot line and the log, so a dropped or skipped
// flight costs the table nothing — which is why anyone who has asked not to be
// moved gets none of it, and why nothing here is ever awaited.

const LAYER_ID = 'fx-layer';
const FLIGHT_MS = 520;
const LINGER_MS = 140;

function layer() {
  return document.getElementById(LAYER_ID);
}

export function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

// Where a DOM element sits, as percentages of the fx layer — the same
// coordinate space the seat chip positions are already expressed in.
export function pointOfElement(el) {
  const host = layer();
  if (!el || !host) return null;
  const box = host.getBoundingClientRect();
  const target = el.getBoundingClientRect();
  if (!box.width || !box.height || !target.width) return null;
  return {
    left: ((target.left + target.width / 2 - box.left) / box.width) * 100,
    top: ((target.top + target.height / 2 - box.top) / box.height) * 100,
  };
}

// Fly one chip from `from` to `to`, both { left, top } in layer percentages.
// Returns immediately; the element removes itself when it lands.
export function flyChip(from, to, { label = '', kind = '', delay = 0 } = {}) {
  const host = layer();
  if (!host || !from || !to || reducedMotion()) return;

  const chip = document.createElement('div');
  chip.className = 'fx-chip' + (kind ? ` ${kind}` : '');
  chip.style.left = `${from.left}%`;
  chip.style.top = `${from.top}%`;
  if (label !== '') chip.textContent = String(label);
  host.appendChild(chip);

  const launch = () => {
    // Two frames, not one: the first commits the starting position to style,
    // the second changes it. Setting both in the same frame is a jump, because
    // the browser never saw the chip anywhere else.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chip.style.left = `${to.left}%`;
        chip.style.top = `${to.top}%`;
      });
    });
    setTimeout(() => chip.classList.add('landing'), FLIGHT_MS);
    // Belt and braces: transitionend can go missing if the element is hidden
    // or the tab is backgrounded mid-flight, and a chip that never cleans
    // itself up would sit on the felt for the rest of the night.
    setTimeout(() => chip.remove(), FLIGHT_MS + LINGER_MS + 120);
  };

  if (delay > 0) setTimeout(launch, delay);
  else launch();
}

// Clear anything still in the air. Used when the table is re-laid out or a new
// hand starts, so a flight from the last hand cannot land on the new one.
export function clearChipFlights() {
  const host = layer();
  if (host) host.innerHTML = '';
}
