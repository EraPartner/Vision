export type ElectronUpdateMode = "source" | "docker" | "native" | "dev";

export interface ElectronSuccessResult {
  success: boolean;
  error?: string;
}

export interface UpdateCheckStatus {
  up_to_date: boolean;
  current_version: string;
  latest_version: string | null;
  published_at?: string;
  release_notes?: string;
  html_url?: string;
  error?: string;
  update_mode: ElectronUpdateMode | "docker-compose";
  source_launcher_available?: boolean;
}

export interface PullImageResult extends ElectronSuccessResult {
  wasNew?: boolean;
}

export interface InstallUpdateResult extends ElectronSuccessResult {
  version?: string;
  manual_download?: boolean;
  html_url?: string;
}

export interface FrontendStateSnapshot {
  keys: Record<string, string>;
}

export interface BackupResult extends ElectronSuccessResult {
  file?: string;
  encrypted?: boolean;
  warning?: string;
  cleanupRemoved?: number;
}

export interface RestoreResult extends ElectronSuccessResult {
  file?: string;
  frontendState?: FrontendStateSnapshot | null;
  warning?: string;
}

export interface ElectronMenuAction {
  action:
    | "navigate"
    | "open-settings"
    | "open-shortcuts"
    | "new-transaction"
    | "toggle-sidebar";
  payload?: unknown;
}

export interface ElectronCsvFile {
  name: string;
  content: string;
}

export interface SplashThemeColors {
  mode?: "light" | "dark";
  background: string;
  foreground: string;
  surface?: string;
  text?: string;
}

export interface RendererFailurePayload {
  kind: "error" | "resource" | "unhandledrejection";
  name: string;
  source: string;
  line: number;
}

export interface ElectronInvokeContract {
  "update:pull-image": {
    args: [];
    result: PullImageResult;
  };
  "update:check-github": { args: []; result: UpdateCheckStatus };
  "update:install-shell": {
    args: [];
    result: InstallUpdateResult;
  };
  "update:get-mode": {
    args: [];
    result: {
      mode: ElectronUpdateMode;
      is_packaged: boolean;
      use_repo_mode: boolean;
    };
  };
  "update:pre-update-backup": { args: []; result: BackupResult };
  "backup:run": {
    args: [destDir: string, frontendStateJson?: string | null];
    result: BackupResult;
  };
  "backup:select-dir": { args: []; result: string | null };
  "backup:select-file": { args: []; result: string | null };
  "backup:restore": {
    args: [filePath: string, opts?: { passphrase?: string }];
    result: RestoreResult;
  };
  "backup:is-encrypted": { args: [filePath: string]; result: boolean };
  "backup:save-settings": {
    args: [settings: { backupDir: string; backupOnQuit: boolean }];
    result: ElectronSuccessResult;
  };
  "backup:load-settings": {
    args: [];
    result: { backupDir: string; backupOnQuit: boolean };
  };
  "backup:get-encryption-status": {
    args: [];
    result: ElectronSuccessResult & {
      secureStorageAvailable: boolean;
      hasStoredPassphrase: boolean;
      hasEnvPassphrase: boolean;
    };
  };
  "backup:set-passphrase": {
    args: [passphrase: string];
    result: ElectronSuccessResult & { available: boolean };
  };
  "services:save-settings": {
    args: [settings: { keepServicesOnQuit: boolean }];
    result: ElectronSuccessResult;
  };
  "services:load-settings": {
    args: [];
    result: { keepServicesOnQuit: boolean };
  };
  "recovery:retry": { args: []; result: ElectronSuccessResult };
  "recovery:open-logs": {
    args: [];
    result: ElectronSuccessResult & { path?: string };
  };
  "app:renderer-failure": {
    args: [payload: RendererFailurePayload];
    result: ElectronSuccessResult;
  };
  "app:renderer-ready": { args: []; result: ElectronSuccessResult };
  "app:set-badge": {
    args: [count: number];
    result: ElectronSuccessResult;
  };
  "app:set-language": {
    args: [language: "en" | "nl"];
    result: ElectronSuccessResult & { superseded?: boolean };
  };
  "app:set-vibrancy": {
    args: [enabled: boolean];
    result: ElectronSuccessResult;
  };
  "app:get-accent-color": { args: []; result: string | null };
  "theme:persist-splash": {
    args: [colors: SplashThemeColors];
    result: ElectronSuccessResult;
  };
}

