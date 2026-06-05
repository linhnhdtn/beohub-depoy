import { Body, Controller, Get, Param, Post, Query, Redirect, Render } from '@nestjs/common';
import { CreateDeployInput } from './deploy.types';
import { DeployService } from './deploy.service';

@Controller()
export class DeployController {
  constructor(private readonly deployService: DeployService) {}

  @Get()
  @Redirect('/projects/beohub', 302)
  dashboard() {
    return;
  }

  @Get('projects/:id')
  @Render('project')
  project(@Param('id') id: string, @Query('run') runId?: string) {
    const project = this.deployService.getProject(id);
    const selectedRun = runId
      ? this.deployService.getRun(runId)
      : this.deployService.getLatestRunForProject(project.id);

    return {
      title: `${project.name} Deploy`,
      project,
      selectedRun,
    };
  }

  @Post('deploys')
  @Redirect()
  createDeploy(@Body() input: CreateDeployInput) {
    const run = this.deployService.createDeploy(input);
    return { url: `/projects/${run.projectId}#console` };
  }

  @Get('deploys/:id')
  @Render('run')
  run(@Param('id') id: string) {
    const run = this.deployService.getRun(id);

    return {
      title: `${run.id} Deploy Run`,
      active: 'history',
      run,
    };
  }

  @Get('history')
  @Render('history')
  history() {
    return {
      title: 'Deploy History',
      active: 'history',
      runs: this.deployService.getRuns(),
    };
  }
}
