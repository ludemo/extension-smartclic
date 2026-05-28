import * as vscode from 'vscode';
import type { MfeEntry, ProcState, LibState, YalcStatus, YalcPendingState } from './provider';
import { ImportMapProvider, isPortReachable, lastImportmapSearchRoots } from './provider';

const COLOR_LOCAL     = new vscode.ThemeColor('charts.green');
const COLOR_COMPILING = new vscode.ThemeColor('charts.yellow');
const COLOR_OFFLINE   = new vscode.ThemeColor('charts.red');
const COLOR_DEV       = new vscode.ThemeColor('charts.blue');
const COLOR_UNKNOWN   = new vscode.ThemeColor('charts.yellow');

interface DisplayEntry extends MfeEntry {
  procState: ProcState | undefined;
  compilePercent: number | undefined;
  yalcStatus: YalcStatus;
  yalcPending: YalcPendingState | undefined;
  yalcJustUpdated: boolean;
}
export interface LibStatus {
  state: LibState;
  percent: number | undefined;
  hasDir: boolean;
  sbState: ProcState | undefined;
  sbRunning: boolean | null; // null = not checked yet
  sbPercent: number | undefined;
}

export class LibraryTreeItem extends vscode.TreeItem {
  constructor(status: LibStatus) {
    super('erp2-components-vue', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'library';

    if (!status.hasDir) {
      this.iconPath = new vscode.ThemeIcon('package');
      this.description = 'repositorio no encontrado';
      return;
    }

    if (status.state === 'building') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', COLOR_COMPILING);
      this.description = status.percent !== undefined
        ? `compilando... ${status.percent}%`
        : 'compilando...';
      this.contextValue = 'library-building';
    } else if (status.state === 'published') {
      this.iconPath = new vscode.ThemeIcon('pass', COLOR_LOCAL);
      this.description = 'publicado en yalc ✔';
      this.contextValue = 'library-published';
    } else {
      this.iconPath = new vscode.ThemeIcon('package');
      this.description = 'sin publicar';
    }

    if (status.sbState === 'compiling' || status.sbState === 'stopping') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', COLOR_COMPILING);
      const sbPct = status.sbPercent !== undefined ? ` ${status.sbPercent}%` : '';
      this.description = (this.description ?? '') + ` · storybook${sbPct} ⟳`;
      this.contextValue += status.sbState === 'stopping' ? '-sb-stopping' : '-sb-hasprocess';
    } else if (status.sbState === 'running') {
      this.iconPath = new vscode.ThemeIcon('pass', COLOR_LOCAL);
      this.description = (this.description ?? '') + ' · storybook ✔';
      this.contextValue += '-sb-hasprocess';
    } else if (status.sbState === 'error') {
      this.iconPath = new vscode.ThemeIcon('error', COLOR_OFFLINE);
      this.description = (this.description ?? '') + ' · storybook ✗';
      this.contextValue += '-sb-hasprocess';
    } else if (status.sbRunning === true) {
      this.iconPath = new vscode.ThemeIcon('pass', COLOR_LOCAL);
      this.description = (this.description ?? '') + ' · storybook ✔';
      this.contextValue += '-sb-external';
    } else {
      this.contextValue += '-sb-offline';
    }
  }
}

export class MfeTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: DisplayEntry) {
    super(entry.shortName, vscode.TreeItemCollapsibleState.None);
    const urlLabel = entry.status === 'local' ? 'Local' : entry.status === 'dev' ? 'Dev' : 'Personalizado';
    this.tooltip = entry.currentUrl ? `${urlLabel}: ${entry.currentUrl}` : entry.shortName;

    let cv = 'mfe';
    let yalcSuffix = '';
    if (entry.status === 'local') {
      const pending = entry.yalcPending;
      // Solo mostrar botones de yalc cuando el proceso está estable (no compilando ni deteniendo)
      const procStable = entry.procState !== 'compiling' && entry.procState !== 'stopping';
      if (pending === 'adding') {
        yalcSuffix = ' · conectando...';
      } else if (pending === 'updating') {
        yalcSuffix = ' · actualizando...';
      } else if (pending === 'removing') {
        yalcSuffix = ' · desconectando...';
      } else if (entry.yalcJustUpdated) {
        yalcSuffix = ' · actualizado ✔';
        if (procStable) { cv += '-yalc'; }
      } else if (entry.yalcStatus === 'yalc') {
        yalcSuffix = ' · yalc';
        if (procStable) { cv += '-yalc'; }
      } else if (entry.yalcStatus === 'nexus') {
        yalcSuffix = ' · nexus';
        if (procStable) { cv += '-nexus'; }
      }
    }