export type ElectronInvokeChannel = keyof ElectronInvokeContract;
export type ElectronInvoke<C extends ElectronInvokeChannel> = (
  ...args: ElectronInvokeContract[C]["args"]
) => Promise<ElectronInvokeContract[C]["result"]>;

export interface ElectronEventContract {
  "app:accent-color-changed": string | null;
  "menu:action": ElectronMenuAction;
  "app:csv-opened": ElectronCsvFile;
  "window:fullscreen": boolean;
  "backend:lost": { message: string };
  "backend:restored": undefined;
}

export type ElectronEventChannel = keyof ElectronEventContract;
export type ElectronSubscription<C extends ElectronEventChannel> = (
  callback: (payload: ElectronEventContract[C]) => void,
) => () => void;

export interface ElectronUpdaterBridge {
  pullImage: ElectronInvoke<"update:pull-image">;
  checkRelease?: ElectronInvoke<"update:check-github">;
  installShellUpdate?: ElectronInvoke<"update:install-shell">;
  getMode?: ElectronInvoke<"update:get-mode">;
  preUpdateBackup?: ElectronInvoke<"update:pre-update-backup">;
}

export interface ElectronBackupBridge {
  runBackup: ElectronInvoke<"backup:run">;
  selectDir: ElectronInvoke<"backup:select-dir">;
  selectFile: ElectronInvoke<"backup:select-file">;
  restoreBackup: ElectronInvoke<"backup:restore">;
  isEncrypted?: ElectronInvoke<"backup:is-encrypted">;
  saveSettings: ElectronInvoke<"backup:save-settings">;
  loadSettings: ElectronInvoke<"backup:load-settings">;
  getEncryptionStatus?: ElectronInvoke<"backup:get-encryption-status">;
  setPassphrase?: ElectronInvoke<"backup:set-passphrase">;
}

export interface ElectronServicesBridge {
  saveSettings: ElectronInvoke<"services:save-settings">;
  loadSettings: ElectronInvoke<"services:load-settings">;
}

export interface ElectronApiBridge {
  platform: string;
  ready: ElectronInvoke<"app:renderer-ready">;
  setDockBadge: ElectronInvoke<"app:set-badge">;
  setLanguage?: ElectronInvoke<"app:set-language">;
  setVibrancy?: ElectronInvoke<"app:set-vibrancy">;
  getAccentColor: ElectronInvoke<"app:get-accent-color">;
  persistSplashTheme?: ElectronInvoke<"theme:persist-splash">;
  onAccentColorChanged: ElectronSubscription<"app:accent-color-changed">;
  onMenuAction: ElectronSubscription<"menu:action">;
  onCsvOpen: ElectronSubscription<"app:csv-opened">;
  onFullScreenChange: ElectronSubscription<"window:fullscreen">;
}

export interface ElectronRecoveryBridge {
  retry: ElectronInvoke<"recovery:retry">;
  openLogs: ElectronInvoke<"recovery:open-logs">;
  onBackendLost: ElectronSubscription<"backend:lost">;
  onBackendRestored: (callback: () => void) => () => void;
}

export interface ElectronBridges {
  electronUpdater?: ElectronUpdaterBridge;
  electronBackup?: ElectronBackupBridge;
  electronServices?: ElectronServicesBridge;
  electronAPI?: ElectronApiBridge;
  electronRecovery?: ElectronRecoveryBridge;
}

declare global {
  interface Window extends ElectronBridges {}
}
