"use client";

import { Select } from "@/components/ui/Select";
import { useTheme } from "@/components/ThemeProvider";
import { SaveChordSettings } from "@/components/settings/SaveChordSettings";

/** The "This device" group of the settings page. Its values stay in this browser. */
export function DeviceSettings() {
  const { theme, setTheme } = useTheme();
  return (
    <section id="device" className="scroll-mt-24 space-y-4">
      <h3 className="text-base font-semibold text-fg">Appearance and sound</h3>
      <Select
        id="theme-setting"
        label="Theme"
        value={theme}
        onChange={(event) => setTheme(event.target.value as "light" | "dark" | "system")}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ]}
      />
      <SaveChordSettings />
    </section>
  );
}