    if (entry.status === 'local') {
      const proc = entry.procState;

      if (proc === 'stopping') {
        this.iconPath = new vscode.ThemeIcon('sync~spin', COLOR_COMPILING);
        this.description = 'deteniendo...';
        cv += '-local'; // sin hasprocess ni cantoggle → todos los botones ocultos
      } else if (proc === 'compiling') {
        this.iconPath = new vscode.ThemeIcon('sync~spin', COLOR_COMPILING);
        const pct = entry.compilePercent;
        this.description = pct !== undefined ? `compilando... ${pct}%` : 'compilando...';
        cv += '-local-hasprocess';
      } else if (proc === 'running') {
        this.iconPath = new vscode.ThemeIcon('pass', COLOR_LOCAL);
        this.description = 'running';
        cv += '-local-hasprocess';
      } else if (proc === 'error') {
        this.iconPath = new vscode.ThemeIcon('error', COLOR_OFFLINE);
        this.description = 'error';
        cv += '-local-hasprocess';
      } else if (entry.isRunning === true) {
        this.iconPath = new vscode.ThemeIcon('pass', COLOR_LOCAL);
        this.description = 'running';
        cv += '-local-hasprocess';
      } else if (entry.isRunning === false) {
        this.iconPath = new vscode.ThemeIcon('circle-slash', COLOR_OFFLINE);
        this.description = 'offline';
        cv += '-local-offline';
      } else {
        this.iconPath = new vscode.ThemeIcon('radio-button-on', COLOR_LOCAL);
        this.description = 'local';
        cv += '-local';
      }

      if (proc !== 'stopping' && entry.devUrl) { cv += '-cantoggle'; }

    } else if (entry.status === 'dev') {
      this.iconPath = new vscode.ThemeIcon('radio-button-off', COLOR_DEV);
      this.description = 'dev';
      cv += '-dev';
      if (entry.localUrl) { cv += '-cantoggle'; }
    } else {
      this.iconPath = new vscode.ThemeIcon('question', COLOR_UNKNOWN);
      this.description = 'personalizado';
      cv += '-unknown';
      if (entry.localUrl || entry.devUrl) { cv += '-cantoggle'; }
    }

    if (yalcSuffix) {
      this.description = (this.description ?? '') + yalcSuffix;
    }

    this.contextValue = cv;
  }
}

class IpModeItem extends vscode.TreeItem {
  constructor(useIPv4: boolean, ipv4: string | null) {
    super(useIPv4 && ipv4 ? `IPv4: ${ipv4}` : 'localhost', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'ipMode';
    this.iconPath = new vscode.ThemeIcon('vm-connect');
    this.description = useIPv4 ? '— click para usar localhost' : '— click para usar IPv4 de red';
    this.tooltip = ipv4 ?? 'IPv4 no detectada';
  }
}

class LoadingItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('loading~spin');
  }
}

export class ImportMapTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  private loading = true;
  private runningStatus = new Map<string, boolean>();
  private checking = false;

  constructor(
    private readonly provider: ImportMapProvider,
    private readonly procStates: Map<string, ProcState>,
    private readonly compilePercents: Map<string, number>,
    private readonly yalcStatuses: Map<string, YalcStatus>,
    private readonly libStatus: LibStatus,
    private readonly yalcPending: Map<string, YalcPendingState>,
    private readonly yalcJustUpdated: Set<string>,
  ) {}

  refresh(): void {
    this.loading = false;
    this._onChange.fire();
    this.startPortCheck();
  }

  private startPortCheck(): void {
    if (this.checking) { return; }
    this.checking = true;
    const localEntries = this.provider.getEntries().filter(e => e.status === 'local');
    Promise.all(
      localEntries.map(e =>
        isPortReachable(e.currentUrl).then(ok => [e.name, ok] as [string, boolean])
      )
    ).then(results => {
      this.runningStatus.clear();
      for (const [name, ok] of results) { this.runningStatus.set(name, ok); }
      this.checking = false;
      this._onChange.fire();
    });
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
    if (this.loading) {
      return [new LoadingItem('Buscando importmap...')];
    }

    if (!this.provider.ready) {
      const item = new vscode.TreeItem('importmap-local.json no encontrado');
      item.iconPath = new vscode.ThemeIcon('warning');
      const roots = lastImportmapSearchRoots.length
        ? lastImportmapSearchRoots.join('\n')
        : '(sin workspace abierto)';
      item.tooltip = new vscode.MarkdownString(`**Buscado en:**\n\`\`\`\n${roots}\n\`\`\``);
      return [item];
    }

    const entries: DisplayEntry[] = this.provider.getEntries().map(e => ({
      ...e,
      isRunning: e.status === 'local'
        ? (this.runningStatus.has(e.name) ? this.runningStatus.get(e.name)! : null)
        : null,
      procState: this.procStates.get(e.shortName),
      compilePercent: this.compilePercents.get(e.shortName),
      yalcStatus: this.yalcStatuses.get(e.shortName) ?? 'none',
      yalcPending: this.yalcPending.get(e.shortName),
      yalcJustUpdated: this.yalcJustUpdated.has(e.shortName),
    }));

    const ipItem   = new IpModeItem(this.provider.useIPv4, this.provider.detectedIPv4);
    const libItem  = new LibraryTreeItem(this.libStatus);
    const mfeItems = entries.map(e => new MfeTreeItem(e));

    const managed    = mfeItems.filter(i => i.entry.procState !== undefined);
    const compiling  = managed.filter(i => i.entry.procState === 'compiling').length;
    const errored    = managed.filter(i => i.entry.procState === 'error').length;
    const procRun    = managed.filter(i => i.entry.procState === 'running').length;
    const extRun     = mfeItems.filter(i => !i.entry.procState && i.entry.isRunning === true).length;
    const offline    = mfeItems.filter(i => !i.entry.procState && i.entry.isRunning === false).length;
    const devCount   = mfeItems.filter(i => i.entry.status === 'dev').length;

    const parts: string[] = [];
    if (procRun + extRun) { parts.push(`${procRun + extRun} running`); }
    if (compiling)        { parts.push(`${compiling} compilando`); }
    if (errored)          { parts.push(`${errored} error`); }
    if (offline)          { parts.push(`${offline} offline`); }
    if (devCount)         { parts.push(`${devCount} dev`); }
    if (this.checking && !this.runningStatus.size) { parts.push('verificando...'); }

    const summary = new vscode.TreeItem(
      parts.length ? parts.join(' · ') : 'Sin MFEs locales',
      vscode.TreeItemCollapsibleState.None,
    );
    summary.iconPath = new vscode.ThemeIcon('list-unordered');
    summary.contextValue = 'summary';

    return [ipItem, libItem, summary, ...mfeItems];
  }
}
