import * as vscode from 'vscode';

export interface ProjectPlaylist {
  uri: string;
  name: string;
  image?: string;
}

const KEY = 'bracketBeats.projectPlaylist';

/** O projeto aberto nesta janela e a playlist que lhe está associada. */
export class Project {
  constructor(private readonly memento: vscode.Memento) {}

  /** Identificador estável do projeto (pasta ou ficheiro .code-workspace). Undefined sem pasta aberta. */
  get key(): string | undefined {
    return vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
  }

  get name(): string | undefined {
    return vscode.workspace.name;
  }

  get playlist(): ProjectPlaylist | undefined {
    return this.key ? this.memento.get<ProjectPlaylist>(KEY) : undefined;
  }

  async setPlaylist(p: ProjectPlaylist | undefined): Promise<void> {
    await this.memento.update(KEY, p);
  }

  /** Linguagem do ficheiro ativo, para o histórico. */
  get language(): string | undefined {
    return vscode.window.activeTextEditor?.document.languageId;
  }
}
