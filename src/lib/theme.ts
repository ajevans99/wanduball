export const themeStorageKey = "wanduball-theme-v1";
export type Theme = "light" | "dark" | "system";

export function isTheme(value: unknown): value is Theme {
    return value === "light" || value === "dark" || value === "system";
}

// This self-contained script runs before paint, including before React loads.
export const themeInitializationScript = `(() => {
    const root = document.documentElement;
    const key = ${JSON.stringify(themeStorageKey)};
    const valid = value => value === "light" || value === "dark" || value === "system";
    let preference = "system";
    try {
        const saved = localStorage.getItem(key);
        if (valid(saved)) preference = saved;
    } catch (error) {
        root.dataset.themeStorageError = "true";
        console.warn("Wanduball could not read your saved appearance.", error);
    }
    root.dataset.theme = preference;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const chrome = document.createElement("meta");
    chrome.name = "theme-color";
    document.head.appendChild(chrome);
    const updateChrome = () => {
        const dark = root.dataset.theme === "dark" || (root.dataset.theme === "system" && media.matches);
        chrome.content = dark ? "#15121b" : "#faf9f6";
    };
    updateChrome();
    media.addEventListener("change", updateChrome);
    new MutationObserver(updateChrome).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("storage", event => {
        if (event.key !== key && event.key !== null) return;
        root.dataset.theme = valid(event.newValue) ? event.newValue : "system";
        delete root.dataset.themeStorageError;
    });
})();`;
