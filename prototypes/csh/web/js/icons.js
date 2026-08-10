// SVG 스프라이트. 페이지마다 복붙하지 않으려고 JS로 한 번만 주입합니다.
// 아이콘은 Figma 시안이 쓴 Lucide 계열 선 아이콘(stroke 1.67, round)에 맞췄습니다.

const PATHS = {
  "alert-triangle": '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "zap": '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  "arrow-up": '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "bot": '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  "building": '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M8 10h.01"/><path d="M16 10h.01"/><path d="M8 14h.01"/><path d="M16 14h.01"/>',
  "map-pin": '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  "message-circle": '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  "star": '<path d="M11.5 2.9a.6.6 0 0 1 1 0l2.4 4.9 5.4.8a.6.6 0 0 1 .3 1l-3.9 3.8.9 5.4a.6.6 0 0 1-.9.6L12 16.9l-4.8 2.5a.6.6 0 0 1-.9-.6l.9-5.4-3.9-3.8a.6.6 0 0 1 .3-1l5.4-.8Z"/>',
  "trending-up": '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  "alert-circle": '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "check-circle": '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3L22 4"/>',
  "bar-chart": '<path d="M3 3v18h18"/><rect width="4" height="7" x="7" y="10"/><rect width="4" height="12" x="15" y="5"/>',
  "layers": '<path d="m12.8 2.5 8.1 4a.7.7 0 0 1 0 1.2l-8.1 4a1.7 1.7 0 0 1-1.6 0l-8.1-4a.7.7 0 0 1 0-1.2l8.1-4a1.7 1.7 0 0 1 1.6 0Z"/><path d="m22 12.5-9.2 4.6a1.7 1.7 0 0 1-1.6 0L2 12.5"/><path d="m22 17.5-9.2 4.6a1.7 1.7 0 0 1-1.6 0L2 17.5"/>',
  "shield": '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.6 0C14.6 3.8 17 5 19 5a1 1 0 0 1 1 1Z"/>',
  "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  "clipboard": '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/>',
  "thumbs-up": '<path d="M7 10v12"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.4l-1.4 7a2 2 0 0 1-2 1.6H7V10a6 6 0 0 0 3.9-2.3l2.1-2.8A2 2 0 0 1 15 5.9Z"/>',
  "construction": '<rect width="20" height="8" x="2" y="6" rx="1"/><path d="M17 14v7"/><path d="M7 14v7"/><path d="M17 3v3"/><path d="M7 3v3"/><path d="M10 14 2.3 6.3"/><path d="m14 6 7.7 7.7"/><path d="m8 6 8 8"/>',
  "gear": '<path d="M12.2 2h-.4a2 2 0 0 0-2 2 2 2 0 0 1-2.9 1.7l-.3-.2a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7 2 2 0 0 1 0 3.4 2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.3-.2A2 2 0 0 1 9.8 20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2 2 2 0 0 1 2.9-1.7l.3.2a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7 2 2 0 0 1 0-3.4 2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.3.2A2 2 0 0 1 14.2 4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  "flask": '<path d="M10 2v7.5L4.6 18A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-3L14 9.5V2"/><path d="M8.5 2h7"/><path d="M6.5 15h11"/>',
  "truck": '<path d="M14 18V6a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h2"/><path d="M14 9h4l4 4v4a1 1 0 0 1-1 1h-1"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  "store": '<path d="m3 3 1 6h16l1-6"/><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M9 21v-6h6v6"/>',
};

const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
sprite.setAttribute("aria-hidden", "true");
sprite.style.display = "none";
sprite.innerHTML = Object.entries(PATHS)
  .map(([name, d]) => `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</symbol>`)
  .join("");

document.addEventListener("DOMContentLoaded", () => document.body.prepend(sprite));

/** <svg><use href="#i-name"></use></svg> 마크업을 만듭니다. */
function icon(name, cls = "") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

window.icon = icon;
