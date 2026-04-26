import { Setting } from "obsidian";

export const addToggle = (
  containerEl: HTMLElement,
  options: {
    name: string;
    value: boolean;
    description?: string;
  },
  onChange: (value: boolean) => void
) => {
  const s = new Setting(containerEl).setName(options.name);
  if (options.description) s.setDesc(options.description);
  s.addToggle((toggle) => toggle.setValue(options.value).onChange(async (value) => onChange(value)));
  return s;
};
