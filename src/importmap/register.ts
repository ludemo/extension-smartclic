import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import type { ProcState, YalcStatus, YalcPendingState } from './provider';
import { ImportMapProvider } from './provider';
import type { LibStatus } from './tree';
import { ImportMapTreeProvider, MfeTreeItem, LibraryTreeItem } from './tree';

const procStates      = new Map<string, ProcState>();
const compilePercents = new Map<string, number>();
const processes       = new Map<string, ChildProcess>();
const outputs         = new Map<string, vscode.OutputChannel>();
const yalcStatuses    = new Map<string, YalcStatus>();
const yalcPending     = new Map<string, YalcPendingState>();
const yalcJustUpdated = new Set<string>();

const libStatus: LibStatus = { state: 'idle', percent: undefined, hasDir: false, sbState: undefined, sbRunning: null, sbPercent: undefined };
let   libDir: string | null = null;
let   libOutput: vscode.OutputChannel | null = null;
let   libBuildProcess: ReturnType<typeof spawn> | null = null;

let sbProcess: ReturnType<typeof spawn> | null = null;
let sbOutput:  vscode.OutputChannel | null = null;

const SB_PORT = 6006;

function isTcpPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

const LIB_PKG_NAME = '@erp-mf/erp2-components-vue';
const LIB_DIR_NAMES = ['erp2-componentes-vue', 'erp2-components-vue'];
const DIR_NAMES: Record<string, string> = {
  'erp-mf-styles':   'erp-mf-estilos',
  'erp-mf-security': 'erp-mf-seguridad',
  'erp-mf-common':   'erp-mf-comun',
};
// ── Buscar directorios ────────────────────────────────────────────────────────

async function findMfeDir(shortName: string, mfeBase?: string | null): Promise<string | null> {
  const dirName = DIR_NAMES[shortName] ?? shortName;
  const found = await vscode.workspace.findFiles(`**/${dirName}/package.json`, '**/node_modules/**', 1);
  if (found.length) { return path.dirname(found[0].fsPath); }

  const bases: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    bases.push(path.dirname(folder.uri.fsPath));
  }
  if (mfeBase && !bases.includes(mfeBase)) { bases.push(mfeBase); }

  for (const base of bases) {
    const candidate = path.join(base, dirName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) { return candidate; }
  }
  return null;
}

async function findLibraryDir(): Promise<string | null> {
  for (const dirName of LIB_DIR_NAMES) {
    const found = await vscode.workspace.findFiles(`**/${dirName}/package.json`, '**/node_modules/**', 1);
    if (found.length) { return path.dirname(found[0].fsPath); }
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      const parent = path.dirname(folder.uri.fsPath);
      for (const dirName of LIB_DIR_NAMES) {
        const candidate = path.join(parent, dirName);
        if (fs.existsSync(path.join(candidate, 'package.json'))) { return candidate; }
      }
    }
  }
  return null;
}

// ── Yalc status por MFE ───────────────────────────────────────────────────────

function readYalcStatus(mfeDir: string): YalcStatus {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(mfeDir, 'package.json'), 'utf8'));
    const dep = pkg.dependencies?.[LIB_PKG_NAME] ?? pkg.devDependencies?.[LIB_PKG_NAME];
    if (!dep) { return 'none'; }
    return dep.startsWith('file:') ? 'yalc' : 'nexus';
  } catch { return 'none'; }
}

async function refreshYalcStatuses(provider: ImportMapProvider): Promise<void> {
  const mfeBase = provider.mfeBaseDir;
  await Promise.all(provider.getEntries().map(async e => {
    const dir = await findMfeDir(e.shortName, mfeBase);
    yalcStatuses.set(e.shortName, dir ? readYalcStatus(dir) : 'none');
  }));
}

// ── MFE: spawn / kill ────────────────────────────────────────────────────────

function getStartCommand(shortName: string): string {
  if (shortName === 'erp-mf-root-config' || shortName === 'erp-mf-common') {
    return 'npm run start';
  }
  return 'npm run serve';
}

