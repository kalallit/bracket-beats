import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Definições que existiam como "spotifyNow.*" antes de a extensão se chamar Bracket Beats. */
const SETTINGS = [
  'language', 'clientId', 'redirectPort', 'suggestOnStartup', 'suggestionStyle', 'pollIntervalSeconds',
  'statusBarButtons', 'history.enabled', 'focus.workMinutes', 'focus.breakMinutes', 'focus.pauseOnBreak',
  'customMoods', 'hiddenMoods',
];

/** Ficheiros da pasta de dados que vale a pena trazer (o resto é estado temporário). */
const FILES = ['history.jsonl', 'feedback.json', 'contexts.json', 'playlist-artists.json'];

/** Nomes que a extensão já teve. A pasta de dados chama-se "<publisher>.<nome>". */
const OLD_NAMES = ['spotify-now', 'bracket-beats'];

const DONE_KEY = 'bracketBeats.migratedFrom';

export interface MigrationResult {
  settings: string[];
  files: string[];
}

/**
 * Corre uma vez: copia definições e dados de versões anteriores.
 *  - "spotifyNow.*" → "bracketBeats.*", só onde o valor novo ainda não foi definido;
 *  - ficheiros de outras pastas de dados com um nome antigo (o nome ou o publisher mudaram).
 * Não mexe nos originais. A sessão do Spotify e as playlists por projeto não se podem migrar
 * (o VS Code guarda-as por extensão), por isso é preciso voltar a ligar a conta.
 */
export async function migrate(context: vscode.ExtensionContext): Promise<MigrationResult> {
  const result: MigrationResult = { settings: [], files: [] };
  if (context.globalState.get(DONE_KEY)) { return result; }

  try {
    result.settings = await migrateSettings();
  } catch {
    // definições só de leitura (por exemplo geridas pela empresa): segue sem elas
  }
  try {
    result.files = await migrateFiles(context.globalStorageUri.fsPath);
  } catch {
    // sem acesso ao disco: segue sem histórico antigo
  }

  await context.globalState.update(DONE_KEY, Date.now());
  return result;
}

async function migrateSettings(): Promise<string[]> {
  const oldCfg = vscode.workspace.getConfiguration('spotifyNow');
  const newCfg = vscode.workspace.getConfiguration('bracketBeats');
  const moved: string[] = [];
  for (const key of SETTINGS) {
    const before = oldCfg.inspect(key);
    const now = newCfg.inspect(key);
    if (!before) { continue; }
    if (before.globalValue !== undefined && now?.globalValue === undefined) {
      await newCfg.update(key, before.globalValue, vscode.ConfigurationTarget.Global);
      moved.push(key);
    }
    if (before.workspaceValue !== undefined && now?.workspaceValue === undefined && vscode.workspace.workspaceFolders?.length) {
      await newCfg.update(key, before.workspaceValue, vscode.ConfigurationTarget.Workspace);
      if (!moved.includes(key)) { moved.push(key); }
    }
  }
  return moved;
}

async function migrateFiles(target: string): Promise<string[]> {
  const parent = path.dirname(target);
  const self = path.basename(target).toLowerCase();
  let entries: string[];
  try { entries = await fs.readdir(parent); } catch { return []; }

  // Pastas de versões anteriores, da mais recente para a mais antiga.
  const candidates: { dir: string; mtime: number }[] = [];
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (lower === self) { continue; }
    if (!OLD_NAMES.some((n) => lower.endsWith(`.${n}`))) { continue; }
    try {
      const st = await fs.stat(path.join(parent, name));
      if (st.isDirectory()) { candidates.push({ dir: path.join(parent, name), mtime: st.mtimeMs }); }
    } catch { /* desapareceu */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  await fs.mkdir(target, { recursive: true });
  const copied: string[] = [];
  for (const file of FILES) {
    const dest = path.join(target, file);
    if (await exists(dest)) { continue; } // já há dados novos: não os substitui
    for (const c of candidates) {
      const src = path.join(c.dir, file);
      if (await exists(src)) {
        await fs.copyFile(src, dest);
        copied.push(file);
        break;
      }
    }
  }
  return copied;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
