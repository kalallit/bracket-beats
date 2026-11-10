import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Ficheiros pequenos numa pasta partilhada por todas as janelas do VS Code
 * (context.globalStorageUri). É assim que as janelas partilham o que está a tocar,
 * o histórico, o feedback das sugestões e as caches.
 */
export class Store {
  private ready?: Promise<void>;

  constructor(readonly dir: string) {}

  private ensure(): Promise<void> {
    return (this.ready ??= fs.mkdir(this.dir, { recursive: true }).then(() => undefined));
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  async read<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  /** Escreve para um ficheiro temporário e renomeia, para outra janela nunca ler meio ficheiro. */
  async write(name: string, data: unknown): Promise<void> {
    await this.ensure();
    const json = JSON.stringify(data);
    const tmp = this.file(`${name}.${process.pid}.tmp`);
    try {
      await fs.writeFile(tmp, json);
      await fs.rename(tmp, this.file(name));
    } catch {
      // No Windows o rename falha se outra janela estiver a ler o ficheiro: escreve diretamente.
      await fs.writeFile(this.file(name), json);
      await fs.rm(tmp, { force: true });
    }
  }

  async append(name: string, line: string): Promise<void> {
    await this.ensure();
    await fs.appendFile(this.file(name), line + '\n');
  }

  async readLines(name: string): Promise<string[]> {
    try {
      return (await fs.readFile(this.file(name), 'utf8')).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  async writeLines(name: string, lines: string[]): Promise<void> {
    await this.ensure();
    await fs.writeFile(this.file(name), lines.length ? lines.join('\n') + '\n' : '');
  }

  async remove(name: string): Promise<void> {
    await fs.rm(this.file(name), { force: true });
  }

  /**
   * Tenta ficar com um "cadeado" entre janelas. Devolve true só para a primeira janela
   * que o pedir; as outras recebem false enquanto o cadeado for mais recente que maxAgeMs.
   */
  async tryLock(name: string, maxAgeMs: number): Promise<boolean> {
    await this.ensure();
    const f = this.file(name);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(f, String(Date.now()), { flag: 'wx' }); // falha se já existir
        return true;
      } catch {
        try {
          const st = await fs.stat(f);
          if (Date.now() - st.mtimeMs < maxAgeMs) { return false; }
          await fs.rm(f, { force: true }); // cadeado antigo: remove e tenta outra vez
        } catch {
          // desapareceu entretanto: tenta outra vez
        }
      }
    }
    return false;
  }
}
