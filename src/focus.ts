import * as vscode from 'vscode';
import { Player } from './player';
import { t } from './i18n';

export type Phase = 'idle' | 'work' | 'break';

export interface FocusHooks {
  /** Pôr música a tocar no início do foco (retomar, ou a playlist do projeto). */
  startMusic(): Promise<void>;
}

/**
 * Sessões de foco (pomodoro): a música toca durante o foco e pausa no intervalo.
 * O temporizador vive nesta janela e mostra a contagem na barra de estado.
 */
export class FocusSession implements vscode.Disposable {
  phase: Phase = 'idle';
  endsAt = 0;
  /** Início da sessão em curso (para guardar as músicas como playlist). */
  startedAt = 0;
  rounds = 0;
  /** Intervalo de tempo da última sessão terminada. */
  lastSession: { from: number; to: number } | undefined;

  private workMin = 25;
  private breakMin = 5;
  private timer: NodeJS.Timeout | undefined;
  private pausedByUs = false;
  private readonly item: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly player: Player, private readonly hooks: FocusHooks) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.name = 'Bracket Beats · Focus';
    this.item.command = 'bracketBeats.focus';
  }

  get active(): boolean {
    return this.phase !== 'idle';
  }

  get minutes(): { work: number; rest: number } {
    return { work: this.workMin, rest: this.breakMin };
  }

  async start(workMin: number, breakMin: number): Promise<void> {
    this.workMin = Math.max(1, Math.round(workMin));
    this.breakMin = Math.max(1, Math.round(breakMin));
    this.rounds = 0;
    this.startedAt = Date.now();
    this.pausedByUs = false;
    this.enter('work');
    if (this.timer) { clearInterval(this.timer); }
    this.timer = setInterval(() => this.tick(), 1000);
    try { await this.hooks.startMusic(); } catch { /* sem dispositivo: o temporizador segue na mesma */ }
  }

  stop(): void {
    if (!this.active) { return; }
    this.lastSession = { from: this.startedAt, to: Date.now() };
    this.phase = 'idle';
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.item.hide();
    this.changed.fire();
  }

  /** Passa já à fase seguinte. */
  skip(): void {
    if (this.active) { this.advance(); }
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); }
    this.item.dispose();
    this.changed.dispose();
  }

  private enter(phase: 'work' | 'break'): void {
    this.phase = phase;
    this.endsAt = Date.now() + (phase === 'work' ? this.workMin : this.breakMin) * 60_000;
    this.render();
    this.changed.fire();
  }

  private tick(): void {
    if (!this.active) { return; }
    if (Date.now() >= this.endsAt) { this.advance(); } else { this.render(); }
  }

  private advance(): void {
    const pauseOnBreak = vscode.workspace.getConfiguration('bracketBeats').get<boolean>('focus.pauseOnBreak', true);
    if (this.phase === 'work') {
      this.rounds++;
      if (pauseOnBreak && this.player.state?.isPlaying) {
        this.pausedByUs = true;
        this.player.pause().catch(() => undefined);
      }
      this.enter('break');
      vscode.window.showInformationMessage(t('focus.breakStart', this.breakMin));
    } else {
      if (this.pausedByUs) {
        this.pausedByUs = false;
        this.player.play().catch(() => undefined); // retoma onde ficou
      }
      this.enter('work');
      vscode.window.showInformationMessage(t('focus.workStart', this.workMin));
    }
  }

  private render(): void {
    const left = Math.max(0, Math.ceil((this.endsAt - Date.now()) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    this.item.text = `${this.phase === 'work' ? '$(target)' : '$(coffee)'} ${clock}`;
    this.item.tooltip = this.phase === 'work' ? t('focus.tipWork') : t('focus.tipBreak');
    this.item.show();
  }
}
