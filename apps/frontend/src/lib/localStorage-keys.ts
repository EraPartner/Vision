/**
 * Canonical registry of every localStorage key used by Vision's frontend.
 *
 * Single source of truth imported by:
 *   - contexts/ThemeContext.tsx          (theme, variant)
 *   - components/settings/sections/BackupSection.tsx  (passphrase reminder)
 *   - components/notifications/UpcomingPaymentsNotification.tsx
 *   - components/planned/RecurringDetectionPanel.tsx
 *   - packaging/electron/backup/bundle.js  (snapshot on export)
 *
 * ADDING A KEY? Add it here first, then update BackupSection's snapshot logic.
 * The backup-coverage test will fail in CI until both are done.
 */

export const LOCAL_STORAGE_KEYS = Object.freeze({
  /** Active theme mode: 'light' | 'dark' | 'system' */
  THEME: 'vision_theme',

  /** Active color variant string (e.g. 'default', 'forest', …) */
  THEME_VARIANT: 'vision_theme_variant',

  /** Passphrase reminder dismissed flag (value: '1') */
  BACKUP_PASSPHRASE_REMINDER_DISMISSED: 'vision.backup.passphrase.reminder.dismissed',

  /** JSON array of dismissed upcoming-payment IDs */
  DISMISSED_UPCOMING_PAYMENTS: 'dismissed_upcoming_planned_payments',

  /** JSON array of dismissed recurring-pattern keys */
  DISMISSED_RECURRING_PATTERNS: 'dismissed_recurring_patterns',

  /** JSON array of recently visited routes shown in the ⌘K palette */
  PALETTE_RECENTS: 'vision.palette.recents',

  /** Last visited route (pathname+search) for window-state restoration */
  LAST_ROUTE: 'vision.lastRoute',
} as const);

export type LocalStorageKey = typeof LOCAL_STORAGE_KEYS[keyof typeof LOCAL_STORAGE_KEYS];

/**
 * Keys that are intentionally excluded from backup snapshots.
 * Transient state that should not carry over to a restored instance.
 */
export const LOCAL_STORAGE_EXCLUDED_KEYS: ReadonlyArray<string> = Object.freeze([
  // Legacy key — SettingsContext migrates value to DB and then removes it.
  // No value survives to be backed up.
  'vision_dashboardSettings',
  // Admin Bearer token (see lib/adminToken.ts). Session-scoped auth held in
  // sessionStorage only — must never be persisted to a backup snapshot.
  'vision.adminToken',
  // Transient ⌘K palette recents — navigation convenience, not user data.
  'vision.palette.recents',
  // Transient window-state restoration — meaningless on another machine.
  'vision.lastRoute',
]);