function spawnMfe(shortName: string, dir: string, cmd: string, onUpdate: () => void): void {
  let output = outputs.get(shortName);
  if (!output) {
    output = vscode.window.createOutputChannel(`MFE: ${shortName}`);
    outputs.set(shortName, output);
  }
  output.clear();
  procStates.set(shortName, 'compiling');
  onUpdate();

  const [exe, ...args] = cmd.split(' ');
  const child = spawn(exe, args, { cwd: dir, shell: true });
  processes.set(shortName, child);
  const handle = (data: Buffer) => {
    const text = stripAnsi(data.toString());
    output!.append(text);
    const prev = procStates.get(shortName);
    let next: ProcState | undefined;

    if (
      // webpack / vue-cli
      /App running at:|compiled successfully|DONE\s+Compiled/i.test(text) ||
      // Vite
      /ready in \d+|Local:\s+https?:\/\//i.test(text) ||
      // Rsbuild / Rspack
      /build success|server running at/i.test(text)
    ) {
      next = 'running';
    } else if (
      /WAIT\s+Compiling|Compiling\.\.\.|Recompiling/i.test(text) ||
      // Vite / Rsbuild rebuilding
      /hmr update|page reload|rebuilding/i.test(text)
    ) {
      next = 'compiling';
    } else if (/Failed to compile|ERROR in|ERROR\s+Failed|Build failed/i.test(text)) {
      next = 'error';
    }
    if (next && next !== prev) {
      procStates.set(shortName, next);
      if (next !== 'compiling') { compilePercents.delete(shortName); }
      onUpdate();
    }
    if (procStates.get(shortName) === 'compiling') {
      const m = text.match(/\b(\d{1,3})%/);
      if (m) {
        const pct = parseInt(m[1], 10);
        if (pct !== compilePercents.get(shortName)) {
          compilePercents.set(shortName, pct);
          onUpdate();
        }
      }
    }
  };

  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);

  child.on('close', () => {
    processes.delete(shortName);
    procStates.delete(shortName);
    compilePercents.delete(shortName);
    onUpdate();
  });
}

function killMfe(shortName: string, onUpdate: () => void): Promise<void> {
  const child = processes.get(shortName);
  if (!child) { return Promise.resolve(); }

  procStates.set(shortName, 'stopping');
  onUpdate();

  return new Promise<void>(resolve => {
    child.once('close', resolve);
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { shell: true });
    } else {
      child.kill('SIGTERM');
    }
  });
}

async function killExternalMfe(shortName: string, currentUrl: string): Promise<void> {
  const match = currentUrl.match(/:(\d+)/);
  if (!match) {
    vscode.window.showWarningMessage(`No se pudo determinar el puerto de ${shortName}.`);
    return;
  }
  const port = match[1];
  await new Promise<void>(resolve => {
    const [cmd, ...args] = process.platform === 'win32'
      ? ['powershell', '-Command', `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue`]
      : ['bash', '-c', `kill -9 $(lsof -ti :${port}) 2>/dev/null`];
    spawn(cmd, args).on('close', resolve);
  });
}

// ── Librería: build + yalc publish ───────────────────────────────────────────

function getLibOutput(): vscode.OutputChannel {
  if (!libOutput) {
    libOutput = vscode.window.createOutputChannel('Librería: erp2-components-vue');
  }
  return libOutput;
}

function stopLibraryBuild(onUpdate: () => void): void {
  if (!libBuildProcess) { return; }
  const proc = libBuildProcess;
  libBuildProcess = null;
  libStatus.state = 'idle';
  libStatus.percent = undefined;
  onUpdate();
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { shell: true });
  } else {
    proc.kill('SIGTERM');
  }
}

