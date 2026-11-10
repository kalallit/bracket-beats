import * as vscode from 'vscode';
import { t } from './i18n';

const DASHBOARD_URL = 'https://developer.spotify.com/dashboard';
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
const TOTAL_STEPS = 3;

type StepResult = 'next' | 'back' | 'cancel';

interface Item extends vscode.QuickPickItem { id: string }

/**
 * Assistente de 3 passos para ligar o Spotify sem ir às definições:
 *  1. abrir o dashboard e criar a app
 *  2. colar o Redirect URI (já copiado para a área de transferência)
 *  3. colar o Client ID
 * Devolve o Client ID, ou undefined se o utilizador cancelar.
 */
export async function runSetupWizard(redirectUri: string, currentId = ''): Promise<string | undefined> {
  let step = 1;
  let clientId: string | undefined;

  while (step >= 1 && step <= TOTAL_STEPS) {
    let result: StepResult;
    if (step === 1) {
      result = await stepCreateApp();
    } else if (step === 2) {
      result = await stepRedirectUri(redirectUri);
    } else {
      const r = await stepClientId(currentId);
      if (r === 'back' || r === 'cancel') {
        result = r;
      } else {
        clientId = r.id;
        result = 'next';
      }
    }
    if (result === 'cancel') { return undefined; }
    step += result === 'next' ? 1 : -1;
  }
  return clientId;
}

// ---------- passos ----------

async function stepCreateApp(): Promise<StepResult> {
  const choice = await pick(1, t('setup.s1.title'), t('setup.s1.placeholder'), [
    { id: 'open', label: `$(link-external) ${t('setup.s1.open')}`, detail: t('setup.s1.openDetail') },
    { id: 'have', label: `$(arrow-right) ${t('setup.s1.have')}`, detail: t('setup.s1.haveDetail') },
  ]);
  if (choice === 'back' || choice === undefined) { return 'cancel'; }
  if (choice.id === 'open') {
    await vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
  }
  return 'next';
}

async function stepRedirectUri(redirectUri: string): Promise<StepResult> {
  // Fica neste passo enquanto o utilizador pedir para copiar outra vez.
  for (;;) {
    await vscode.env.clipboard.writeText(redirectUri);
    const choice = await pick(2, t('setup.s2.title'), t('setup.s2.placeholder', redirectUri), [
      { id: 'next', label: `$(check) ${t('setup.s2.done')}`, detail: t('setup.s2.doneDetail') },
      { id: 'copy', label: `$(copy) ${t('setup.s2.copy')}`, detail: redirectUri },
      { id: 'open', label: `$(link-external) ${t('setup.s2.open')}` },
    ]);
    if (choice === undefined) { return 'cancel'; }
    if (choice === 'back') { return 'back'; }
    if (choice.id === 'next') { return 'next'; }
    if (choice.id === 'open') { await vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL)); }
    // 'copy' e 'open' voltam a mostrar o passo (e a copiar o URI)
  }
}

async function stepClientId(currentId: string): Promise<{ id: string } | 'back' | 'cancel'> {
  // Se o Client ID já estiver na área de transferência, entra preenchido.
  let initial = currentId;
  try {
    const clip = (await vscode.env.clipboard.readText()).trim();
    if (CLIENT_ID_RE.test(clip)) { initial = clip; }
  } catch { /* sem acesso à área de transferência */ }

  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = t('setup.s3.title');
    box.step = 3;
    box.totalSteps = TOTAL_STEPS;
    box.prompt = t('setup.s3.prompt');
    box.placeholder = t('setup.s3.placeholder');
    box.value = initial;
    box.ignoreFocusOut = true; // o utilizador vai ao browser buscar o ID
    box.buttons = [vscode.QuickInputButtons.Back];

    let done = false;
    const finish = (v: { id: string } | 'back' | 'cancel') => {
      if (done) { return; }
      done = true;
      resolve(v);
      box.hide();
    };

    box.onDidChangeValue((v) => {
      const s = v.trim();
      box.validationMessage = s === '' || CLIENT_ID_RE.test(s) ? undefined : t('setup.s3.invalid');
    });
    box.onDidAccept(() => {
      const s = box.value.trim();
      if (CLIENT_ID_RE.test(s)) {
        finish({ id: s.toLowerCase() });
      } else {
        box.validationMessage = t('setup.s3.invalid');
      }
    });
    box.onDidTriggerButton(() => finish('back'));
    box.onDidHide(() => { finish('cancel'); box.dispose(); });
    box.show();
  });
}

// ---------- utilitário ----------

/** QuickPick de um passo. Devolve o item, 'back' (botão voltar) ou undefined (Esc). */
function pick(step: number, title: string, placeholder: string, items: Item[]): Promise<Item | 'back' | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = title;
    qp.step = step;
    qp.totalSteps = TOTAL_STEPS;
    qp.placeholder = placeholder;
    qp.items = items;
    qp.ignoreFocusOut = true; // não fechar quando o utilizador muda para o browser
    if (step > 1) { qp.buttons = [vscode.QuickInputButtons.Back]; }

    let done = false;
    const finish = (v: Item | 'back' | undefined) => {
      if (done) { return; }
      done = true;
      resolve(v);
      qp.hide();
    };

    qp.onDidAccept(() => finish(qp.selectedItems[0]));
    qp.onDidTriggerButton(() => finish('back'));
    qp.onDidHide(() => { finish(undefined); qp.dispose(); });
    qp.show();
  });
}
