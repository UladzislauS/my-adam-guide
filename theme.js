// Day / night theme, shared by the site and the editor.
// Loaded in <head> before the stylesheets apply, so the page never flashes the wrong colours.
// No saved choice = follow the device. The choice is per browser and applies to both pages.
(() => {
  const KEY = "cityGuide.theme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch { return null; }
  };
  const save = (v) => {
    try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {}
  };
  const systemTheme = () => (system.matches ? "dark" : "light");
  const current = () => saved() || systemTheme();

  function apply() {
    const t = current();
    const root = document.documentElement;
    if (root.dataset.theme === t) return;
    root.dataset.theme = t;
    window.dispatchEvent(new CustomEvent("themechange", { detail: t }));
  }

  apply();
  system.addEventListener?.("change", apply);
  // Another tab (e.g. the editor next to the site) switched the theme.
  window.addEventListener("storage", (e) => { if (e.key === KEY) apply(); });

  window.cityTheme = {
    isDark: () => current() === "dark",
    toggle() {
      const next = current() === "dark" ? "light" : "dark";
      // Switching back to what the device shows means "follow the device" again.
      save(next === systemTheme() ? null : next);
      apply();
    },
  };
})();