function buildAndPublishLibrary(onUpdate: () => void): void {
  if (!libDir) { return; }
  if (libStatus.state === 'building') { return; }

  libStatus.state = 'building';
  libStatus.percent = undefined;
  onUpdate();

  const out = getLibOutput();
  out.clear();

  const build = spawn('npm', ['run', 'build:library-dev'], { cwd: libDir, shell: true });
  libBuildProcess = build;

  const handle = (data: Buffer) => {
    const text = stripAnsi(data.toString());
    out.append(text);
    const m = text.match(/\b(\d{1,3})%/);
    if (m) {
      libStatus.percent = parseInt(m[1], 10);
      onUpdate();
    }
  };

  build.stdout?.on('data', handle);
  build.stderr?.on('data', handle);

  build.on('close', code => {
    const wasAborted = libBuildProcess !== build;
    libBuildProcess = null;
    if (code !== 0) {
      if (!wasAborted) {
        libStatus.state = 'idle';
        libStatus.percent = undefined;
        vscode.window.showErrorMessage('Error al compilar la librería.');
        onUpdate();
      }
      return;
    }

    out.appendLine('\n▶ Ejecutando yalc publish...');
    const yalc = spawn('yalc', ['publish'], { cwd: libDir!, shell: true });
    yalc.stdout?.on('data', d => out.append(stripAnsi(d.toString())));
    yalc.stderr?.on('data', d => out.append(stripAnsi(d.toString())));
    yalc.on('close', yalcCode => {
      if (yalcCode === 0) {
        libStatus.state = 'published';
        out.appendLine('✔ Publicado en yalc');
      } else {
        libStatus.state = 'idle';
        vscode.window.showErrorMessage('Error al ejecutar yalc publish.');
      }
      libStatus.percent = undefined;
      onUpdate();
    });
  });
}

// ── Storybook ─────────────────────────────────────────────────────────────────

function getSbOutput(): vscode.OutputChannel {
  if (!sbOutput) {
    sbOutput = vscode.window.createOutputChannel('Storybook: erp2-components-vue');
  }
  return sbOutput;
}

function checkStorybookPort(onUpdate: () => void): void {
  if (sbProcess) { return; } // proceso gestionado — su propio handler actualiza el estado
  isTcpPortOpen(SB_PORT).then(reachable => {
    if (libStatus.sbRunning !== reachable) {
      libStatus.sbRunning = reachable;
      onUpdate();
    }
  });
}

function spawnStorybook(onUpdate: () => void): void {
  if (!libDir || sbProcess) { return; }

  isTcpPortOpen(SB_PORT).then(reachable => {
    if (reachable) {
      libStatus.sbRunning = true;
      onUpdate();
      vscode.window.showInformationMessage(`Storybook ya está corriendo en localhost:${SB_PORT}.`);
      return;
    }

    const dir = libDir!;
    const out = getSbOutput();
    out.clear();
    out.show();

    libStatus.sbState = 'compiling';
    libStatus.sbRunning = null;
    onUpdate();

    const child = spawn('npm', ['run', 'storybook'], { cwd: dir, shell: true });
    sbProcess = child;

    const handle = (data: Buffer) => {
      const text = stripAnsi(data.toString());
      out.append(text);
      const prev = libStatus.sbState;
      let next: ProcState | undefined;

      if (/storybook.*started|local:\s*https?:\/\/|on your network:\s*https?:\/\//i.test(text)) {
        next = 'running';
      } else if (/building storybook|storybook builder|compiling/i.test(text)) {
        next = 'compiling';
      } else if (/ERR_STORYBOOK|build failed|failed to compile|error command failed/i.test(text)) {
        next = 'error';
      }

      if (next && next !== prev) {
        libStatus.sbState = next;
        if (next !== 'compiling') { libStatus.sbPercent = undefined; }
        onUpdate();
      }
      if (libStatus.sbState === 'compiling') {
        const m = text.match(/\b(\d{1,3})%/);
        if (m) {
          const pct = parseInt(m[1], 10);
          if (pct !== libStatus.sbPercent) {
            libStatus.sbPercent = pct;
            onUpdate();
          }
        }
      }
    };

    child.stdout?.on('data', handle);
    child.stderr?.on('data', handle);

    child.on('close', () => {
      sbProcess = null;
      libStatus.sbState = undefined;
      libStatus.sbPercent = undefined;
      onUpdate();
      checkStorybookPort(onUpdate);
    });
  });
}

