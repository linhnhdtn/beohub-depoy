import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeployService } from './deploy.service';

interface RecordedCommand {
  command: string;
  args: string[];
  cwd?: string;
  allowFailure?: boolean;
}

describe('DeployService', () => {
  let root: string;
  let workspacePath: string;
  let deployPath: string;
  let commands: RecordedCommand[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'beohub-deploy-'));
    workspacePath = join(root, 'deploy/beohub');
    deployPath = join(root, 'beohub');
    commands = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('clones the repository on the first deploy and publishes a release', async () => {
    const service = createService();

    const run = await service.createDeployAndWait({
      projectId: 'beohub',
      branch: 'main',
      deployPath,
    });

    expect(run.status).toBe('success');
    expect(run.commit).toBe('abc123');
    expect(commandLine(0)).toBe('git clone --branch main git@example.com:beohub.git ' + workspacePath);
    expect(commands.some((item) => item.command === 'rsync')).toBe(true);
    expect(commands.some((item) => item.command === 'npm' && item.args.join(' ') === 'run build')).toBe(true);
    expect(commands.some((item) => item.command === 'pm2' && item.args.join(' ') === 'start ecosystem.config.js --update-env')).toBe(true);
    expect(readlinkSync(join(deployPath, 'current'))).toMatch(join(deployPath, 'releases'));
  });

  it('fetches and resets an existing workspace instead of cloning again', async () => {
    mkdirSync(join(workspacePath, '.git'), { recursive: true });
    const service = createService();

    const run = await service.createDeployAndWait({
      projectId: 'beohub',
      branch: 'main',
      deployPath,
    });

    expect(run.status).toBe('success');
    expect(commands.map((item) => [item.command, ...item.args].join(' '))).toEqual(
      expect.arrayContaining([
        'git fetch origin',
        'git checkout main',
        'git reset --hard origin/main',
      ]),
    );
    expect(commands.some((item) => item.args[0] === 'clone')).toBe(false);
  });

  it('does not publish or restart when build fails', async () => {
    const service = createService({
      failWhen: (command, args) => command === 'npm' && args.join(' ') === 'run build',
    });

    const run = await service.createDeployAndWait({
      projectId: 'beohub',
      branch: 'main',
      deployPath,
    });

    expect(run.status).toBe('failed');
    expect(run.stages.find((stage) => stage.name === 'Build')?.status).toBe('failed');
    expect(existsSync(join(deployPath, 'current'))).toBe(false);
    expect(commands.some((item) => item.command === 'pm2')).toBe(false);
  });

  it('keeps only the configured number of successful releases', async () => {
    const releasesPath = join(deployPath, 'releases');
    mkdirSync(join(releasesPath, '20000101000000'), { recursive: true });
    mkdirSync(join(releasesPath, '20000102000000'), { recursive: true });
    const service = createService({ keepReleases: 2 });

    const run = await service.createDeployAndWait({
      projectId: 'beohub',
      branch: 'main',
      deployPath,
    });

    expect(run.status).toBe('success');
    expect(existsSync(join(releasesPath, '20000101000000'))).toBe(false);
    expect(existsSync(join(releasesPath, '20000102000000'))).toBe(true);
  });

  it('rejects deploy paths outside the configured target', () => {
    const service = createService();

    expect(() =>
      service.createDeploy({
        projectId: 'beohub',
        branch: 'main',
        deployPath: join(root, 'other'),
      }),
    ).toThrow('Deploy path must be');
    expect(commands).toHaveLength(0);
  });

  it('uses the fixed deploy path when the form does not send one', async () => {
    const service = createService();

    const run = await service.createDeployAndWait({
      projectId: 'beohub',
      branch: 'main',
    });

    expect(run.status).toBe('success');
    expect(run.deployPath).toBe(deployPath);
  });

  function createService(options: { failWhen?: (command: string, args: string[]) => boolean; keepReleases?: number } = {}) {
    return new DeployService(
      (command, args, commandOptions = {}) => {
        commands.push({
          command,
          args,
          cwd: commandOptions.cwd,
          allowFailure: commandOptions.allowFailure,
        });

        if (options.failWhen?.(command, args)) {
          return { stdout: '', stderr: 'build failed', status: 1 };
        }

        if (command === 'git' && args.join(' ') === 'rev-parse --short HEAD') {
          return { stdout: 'abc123\n', stderr: '', status: 0 };
        }

        if (command === 'pm2' && args[0] === 'delete') {
          return { stdout: '', stderr: 'not found', status: 1 };
        }

        return { stdout: '', stderr: '', status: 0 };
      },
      {
        repository: 'git@example.com:beohub.git',
        workspacePath,
        deployPath,
        keepReleases: options.keepReleases,
        runInBackground: false,
      },
    );
  }

  function commandLine(index: number) {
    const command = commands[index];
    return [command.command, ...command.args].join(' ');
  }
});
