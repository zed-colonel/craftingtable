export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'craftingtable.theme';

function readStored(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Dark unless the operator chose light. The OS preference is deliberately not consulted. */
export function currentTheme(): Theme {
  return readStored() ?? 'dark';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

export function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable; the choice then lasts for the session only.
  }
  applyTheme(theme);
}

const LAST_WORKSPACE_KEY = 'craftingtable.last-workspace';

export function rememberWorkspace(workspaceId: string): void {
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
  } catch {
    // Best effort only.
  }
}

export function rememberedWorkspace(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_WORKSPACE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
