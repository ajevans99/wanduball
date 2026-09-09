"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { isTheme, themeStorageKey, type Theme } from "@/lib/theme";

function subscribe(listener: () => void) {
    const observer = new MutationObserver(listener);
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-theme-storage-error"],
    });
    return () => observer.disconnect();
}

function preference(): Theme {
    const value = document.documentElement.dataset.theme;
    return isTheme(value) ? value : "system";
}

function storageUnavailable() {
    return document.documentElement.dataset.themeStorageError === "true";
}

export function ThemePicker() {
    const theme = useSyncExternalStore(subscribe, preference, () => "system");
    const unsaved = useSyncExternalStore(subscribe, storageUnavailable, () => false);
    const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;

    function changeTheme(value: string) {
        if (!isTheme(value)) return;
        document.documentElement.dataset.theme = value;
        try {
            localStorage.setItem(themeStorageKey, value);
            delete document.documentElement.dataset.themeStorageError;
        } catch (error) {
            document.documentElement.dataset.themeStorageError = "true";
            console.warn("Wanduball could not save your appearance.", error);
        }
    }

    return <div className="theme-control">
        <label className="theme-picker">
            <Icon size={15} aria-hidden="true" />
            <span className="visually-hidden">Color theme</span>
            <select value={theme} onChange={event => changeTheme(event.target.value)} aria-describedby={unsaved ? "theme-storage-error" : undefined}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
            </select>
        </label>
        {unsaved && <p className="theme-storage-error" id="theme-storage-error" role="status">Appearance works, but this browser can&apos;t save it.</p>}
    </div>;
}
