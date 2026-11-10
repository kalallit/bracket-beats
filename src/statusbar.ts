import * as vscode from 'vscode';
import { SpotifyAuth } from './auth';
import { Player } from './player';
import { t } from './i18n';

/** Barra de estado, do lado direito: ✨  ‹  ▶ Música — Artista  ›  ♥ */
export class StatusBar implements vscode.Disposable {
  private readonly pick: vscode.StatusBarItem;
  private readonly prev: vscode.StatusBarItem;
  private readonly main: vscode.StatusBarItem;
  private readonly next: vscode.StatusBarItem;
  private readonly like: vscode.StatusBarItem;

  constructor(private readonly player: Player, private readonly auth: SpotifyAuth) {
    const make = (priority: number, command: string, text = '') => {
      const it = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
      it.command = command;
      it.text = text;
      return it;
    };
    this.pick = make(104, 'bracketBeats.openPicker', '$(sparkle)');
    this.prev = make(103, 'bracketBeats.previous', '$(chevron-left)');
    this.main = make(102, 'bracketBeats.togglePlay');
    this.next = make(101, 'bracketBeats.next', '$(chevron-right)');
    this.like = make(100, 'bracketBeats.toggleLike', '$(heart)');
    this.main.name = 'Bracket Beats';
    this.relabel();
  }

  dispose(): void {
    [this.pick, this.prev, this.main, this.next, this.like].forEach((i) => i.dispose());
  }

  /** Textos fixos; chamado também quando se muda o idioma. */
  relabel(): void {
    this.pick.tooltip = t('sb.suggestions');
    this.prev.tooltip = t('sb.prev');
    this.next.tooltip = t('sb.next');
  }

  private wants(button: string): boolean {
    const list = vscode.workspace.getConfiguration('bracketBeats')
      .get<string[]>('statusBarButtons', ['suggestions', 'previous', 'next', 'like']);
    return Array.isArray(list) && list.includes(button);
  }

  private toggle(item: vscode.StatusBarItem, show: boolean): void {
    if (show) { item.show(); } else { item.hide(); }
  }

  render(): void {
    const s = this.player.state;
    this.main.command = 'bracketBeats.togglePlay';
    this.toggle(this.pick, this.wants('suggestions'));

    if (!s) {
      this.main.text = '$(play) Spotify';
      this.main.tooltip = t('sb.idleTip');
      this.main.show();
      this.prev.hide();
      this.next.hide();
      this.like.hide();
      return;
    }

    const icon = s.isPlaying ? '$(debug-pause)' : '$(play)';
    this.main.text = `${icon} ${truncate(`${s.title} — ${s.artists}`, 45)}`;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(s.title)}**  \n${escapeMd(s.artists)}`);
    if (s.album) { md.appendMarkdown(`  \n_${escapeMd(s.album)}_`); }
    md.appendMarkdown(`  \n\n${fmt(this.player.progressNow())} / ${fmt(s.durationMs)}`);
    if (s.device) { md.appendMarkdown(`  \n$(device-desktop) ${escapeMd(s.device.name)}`); }
    if (s.url) { md.appendMarkdown(`  \n[${t('tip.open')}](${s.url})`); }
    md.appendMarkdown(`  \n\n${s.isPlaying ? t('tip.clickPause') : t('tip.clickResume')}`);
    this.main.tooltip = md;
    this.main.show();

    this.toggle(this.prev, this.wants('previous'));
    this.toggle(this.next, this.wants('next'));

    const canLike = s.type === 'track' && this.wants('like');
    this.like.text = this.player.liked ? '$(heart-filled)' : '$(heart)';
    this.like.tooltip = this.player.liked ? t('sb.unlike') : t('sb.like');
    this.toggle(this.like, canLike);
  }

  showLoggedOut(): void {
    this.main.text = t('sb.login');
    this.main.tooltip = this.auth.needsReauth ? t('sb.reauthTip') : t('sb.loginTip');
    this.main.command = 'bracketBeats.login';
    this.main.show();
    this.pick.hide();
    this.prev.hide();
    this.next.hide();
    this.like.hide();
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+\-.!|]/g, '\\$&');
}
