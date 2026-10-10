// The Agent Receipts cast: small cosmic sprites, one per agent, drawn as SVG.
// A shared <defs> block (gradients, masks) is injected once into the page.

export type Mood = "idle" | "busy" | "happy" | "sad";

export type Character = { name: string; label: string; color: string; light: string; dark: string };

export const CHARACTERS: Character[] = [
  { name: "nova", label: "Nova", color: "#ffc94a", light: "#fff3c4", dark: "#e08a12" }, // rounded star
  { name: "pip", label: "Pip", color: "#3fd3c6", light: "#b9fff4", dark: "#11867f" }, // ringed planet
  { name: "comet", label: "Comet", color: "#ff7b8f", light: "#ffd0d8", dark: "#cc3554" }, // comet with tail
  { name: "luna", label: "Luna", color: "#a58bff", light: "#e3d9ff", dark: "#6646d8" }, // crescent moon
  { name: "puff", label: "Puff", color: "#6fb4ff", light: "#d8ecff", dark: "#2f6fd6" }, // cloud
  { name: "sprout", label: "Sprout", color: "#7fe08f", light: "#dcffd9", dark: "#2f9a49" }, // bean with a leaf
  { name: "byte", label: "Byte", color: "#ff9f5a", light: "#ffd9b8", dark: "#c95e12" }, // rounded cube
];