async function killExternalStorybook(onUpdate: () => void): Promise<void> {
  await new Promise<void>(resolve => {
    const [cmd, ...args] = process.platform === 'win32'
      ? ['powershell', '-Command', `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${SB_PORT} -ErrorAction SilentlyContinue).OwningProcess -Force -ErrorAction SilentlyContinue`]
      : ['bash', '-c', `kill -9 $(lsof -ti :${SB_PORT}) 2>/dev/null`];
    spawn(cmd, args).on('close', resolve);
  });
  libStatus.sbRunning = false;
  onUpdate();
}

function killStorybook(onUpdate: () => void): void {
  if (!sbProcess) { return; }
  libStatus.sbState = 'stopping';
  onUpdate();
  const child = sbProcess;
  child.once('close', () => {
    sbProcess = null;
    libStatus.sbState = undefined;
    onUpdate();
  });
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { shell: true });
  } else {
    child.kill('SIGTERM');
  }
}

// ── Yalc en MFE ──────────────────────────────────────────────────────────────

function runYalcInMfe(mfeDir: string, args: string[], onDone: () => void): void {
  const out = getLibOutput();
  out.appendLine(`\n▶ yalc ${args.join(' ')} en ${path.basename(mfeDir)}`);
  const child = spawn('yalc', args, { cwd: mfeDir, shell: true });
  child.stdout?.on('data', d => out.append(d.toString()));
  child.stderr?.on('data', d => out.append(d.toString()));
  child.on('close', code => {
    if (code !== 0) { vscode.window.showErrorMessage(`Error al ejecutar yalc ${args[0]}.`); }
    onDone();
  });
}

function cleanAndReinstall(mfeDir: string, onDone: () => void): void {
  const out = getLibOutput();
  out.appendLine('\n▶ Limpiando node_modules...');
  try {
    fs.rmSync(path.join(mfeDir, 'node_modules'), { recursive: true, force: true });
  } catch {
    out.appendLine('⚠ No se pudo eliminar node_modules.');
  }
  out.appendLine('▶ npm install...');
  const install = spawn('npm', ['install'], { cwd: mfeDir, shell: true });
  install.stdout?.on('data', d => out.append(d.toString()));
  install.stderr?.on('data', d => out.append(d.toString()));
  install.on('close', code => {
    if (code !== 0) { vscode.window.showErrorMessage('Error en npm install tras yalc remove.'); }
    else { out.appendLine('✓ node_modules reinstalado.'); }
    onDone();
  });
}

// ── Registro principal ────────────────────────────────────────────────────────

