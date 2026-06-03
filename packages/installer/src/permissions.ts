/**
 * Post-install permission guidance (pure, platform-aware).
 *
 * Only macOS actually loses permissions on install: re-signing changes the app's
 * code identity, so TCC treats it as a new app and previously granted
 * permissions (Screen Recording, Microphone, Accessibility, Full Disk Access, …)
 * must be granted again — ONCE (desktop-proxy re-signs with a stable local
 * certificate, so future updates keep the grant). We can't auto-grant (TCC
 * forbids it), but we can open the right System Settings pane and guide the user.
 *
 * Windows ties app capabilities to the user, not the signature, so patching does
 * NOT reset permissions. Linux .deb/tar apps have no per-app permission system.
 */

export type Plat = "darwin" | "win32" | "linux" | string;

export interface PrivacyPane {
  id: string;
  label: string;
  /** Deep link that opens the relevant settings pane. */
  url: string;
  /** true = user must toggle it manually; false = the app re-prompts in-app. */
  manual: boolean;
}

const MAC_PANES: PrivacyPane[] = [
  { id: "screen-recording", label: "Screen Recording", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", manual: true },
  { id: "accessibility", label: "Accessibility", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", manual: true },
  { id: "full-disk", label: "Full Disk Access", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", manual: true },
  { id: "automation", label: "Automation (Apple Events)", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation", manual: true },
  { id: "microphone", label: "Microphone", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone", manual: false },
  { id: "camera", label: "Camera", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera", manual: false },
];

const WIN_PANES: PrivacyPane[] = [
  { id: "microphone", label: "Microphone", url: "ms-settings:privacy-microphone", manual: false },
  { id: "camera", label: "Camera", url: "ms-settings:privacy-webcam", manual: false },
  { id: "privacy", label: "Privacy (all)", url: "ms-settings:privacy", manual: false },
];

export function privacyPanes(plat: Plat): PrivacyPane[] {
  if (plat === "darwin") return MAC_PANES;
  if (plat === "win32") return WIN_PANES;
  return []; // linux: no per-app permission model for .deb/tar apps
}

export function privacyPaneUrl(plat: Plat, id: string): string | null {
  return privacyPanes(plat).find((p) => p.id === id)?.url ?? null;
}

/** The top-level privacy settings pane (opened post-install for convenience). */
export function rootPrivacyUrl(plat: Plat): string | null {
  if (plat === "darwin") return "x-apple.systempreferences:com.apple.preference.security?Privacy";
  if (plat === "win32") return "ms-settings:privacy";
  return null;
}

export function permissionsNote(plat: Plat): string {
  if (plat === "darwin") {
    return (
      "Re-signing changes the app's code identity, so macOS treats it as a new app and " +
      "previously granted permissions must be re-granted ONCE. desktop-proxy re-signs with a " +
      "stable local certificate, so future updates keep your grants. (macOS can't auto-grant — " +
      "Microphone/Camera re-prompt in-app; the others are toggled in System Settings below.)"
    );
  }
  if (plat === "win32") {
    return (
      "Windows ties app capabilities to the user, not the code signature, so patching/re-signing " +
      "does NOT reset permissions. (SmartScreen may warn once on first launch of the modified app.)"
    );
  }
  return "Linux .deb/tar apps have no per-app permission system — nothing to re-grant.";
}

export interface Opener {
  cmd: string;
  args(url: string): string[];
}

/** The platform command that opens a settings deep link. */
export function openerCommand(plat: Plat): Opener | null {
  if (plat === "darwin") return { cmd: "open", args: (u) => [u] };
  if (plat === "win32") return { cmd: "cmd", args: (u) => ["/c", "start", "", u] };
  if (plat === "linux") return { cmd: "xdg-open", args: (u) => [u] };
  return null;
}
