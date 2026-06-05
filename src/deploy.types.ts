export type DeployStatus = 'queued' | 'running' | 'success' | 'failed';
export type StageStatus = 'pending' | 'running' | 'success' | 'failed';

export interface EnvironmentTarget {
  name: string;
  host: string;
  url: string;
}

export interface Project {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  branches: string[];
  environments: EnvironmentTarget[];
  lastRunId?: string;
}

export interface DeployStage {
  name: string;
  status: StageStatus;
  duration: string;
}

export interface DeployLog {
  time: string;
  stage: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface DeployRun {
  id: string;
  projectId: string;
  branch: string;
  deployPath: string;
  environment: string;
  commit: string;
  status: DeployStatus;
  requestedBy: string;
  startedAt: string;
  finishedAt?: string;
  options: {
    migrations: boolean;
    clearCache: boolean;
    dryRun: boolean;
  };
  stages: DeployStage[];
  logs: DeployLog[];
}

export interface CreateDeployInput {
  projectId: string;
  branch: string;
  deployPath?: string;
}
