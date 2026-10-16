import { api } from "./api.js";

const tabLogin = document.getElementById("tabLogin");
const tabRegister = document.getElementById("tabRegister");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const authMsg = document.getElementById("authMsg");

let busy = false;

function setTab(mode) {
  const login = mode === "login";
  loginForm.classList.toggle("hidden", !login);
  registerForm.classList.toggle("hidden", login);

  tabLogin.className = login
    ? "flex-1 rounded-lg px-4 py-2 text-sm font-semibold bg-brand-600"
    : "flex-1 rounded-lg px-4 py-2 text-sm font-semibold bg-slate-800 text-slate-300";
  tabRegister.className = !login
    ? "flex-1 rounded-lg px-4 py-2 text-sm font-semibold bg-brand-600"
    : "flex-1 rounded-lg px-4 py-2 text-sm font-semibold bg-slate-800 text-slate-300";

  showMsg("");
}

function showMsg(text, type = "error") {
  if (!text) {
    authMsg.classList.add("hidden");
    return;
  }
  authMsg.classList.remove("hidden");
  authMsg.className = "mt-3 sm:mt-4 text-sm " + (type === "error" ? "text-red-400" : "text-emerald-400");
  authMsg.textContent = text;
}

tabLogin.addEventListener("click", () => setTab("login"));
tabRegister.addEventListener("click", () => setTab("register"));

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;

  const fd = new FormData(loginForm);
  try {
    showMsg("Logging in…", "success");
    const { access_token } = await api.login({
      email: fd.get("email"),
      password: fd.get("password"),
    });
    localStorage.removeItem("ps_token");
    api.saveToken(access_token);
    showMsg("Redirecting…", "success");
    window.location.href = "/dashboard";
  } catch (err) {
    showMsg(err.message || "Login failed");
    busy = false;
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(registerForm);
  try {
    showMsg("Creating account...", "success");
    const { access_token } = await api.register({
      email: fd.get("email"),
      username: fd.get("username"),
      password: fd.get("password"),
      ref_code: (fd.get("ref_code") || "").toString().trim() || null,
    });
    localStorage.removeItem("ps_token");
    api.saveToken(access_token);
    showMsg("Redirecting…", "success");
    window.location.href = "/dashboard";
  } catch (err) {
    showMsg(err.message || "Registration failed");
    busy = false;
  }
});

// Only auto-redirect if token is VALID
(async () => {
  const token = api.getToken();
  if (!token) return;
  try {
    await api.me();
    window.location.href = "/dashboard";
  } catch {
    api.clearToken();
  }
})();