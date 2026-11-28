/**
 * Browser notification helper.
 * Requests permission, respects user prefs, and fires native notifications.
 */

const STORAGE_KEY = "ps_push_prefs";

let _prefs = null;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { enabled: true };
  } catch {
    return { enabled: true };
  }
}

export function getPushPrefs() {
  if (!_prefs) _prefs = loadPrefs();
  return _prefs;
}

export function setPushPrefs(p) {
  _prefs = { ...getPushPrefs(), ...p };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(_prefs));
}

export async function requestPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  const result = await Notification.requestPermission();
  return result;
}

/**
 * Fire a browser notification if allowed.
 * type: "challenge" | "dm" | "friend" | "tournament" | "achievement" | "system"
 */
export function notify(title, body, type = "system", onClick = null) {
  const prefs = getPushPrefs();
  if (!prefs.enabled) return;
  if (prefs["on_" + type] === false) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    const n = new Notification(title, {
      body,
      icon: "/static/favicon.ico",
      badge: "/static/favicon.ico",
      tag: type,       // dedupe same-type notifications
      renotify: true,
    });
    if (onClick) {
      n.onclick = () => {
        window.focus();
        onClick();
        n.close();
      };
    }
    // Auto-close after 8 seconds
    setTimeout(() => n.close(), 8000);
  } catch (e) {
    console.warn("[notify error]", e);
  }
}

/**
 * Returns the current browser permission: "granted" | "denied" | "default" | "unsupported"
 */
export function permissionStatus() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}