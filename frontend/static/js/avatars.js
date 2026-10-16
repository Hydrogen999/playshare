export const AVATARS = [
  { id: "fox",     name: "Fox",     emoji: "🦊", bg: "#f97316" },
  { id: "tiger",   name: "Tiger",   emoji: "🐯", bg: "#eab308" },
  { id: "panda",   name: "Panda",   emoji: "🐼", bg: "#64748b" },
  { id: "lion",    name: "Lion",    emoji: "🦁", bg: "#d97706" },
  { id: "frog",    name: "Frog",    emoji: "🐸", bg: "#22c55e" },
  { id: "octopus", name: "Octopus", emoji: "🐙", bg: "#ec4899" },
  { id: "unicorn", name: "Unicorn", emoji: "🦄", bg: "#a855f7" },
  { id: "dragon",  name: "Dragon",  emoji: "🐲", bg: "#ef4444" },
  { id: "alien",   name: "Alien",   emoji: "👾", bg: "#10b981" },
  { id: "robot",   name: "Robot",   emoji: "🤖", bg: "#06b6d4" },
  { id: "ghost",   name: "Ghost",   emoji: "👻", bg: "#94a3b8" },
  { id: "wolf",    name: "Wolf",    emoji: "🐺", bg: "#475569" },
];

export function getAvatar(id) {
  return AVATARS.find((a) => a.id === id) || AVATARS[0];
}

/**
 * Render an avatar as HTML.
 * @param {string} id - avatar id
 * @param {string} size - "sm" | "md" | "lg" | "xl"
 * @param {string|null} frameColor - optional hex for equipped frame ring
 * @param {boolean} isPremium - if true, adds a crown badge
 */
export function avatarHTML(id, size = "md", frameColor = null, isPremium = false) {
  const a = getAvatar(id);
  const px = { sm: 32, md: 48, lg: 96, xl: 128 }[size] || 48;
  const fs = { sm: 18, md: 24, lg: 52, xl: 72 }[size] || 24;

  const ringStyle = frameColor
    ? `box-shadow: 0 0 0 3px ${frameColor}, 0 0 16px ${frameColor}66, 0 4px 12px rgba(0,0,0,0.4);`
    : `box-shadow: 0 4px 12px rgba(0,0,0,0.4);`;

  const crownSize = { sm: 12, md: 16, lg: 26, xl: 32 }[size] || 16;
  const crownBadge = isPremium
    ? `<div style="
        position:absolute; top:-2px; right:-2px;
        font-size:${crownSize}px;
        filter: drop-shadow(0 0 3px rgba(251,191,36,0.9));
        pointer-events: none;
      ">👑</div>`
    : "";

  return `<div style="position:relative;display:inline-block;">
    <div style="width:${px}px;height:${px}px;background:${a.bg};font-size:${fs}px;${ringStyle}"
      class="rounded-full grid place-items-center select-none">${a.emoji}</div>
    ${crownBadge}
  </div>`;
}