export function registerImportMapView(context: vscode.ExtensionContext): void {
  const provider     = new ImportMapProvider();
  const treeProvider = new ImportMapTreeProvider(provider, procStates, compilePercents, yalcStatuses, libStatus, yalcPending, yalcJustUpdated);

  const treeView = vscode.window.createTreeView('smartclic.importmapView', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  let importmapWatcher: vscode.FileSystemWatcher | undefined;

  const initAll = async () => {
    await provider.init();

    // Recrear watcher apuntando al directorio real (puede ser hermano, fuera del workspace)
    importmapWatcher?.dispose();
    if (provider.activeFilePath) {
      const dir = vscode.Uri.file(path.dirname(provider.activeFilePath));
      importmapWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, 'importmap.json')
      );
      importmapWatcher.onDidChange(() => treeProvider.refresh());
    }

    await refreshYalcStatuses(provider);
    libDir = await findLibraryDir();
    libStatus.hasDir = libDir !== null;
    treeProvider.refresh();
    checkStorybookPort(() => treeProvider.refresh());
  };

  initAll();

  context.subscriptions.push(
    treeView,
    { dispose: () => importmapWatcher?.dispose() },

    vscode.commands.registerCommand('smartclic.importmap.refresh', () => { initAll(); }),

    vscode.commands.registerCommand('smartclic.importmap.toggleIp', () => {
      if (!provider.detectedIPv4) {
        vscode.window.showWarningMessage('No se detectó una IPv4 de red en este equipo.');
        return;
      }
      provider.useIPv4 = !provider.useIPv4;
      provider.applyIpMode();
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('smartclic.importmap.toggle', (item: unknown) => {
      const entry = (item as MfeTreeItem)?.entry;
      if (!entry) { return; }

      if (entry.status === 'local') {
        if (!entry.devUrl) {
          vscode.window.showWarningMessage(`${entry.shortName} no tiene URL en importmap-dev.json`);
          return;
        }
        provider.setEntry(entry.name, entry.devUrl);
      } else if (entry.localUrl) {
        provider.setEntry(entry.name, provider.localUrl(entry.localUrl));
      } else if (entry.devUrl) {
        provider.setEntry(entry.name, entry.devUrl);
      } else {
        vscode.window.showWarningMessage(`${entry.shortName} no tiene URL configurada.`);
        return;
      }

      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('smartclic.importmap.allLocal', () => {
      provider.setAll('local');
      treeProvider.refresh();
      vscode.window.showInformationMessage('Todos los MFEs cambiados a local.');
    }),

    vscode.commands.registerCommand('smartclic.importmap.allDev', () => {
      provider.setAll('dev');
      treeProvider.refresh();
      vscode.window.showInformationMessage('Todos los MFEs cambiados a dev.');
    }),

    vscode.commands.registerCommand('smartclic.importmap.startMfe', async (item: unknown) => {
      const entry = (item as MfeTreeItem)?.entry;
      if (!entry) { return; }
      if (processes.has(entry.shortName)) {
        outputs.get(entry.shortName)?.show();
        return;
      }
      const dir = await findMfeDir(entry.shortName, provider.mfeBaseDir);
      if (!dir) {
        vscode.window.showWarningMessage(`No se encontró el directorio de ${entry.shortName}.`);
        return;
      }
      spawnMfe(entry.shortName, dir, getStartCommand(entry.shortName), () => treeProvider.refresh());
    }),

    vscode.commands.registerCommand('smartclic.importmap.showOutput', (item: unknown) => {
      const entry = (item as MfeTreeItem)?.entry;
      if (!entry?.shortName) {
        vscode.window.showWarningMessage('Ver logs: no se pudo identificar el MFE.');
        return;
      }
      const out = outputs.get(entry.shortName);
      if (out) {
        out.show();
      } else {
        vscode.window.showInformationMessage(`${entry.shortName}: no hay logs — inicia el MFE con ▷ primero para capturar logs.`);
      }
    }),

    vscode.commands.registerCommand('smartclic.importmap.stopMfe', async (item: unknown) => {
      const entry = (item as MfeTreeItem)?.entry;
      if (!entry) { return; }
      if (processes.has(entry.shortName)) {
        killMfe(entry.shortName, () => treeProvider.refresh());
      } else {
        await killExternalMfe(entry.shortName, entry.currentUrl);
        treeProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('smartclic.importmap.killExternal', async (item: unknown) => {
      const entry = (item as MfeTreeItem)?.entry;
      if (!entry) { return; }
      await killExternalMfe(entry.shortName, entry.currentUrl);
      treeProvider.refresh();
    }),

    // ── Librería ──────────────────────────────────────────────────────────────

    vscode.commands.registerCommand('smartclic.importmap.buildLibrary', (_item: LibraryTreeItem) => {
      if (!libDir) {
        vscode.window.showWarningMessage('No se encontró el repositorio de erp2-components-vue.');
        return;
      }
      buildAndPublishLibrary(() => treeProvider.refresh());
    }),

    vscode.commands.registerCommand('smartclic.importmap.stopBuildLibrary', () => {
      stopLibraryBuild(() => treeProvider.refresh());
    }),

    // ── Storybook ────────────────────────────────────────────────────────────

    vscode.commands.registerCommand('smartclic.importmap.startStorybook', () => {
      if (!libDir) {
        vscode.window.showWarningMessage('No se encontró el repositorio de la librería.');
        return;
      }
      spawnStorybook(() => treeProvider.refresh());
    }),

    vscode.commands.registerCommand('smartclic.importmap.stopStorybook', async () => {
      if (sbProcess) {
        killStorybook(() => treeProvider.refresh());
      } else {
        await killExternalStorybook(() => treeProvider.refresh());
      }
    }),

    vscode.commands.registerCommand('smartclic.importmap.showStorybookOutput', () => {
      if (sbOutput) {
        sbOutput.show();
      } else {
        vscode.window.showInformationMessage('No hay logs de Storybook — iniciá el servidor primero.');
      }
    }),

    // ── Yalc por MFE ─────────────────────────────────────────────────────────

    vscode.commands.registerCommand('smartclic.importmap.yalcAdd', async (item: unknown) => {
      const { shortName } = (item as MfeTreeItem)?.entry ?? {};
      if (!shortName) { return; }
      const dir = await findMfeDir(shortName, provider.mfeBaseDir);
      if (!dir) { vscode.window.showWarningMessage(`No se encontró el directorio de ${shortName}.`); return; }

      if (processes.has(shortName)) {
        await killMfe(shortName, () => treeProvider.refresh());
      }

      yalcPending.set(shortName, 'adding');
      treeProvider.refresh();
      runYalcInMfe(dir, ['add', LIB_PKG_NAME], async () => {
        yalcPending.delete(shortName);
        await refreshYalcStatuses(provider);
        spawnMfe(shortName, dir, getStartCommand(shortName), () => treeProvider.refresh());
        treeProvider.refresh();
      });
    }),

    vscode.commands.registerCommand('smartclic.importmap.yalcUpdate', async (item: unknown) => {
      const { shortName } = (item as MfeTreeItem)?.entry ?? {};
      if (!shortName) { return; }
      const dir = await findMfeDir(shortName, provider.mfeBaseDir);
      if (!dir) { vscode.window.showWarningMessage(`No se encontró el directorio de ${shortName}.`); return; }

      if (processes.has(shortName)) {
        await killMfe(shortName, () => treeProvider.refresh());
      }

      yalcPending.set(shortName, 'updating');
      treeProvider.refresh();
      runYalcInMfe(dir, ['update', LIB_PKG_NAME], async () => {
        yalcPending.delete(shortName);
        yalcJustUpdated.add(shortName);
        await refreshYalcStatuses(provider);
        spawnMfe(shortName, dir, getStartCommand(shortName), () => treeProvider.refresh());
        treeProvider.refresh();
        setTimeout(() => { yalcJustUpdated.delete(shortName); treeProvider.refresh(); }, 3000);
      });
    }),

    vscode.commands.registerCommand('smartclic.importmap.yalcRemove', async (item: unknown) => {
      const { shortName } = (item as MfeTreeItem)?.entry ?? {};
      if (!shortName) { return; }
      const dir = await findMfeDir(shortName, provider.mfeBaseDir);
      if (!dir) { vscode.window.showWarningMessage(`No se encontró el directorio de ${shortName}.`); return; }
      yalcPending.set(shortName, 'removing');
      treeProvider.refresh();
      runYalcInMfe(dir, ['remove', LIB_PKG_NAME], () => {
        cleanAndReinstall(dir, async () => {
          yalcPending.delete(shortName);
          await refreshYalcStatuses(provider);
          treeProvider.refresh();
        });
      });
    }),
  );
}
