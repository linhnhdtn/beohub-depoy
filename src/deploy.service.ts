import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CreateDeployInput,
  DeployLog,
  DeployRun,
  DeployStage,
  Project,
} from './deploy.types';

const STAGE_NAMES = ['Checkout', 'Sync', 'Shared', 'Build', 'Publish', 'Restart'];

const RSYNC_EXCLUDES = [
  '.git',
  'node_modules',
  '.env',
  '.env.*',
  'data/*.json',
  'data/*.sqlite',
  'data/*.sqlite-*',
  'public/uploads',
  'log',
  '.agents',
  '.codex',
  '.playwright-mcp',
  '.idea',
  '.DS_Store',
  'Thumbs.db',
  'dist',
];

interface CommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; allowFailure?: boolean },
) => CommandResult | Promise<CommandResult>;

interface DeployServiceConfig {
  repository: string;
  workspacePath: string;
  deployPath: string;
  keepReleases: number;
  runInBackground: boolean;
}

const DEFAULT_CONFIG: DeployServiceConfig = {
  repository: 'git@github.com:hoangdvhp99/beohub.git',
  workspacePath: '/home/ziczac/beohub/deploy/beohub',
  deployPath: '/home/ziczac/beohub',
  keepReleases: 5,
  runInBackground: true,
};

const defaultRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd });
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on('error', (error) => resolve({ stdout: stdout.join(''), stderr: error.message, status: 1 }));
    child.on('close', (code) => resolve({ stdout: stdout.join(''), stderr: stderr.join(''), status: code ?? 1 }));
  });

@Injectable()
export class DeployService {
  private readonly config: DeployServiceConfig;
  private runSequence = 1043;

  private readonly projects: Project[];
  private readonly runs: DeployRun[] = [];