export const charOf = (i: number) => CHARACTERS[((i % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length];

const INK = "#1b1830";

/** Shared gradients and masks. Insert once per document. */
export function avatarDefs(): string {
  const grads = CHARACTERS.map(
    (c, i) => `
    <radialGradient id="body-${i}" gradientUnits="userSpaceOnUse" cx="24" cy="14" r="48">
      <stop offset="0%" stop-color="${c.light}"/><stop offset="45%" stop-color="${c.color}"/><stop offset="100%" stop-color="${c.dark}"/>
    </radialGradient>
    <radialGradient id="orb-${i}" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".95"/><stop offset="22%" stop-color="${c.light}"/><stop offset="70%" stop-color="${c.color}"/><stop offset="100%" stop-color="${c.dark}"/>
    </radialGradient>
    <linearGradient id="tail-${i}" x1="1" x2="0" y1="0" y2="0">
      <stop offset="0%" stop-color="${c.color}" stop-opacity=".9"/><stop offset="100%" stop-color="${c.light}" stop-opacity="0"/>
    </linearGradient>`,
  ).join("");
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <mask id="crescent" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="56">
      <rect width="64" height="56" fill="#fff"/><circle cx="47" cy="19" r="15" fill="#000"/>
    </mask>
    <radialGradient id="orb-fail" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#fff" stop-opacity=".95"/><stop offset="22%" stop-color="#ffb3c4"/><stop offset="70%" stop-color="#ff5b7f"/><stop offset="100%" stop-color="#b3123a"/>
    </radialGradient>
    <radialGradient id="orb-glass" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".35"/><stop offset="60%" stop-color="#1a1d33" stop-opacity=".9"/><stop offset="100%" stop-color="#0b0d1a"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" x2="1">
      <stop offset="0%" stop-color="#6fb4ff"/><stop offset="35%" stop-color="#a58bff"/><stop offset="65%" stop-color="#ffc94a"/><stop offset="100%" stop-color="#ff7b8f"/>
    </linearGradient>
    ${grads}
  </defs></svg>`;
}

/** Eyes, brows, mouth and extras for a face centred on (cx, cy). */
function face(mood: Mood, cx: number, cy: number, opts: { gap?: number; ink?: string; led?: boolean } = {}): string {
  const g = opts.gap ?? 6;
  const ink = opts.ink ?? INK;
  const l = cx - g, r = cx + g;
  const cheeks = `<ellipse cx="${l - 4}" cy="${cy + 5}" rx="3" ry="1.7" fill="#ff6f9a" opacity=".4"/><ellipse cx="${r + 4}" cy="${cy + 5}" rx="3" ry="1.7" fill="#ff6f9a" opacity=".4"/>`;
  if (mood === "happy") {
    return `<path d="M${l - 2.6} ${cy + 1} q2.6 -3.6 5.2 0 M${r - 2.6} ${cy + 1} q2.6 -3.6 5.2 0" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <path d="M${cx - 2.6} ${cy + 5} q2.6 2.6 5.2 0" stroke="${ink}" stroke-width="1.8" fill="none" stroke-linecap="round"/>${opts.led ? "" : cheeks}`;
  }
  const eyes = opts.led
    ? `<rect x="${l - 2}" y="${cy - 3}" width="4" height="6" rx="2" fill="${ink}"/><rect x="${r - 2}" y="${cy - 3}" width="4" height="6" rx="2" fill="${ink}"/>`
    : `<ellipse cx="${l}" cy="${cy}" rx="2.3" ry="3.1" fill="${ink}"/><ellipse cx="${r}" cy="${cy}" rx="2.3" ry="3.1" fill="${ink}"/>
       <circle cx="${l + 0.8}" cy="${cy - 1.2}" r=".8" fill="#fff"/><circle cx="${r + 0.8}" cy="${cy - 1.2}" r=".8" fill="#fff"/>`;
  if (mood === "sad") {
    return `<path d="M${l - 3} ${cy - 4} l5 -2 M${r + 3} ${cy - 4} l-5 -2" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>${eyes}
      <path d="M${cx - 2.6} ${cy + 6.5} q2.6 -2.2 5.2 0" stroke="${ink}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <path class="av-drop" d="M${r + 9} ${cy - 9} q2.6 4.4 0 6 q-2.6 -1.6 0 -6z" fill="#9fe3ff" stroke="#e8f8ff" stroke-width=".5"/>`;
  }
  return `<g class="${mood === "busy" ? "av-blink" : ""}">${eyes}</g>${opts.led ? "" : cheeks}`;
}

const gloss = (d: string) => `<path d="${d}" stroke="#fff" stroke-opacity=".45" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;

/** Rounded five-point star path (rounded via a same-colour stroke). */
function starPath(cx: number, cy: number, R: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 10; k++) {
    const rad = k % 2 === 0 ? R : r;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
}

function body(i: number, mood: Mood): string {
  const c = CHARACTERS[i];
  const fill = `url(#body-${i})`;
  switch (c.name) {
    case "nova": {
      const d = starPath(32, 30, 25, 13);
      const sparkle = `<path class="${mood === "busy" ? "av-glow" : ""}" d="M54 8 l1.4 3.6 3.6 1.4 -3.6 1.4 -1.4 3.6 -1.4 -3.6 -3.6 -1.4 3.6 -1.4z" fill="#fff6d0"/>`;
      return `<path d="${d}" fill="${fill}" stroke="${fill}" stroke-width="7" stroke-linejoin="round"/>${gloss("M24 17 L30 8")}${sparkle}${face(mood, 32, 31)}`;
    }
    case "pip":
      return `<path d="M3 34 C8 22 56 14 61 24" stroke="${c.dark}" stroke-width="3.4" fill="none" stroke-linecap="round" opacity=".9"/>
        <circle cx="32" cy="30" r="19" fill="${fill}"/>${gloss("M20 22 C23 16 28 13 33 13")}${face(mood, 32, 31)}
        <path d="M3 34 C12 46 54 38 61 24" stroke="${c.light}" stroke-width="3.4" fill="none" stroke-linecap="round"/>`;
    case "comet":
      return `<path class="${mood === "busy" ? "av-tail" : ""}" d="M38 16 C24 16 12 20 2 24 C12 28 12 34 4 40 C16 40 26 44 38 44 Z" fill="url(#tail-${i})"/>
        <circle cx="39" cy="30" r="16" fill="${fill}"/>${gloss("M29 23 C31 19 35 16 39 16")}${face(mood, 40, 31, { gap: 5.5 })}`;
    case "luna":
      return `<circle cx="29" cy="30" r="23" fill="${fill}" mask="url(#crescent)"/>${gloss("M13 22 C15 16 19 12 24 10")}${face(mood, 21, 34, { gap: 5 })}`;
    case "puff":
      return `<g fill="${fill}"><circle cx="19" cy="34" r="12"/><circle cx="32" cy="25" r="15"/><circle cx="45" cy="33" r="12"/><rect x="12" y="32" width="40" height="15" rx="7.5"/></g>
        ${gloss("M22 20 C25 15 30 12 35 12")}${face(mood, 32, 34)}`;
    case "sprout":
      return `<path d="M32 13 C31 9 32 6 34 4" stroke="${c.dark}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
        <path class="${mood === "busy" ? "av-leaf" : ""}" d="M34 6 C40 0 50 2 51 6 C46 11 39 11 34 6Z" fill="${c.dark}"/>
        <ellipse cx="32" cy="33" rx="17" ry="20" fill="${fill}"/>${gloss("M20 26 C21 20 25 16 30 15")}${face(mood, 32, 34)}`;
    default: {
      const led = mood === "sad" ? "#ff9db3" : "#b8fff3";
      return `<rect x="12" y="11" width="40" height="40" rx="13" fill="${fill}"/>${gloss("M18 22 C18 17 21 15 26 15")}
        <rect x="17" y="21" width="30" height="20" rx="8" fill="#1b1830" opacity=".88"/>${face(mood, 32, 31, { gap: 6, ink: led, led: true })}`;
    }
  }
}

/** A little agent sprite. `size` is the rendered width in px. */
export function avatar(i: number, mood: Mood = "idle", size = 32, title?: string): string {
  const idx = ((i % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length;
  return `<svg class="av av-${mood}" width="${size}" height="${Math.round(size * 0.875)}" viewBox="0 0 64 56" role="img" aria-label="${title ?? CHARACTERS[idx].label}">
    ${title ? `<title>${title}</title>` : ""}
    <ellipse cx="32" cy="54.5" rx="20" ry="1.8" fill="#000" opacity=".35"/>
    ${body(idx, mood)}
  </svg>`;
}

/** A mini avatar placed inside another SVG (e.g. the run graph). */
export function avatarAt(i: number, mood: Mood, x: number, y: number, size: number, title?: string): string {
  return avatar(i, mood, size, title).replace("<svg ", `<svg x="${x}" y="${y}" `);
}
