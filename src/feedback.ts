import { Store } from './store';

interface Entry {
  plays: number;    // vezes que escolheste esta playlist nas sugestões
  shown: number;    // vezes que apareceu no topo das sugestões
  hidden?: boolean; // pediste para não voltar a ver
}

const FILE = 'feedback.json';

/**
 * Aprende com o que fazes no painel de sugestões: o que escolhes sobe,
 * o que aparece muitas vezes e nunca escolhes desce, e o que escondes desaparece.
 */
export class Feedback {
  private map: Record<string, Entry> = {};

  constructor(private readonly store: Store) {}

  /** Relê do disco (outra janela pode ter alterado). */
  async load(): Promise<void> {
    this.map = await this.store.read<Record<string, Entry>>(FILE, {});
  }

  private entry(uri: string): Entry {
    return (this.map[uri] ??= { plays: 0, shown: 0 });
  }

  private save(): Promise<void> {
    return this.store.write(FILE, this.map).catch(() => undefined);
  }

  async shown(uris: string[]): Promise<void> {
    if (!uris.length) { return; }
    uris.forEach((u) => { this.entry(u).shown++; });
    await this.save();
  }

  async played(uri: string): Promise<void> {
    this.entry(uri).plays++;
    await this.save();
  }

  async hide(uri: string): Promise<void> {
    this.entry(uri).hidden = true;
    await this.save();
  }

  /** Volta a mostrar tudo o que foi escondido. Devolve quantas eram. */
  async unhideAll(): Promise<number> {
    await this.load();
    let n = 0;
    Object.values(this.map).forEach((e) => { if (e.hidden) { e.hidden = false; n++; } });
    await this.save();
    return n;
  }

  isHidden(uri: string): boolean {
    return !!this.map[uri]?.hidden;
  }

  /** Fator a aplicar à pontuação de uma playlist: 0 esconde, <1 desce, >1 sobe. */
  multiplier(uri: string): number {
    const e = this.map[uri];
    if (!e) { return 1; }
    if (e.hidden) { return 0; }
    if (e.plays > 0) { return 1 + 0.35 * Math.log2(1 + e.plays); } // 1 vez: 1.35, 3: 1.7, 7: 2.05
    if (e.shown >= 12) { return 0.4; }
    if (e.shown >= 6) { return 0.65; }
    return 1;
  }
}
