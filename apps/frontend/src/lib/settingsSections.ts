const SETTINGS_SECTION_IDS = [
    "general",
    "appearance",
    "statistics",
    "behavior",
    "ai",
    "backup",
    "about",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];
export function resolveSettingsSection(
    tab: string | undefined,
): SettingsSectionId | undefined {
    return SETTINGS_SECTION_IDS.find((section) => section === tab);
}