  constructor(
    @Optional()
    @Inject('DEPLOY_COMMAND_RUNNER')
    private readonly runner: CommandRunner = defaultRunner,
    @Optional()
    @Inject('DEPLOY_SERVICE_CONFIG')
    config: Partial<DeployServiceConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...this.compactConfig(config) };
    this.projects = [
      {
        id: 'beohub',
        name: 'Beohub',
        repository: this.config.repository,
        defaultBranch: 'main',
        branches: ['main'],
        environments: [
          {
            name: 'local',
            host: 'localhost',
            url: 'http://localhost:3000',
          },
        ],
      },
    ];
  }

  getDashboard() {
    return this.projects.map((project) => {
      const lastRun = project.lastRunId ? this.findRun(project.lastRunId) : undefined;
      return {
        ...project,
        lastRun,
        statusLabel: lastRun?.status ?? 'idle',
      };
    });
  }

  getProject(id: string) {
    const project = this.projects.find((item) => item.id === id);
    if (!project) {
      throw new NotFoundException(`Project ${id} not found`);
    }

    return {
      ...project,
      runs: this.runs.filter((run) => run.projectId === id),
    };
  }

  getRuns() {
    return [...this.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getLatestRunForProject(projectId: string) {
    return this.runs.find((run) => run.projectId === projectId);
  }

  getRun(id: string) {
    const run = this.findRun(id);
    if (!run) {
      throw new NotFoundException(`Deploy run ${id} not found`);
    }

    return {
      ...run,
      project: this.projects.find((project) => project.id === run.projectId),
    };
  }

  createDeploy(input: CreateDeployInput) {
    const { project, run } = this.createDeployRun(input);

    if (this.config.runInBackground) {
      void this.finishDeploy(run, project.repository);
      return run;
    }

    void this.finishDeploy(run, project.repository);
    return run;
  }

  async createDeployAndWait(input: CreateDeployInput) {
    const { project, run } = this.createDeployRun(input);
    await this.finishDeploy(run, project.repository);
    return run;
  }

  private createDeployRun(input: CreateDeployInput) {
    const project = this.getProject(input.projectId);
    const branch = input.branch.trim() || project.defaultBranch;
    const deployPath = this.resolveDeployPath(input.deployPath);
    const run: DeployRun = {
      id: `D-${this.runSequence++}`,
      projectId: project.id,
      branch,
      deployPath,
      environment: project.environments[0]?.name || 'local',
      commit: 'HEAD',
      status: 'running',
      requestedBy: 'local.user',
      startedAt: new Date().toISOString(),
      options: {
        migrations: false,
        clearCache: false,
        dryRun: false,
      },
      stages: this.createInitialStages(),
      logs: [],
    };

    this.runs.unshift(run);
    this.setProjectLastRun(project.id, run.id);

    return { project, run };
  }

  private async finishDeploy(run: DeployRun, repository: string) {
    try {
      await this.executeDeploy(run, repository);
      run.status = 'success';
      this.markStage(run, 'Restart', 'success');
      this.addLog(run, 'Restart', 'info', 'Deploy completed successfully');
    } catch (error) {
      run.status = 'failed';
      this.failCurrentStage(run);
      this.addLog(run, 'Restart', 'error', error instanceof Error ? error.message : String(error));
    } finally {
      run.finishedAt = new Date().toISOString();
    }
  }

  private async executeDeploy(run: DeployRun, repository: string) {
    const releaseName = this.timestamp();
    const releasesPath = join(run.deployPath, 'releases');
    const releasePath = join(releasesPath, releaseName);

    await this.checkout(run, repository);
    run.commit = (await this.command(run, 'Checkout', 'git', ['rev-parse', '--short', 'HEAD'], {
      cwd: this.config.workspacePath,
    })).stdout.trim() || 'HEAD';

    await this.stage(run, 'Sync', async () => {
      mkdirSync(releasePath, { recursive: true });
      const excludeArgs = RSYNC_EXCLUDES.flatMap((path) => ['--exclude', path]);
      await this.command(run, 'Sync', 'rsync', [
        '-a',
        '--delete',
        ...excludeArgs,
        `${this.config.workspacePath}/`,
        `${releasePath}/`,
      ]);
    });

    await this.stage(run, 'Shared', async () => {
      this.prepareSharedPaths(run.deployPath);
      this.linkSharedPath(releasePath, '.env', join(run.deployPath, 'shared/.env'));
      this.linkSharedPath(releasePath, 'node_modules', join(run.deployPath, 'shared/node_modules'));
      this.linkSharedPath(releasePath, 'data', join(run.deployPath, 'shared/data'));
      this.linkSharedPath(releasePath, 'public/uploads', join(run.deployPath, 'shared/public/uploads'));
      this.addLog(run, 'Shared', 'info', 'Linked .env, node_modules, data, and public/uploads from shared');
    });

    await this.stage(run, 'Build', async () => {
      await this.command(run, 'Build', 'npm', ['install'], { cwd: releasePath });
      await this.command(run, 'Build', 'npm', ['run', 'build'], { cwd: releasePath });
      await this.command(run, 'Build', 'npm', ['prune', '--production'], { cwd: releasePath });
    });

    await this.stage(run, 'Publish', async () => {
      this.publishRelease(run.deployPath, releasePath);
      this.writeRevision(run.deployPath, run.branch, run.commit, releaseName);
      this.pruneReleases(releasesPath, this.config.keepReleases);
      this.addLog(run, 'Publish', 'info', `Published ${releaseName} to current`);
    });

    await this.stage(run, 'Restart', async () => {
      const currentPath = join(run.deployPath, 'current');
      await this.command(run, 'Restart', 'pm2', ['delete', 'beohub'], {
        cwd: currentPath,
        allowFailure: true,
      });
      await this.command(run, 'Restart', 'pm2', ['start', 'ecosystem.config.js', '--update-env'], {
        cwd: currentPath,
      });
      await this.command(run, 'Restart', 'pm2', ['save'], { cwd: currentPath });
    });
  }

  private async checkout(run: DeployRun, repository: string) {
    await this.stage(run, 'Checkout', async () => {
      mkdirSync(dirname(this.config.workspacePath), { recursive: true });

      if (!existsSync(join(this.config.workspacePath, '.git'))) {
        rmSync(this.config.workspacePath, { recursive: true, force: true });
        await this.command(run, 'Checkout', 'git', [
          'clone',
          '--branch',
          run.branch,
          repository,
          this.config.workspacePath,
        ]);
        return;
      }

      await this.command(run, 'Checkout', 'git', ['fetch', 'origin'], { cwd: this.config.workspacePath });
      await this.command(run, 'Checkout', 'git', ['checkout', run.branch], { cwd: this.config.workspacePath });
      await this.command(run, 'Checkout', 'git', ['reset', '--hard', `origin/${run.branch}`], {
        cwd: this.config.workspacePath,
      });
    });
  }

  private async stage(run: DeployRun, name: string, action: () => Promise<void>) {
    const startedAt = Date.now();
    this.markStage(run, name, 'running');
    this.addLog(run, name, 'info', `Starting ${name}`);

    try {
      await action();
      this.markStage(run, name, 'success', this.renderDuration(Date.now() - startedAt));
    } catch (error) {
      this.markStage(run, name, 'failed', this.renderDuration(Date.now() - startedAt));
      throw error;
    }
  }

  private async command(
    run: DeployRun,
    stage: string,
    command: string,
    args: string[],
    options: { cwd?: string; allowFailure?: boolean } = {},
  ) {
    const renderedCommand = [command, ...args].join(' ');
    this.addLog(run, stage, 'info', `$ ${renderedCommand}`);
    const result = await this.runner(command, args, options);
    this.appendCommandOutput(run, stage, result.stdout, 'info');
    this.appendCommandOutput(run, stage, result.stderr, result.status === 0 || options.allowFailure ? 'warn' : 'error');

    if (result.status !== 0 && !options.allowFailure) {
      throw new Error(`${renderedCommand} failed with exit code ${result.status}`);
    }

    if (result.status !== 0 && options.allowFailure) {
      this.addLog(run, stage, 'warn', `${renderedCommand} exited with ${result.status}; continuing`);
    }

    return result;
  }

  private prepareSharedPaths(deployPath: string) {
    mkdirSync(join(deployPath, 'shared/node_modules'), { recursive: true });
    mkdirSync(join(deployPath, 'shared/data'), { recursive: true });
    mkdirSync(join(deployPath, 'shared/public/uploads'), { recursive: true });

    const sharedEnv = join(deployPath, 'shared/.env');
    if (!existsSync(sharedEnv)) {
      mkdirSync(dirname(sharedEnv), { recursive: true });
      writeFileSync(sharedEnv, '', 'utf8');
    }
  }

  private linkSharedPath(releasePath: string, relativePath: string, sharedPath: string) {
    const linkPath = join(releasePath, relativePath);
    rmSync(linkPath, { recursive: true, force: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(sharedPath, linkPath);
  }

  private publishRelease(deployPath: string, releasePath: string) {
    const tmpLink = join(deployPath, 'current.tmp');
    const currentLink = join(deployPath, 'current');

    rmSync(tmpLink, { recursive: true, force: true });
    symlinkSync(releasePath, tmpLink);
    renameSync(tmpLink, currentLink);
  }

  private writeRevision(deployPath: string, branch: string, commit: string, releaseName: string) {
    const logPath = join(deployPath, 'revisions.log');
    const line = `Branch ${branch} (at ${commit}) deployed as release ${releaseName} by local.user\n`;
    writeFileSync(logPath, line, { flag: 'a' });
  }

  private pruneReleases(releasesPath: string, keepReleases: number) {
    if (!existsSync(releasesPath)) {
      return;
    }

    const releases = readdirSync(releasesPath)
      .filter((name) => /^\d{14}$/.test(name))
      .sort()
      .reverse();

    for (const release of releases.slice(keepReleases)) {
      rmSync(join(releasesPath, release), { recursive: true, force: true });
    }
  }

  private appendCommandOutput(run: DeployRun, stage: string, output: string, level: DeployLog['level']) {
    for (const line of output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(-30)) {
      this.addLog(run, stage, level, line);
    }
  }

  private createInitialStages(): DeployStage[] {
    return STAGE_NAMES.map((name) => ({ name, status: 'pending', duration: '-' }));
  }

  private markStage(run: DeployRun, stageName: string, status: DeployStage['status'], duration = '-') {
    const stage = run.stages.find((item) => item.name === stageName);
    if (stage) {
      stage.status = status;
      stage.duration = duration;
    }
  }

  private failCurrentStage(run: DeployRun) {
    const runningStage = run.stages.find((stage) => stage.status === 'running');
    if (runningStage) {
      runningStage.status = 'failed';
    }
  }

  private addLog(run: DeployRun, stage: string, level: DeployLog['level'], message: string) {
    run.logs.push({
      time: new Date().toLocaleTimeString('vi-VN', { hour12: false }),
      stage,
      level,
      message,
    });
  }

  private setProjectLastRun(projectId: string, runId: string) {
    const project = this.projects.find((item) => item.id === projectId);
    if (project) {
      project.lastRunId = runId;
    }
  }

  private findRun(id: string) {
    return this.runs.find((run) => run.id === id);
  }

  private resolveDeployPath(inputPath?: string) {
    const deployPath = inputPath?.trim() || this.config.deployPath;
    if (deployPath !== this.config.deployPath) {
      throw new BadRequestException(`Deploy path must be ${this.config.deployPath}`);
    }

    return deployPath;
  }

  private timestamp() {
    return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  }

  private renderDuration(ms: number) {
    if (ms < 1000) {
      return `${ms}ms`;
    }

    return `${Math.round(ms / 1000)}s`;
  }

  private compactConfig(config: Partial<DeployServiceConfig>) {
    return Object.fromEntries(
      Object.entries(config).filter(([, value]) => value !== undefined),
    ) as Partial<DeployServiceConfig>;
  }
}
