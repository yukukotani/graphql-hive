import { Injectable, Inject, Scope } from 'graphql-modules';
import lodash from 'lodash';
import type { Span } from '@sentry/types';
import { Schema, Target, Project, ProjectType } from '../../../shared/entities';
import * as Types from '../../../__generated__/types';
import { ProjectManager } from '../../project/providers/project-manager';
import { Logger } from '../../shared/providers/logger';
import { SchemaManager } from './schema-manager';
import { sentry } from '../../../shared/sentry';
import type { TargetSelector } from '../../shared/providers/storage';
import { IdempotentRunner } from '../../shared/providers/idempotent-runner';
import { bolderize } from '../../../shared/markdown';
import { AlertsManager } from '../../alerts/providers/alerts-manager';
import { TargetManager } from '../../target/providers/target-manager';
import { CdnProvider } from '../../cdn/providers/cdn.provider';
import { OrganizationManager } from '../../organization/providers/organization-manager';
import { AuthManager } from '../../auth/providers/auth-manager';
import { TargetAccessScope } from '../../auth/providers/target-access';
import { GitHubIntegrationManager } from '../../integrations/providers/github-integration-manager';
import type { SchemaModuleConfig } from './config';
import { SCHEMA_MODULE_CONFIG } from './config';
import { ensureCompositeSchemas, onlySchemasWithSDL, isAddedOrModified, SchemaHelper } from './schema-helper';
import { Conclusion } from './models/shared';
import { CompositeModel } from './models/composite';
import { SingleModel } from './models/single';
import { HiveError } from '../../../shared/errors';

export type CheckInput = Omit<Types.SchemaCheckInput, 'project' | 'organization' | 'target'> & TargetSelector;

export type PublishInput = Types.SchemaPublishInput &
  TargetSelector & {
    checksum: string;
    isSchemaPublishMissingUrlErrorSelected: boolean;
  };

export type DeleteInput = Types.SchemaDeleteInput & TargetSelector;

type BreakPromise<T> = T extends Promise<infer U> ? U : never;

type PublishResult = BreakPromise<ReturnType<SchemaPublisher['internalPublish']>>;

@Injectable({
  scope: Scope.Operation,
})
export class SchemaPublisher {
  private logger: Logger;

  constructor(
    logger: Logger,
    private authManager: AuthManager,
    private schemaManager: SchemaManager,
    private targetManager: TargetManager,
    private projectManager: ProjectManager,
    private organizationManager: OrganizationManager,
    private alertsManager: AlertsManager,
    private cdn: CdnProvider,
    private gitHubIntegrationManager: GitHubIntegrationManager,
    private idempotentRunner: IdempotentRunner,
    private helper: SchemaHelper,
    private composite: CompositeModel,
    private single: SingleModel,
    @Inject(SCHEMA_MODULE_CONFIG) private schemaModuleConfig: SchemaModuleConfig
  ) {
    this.logger = logger.child({ service: 'SchemaPublisher' });
  }

  @sentry('SchemaPublisher.check')
  async check(input: CheckInput) {
    this.logger.info('Checking schema (input=%o)', lodash.omit(input, ['sdl']));

    await this.authManager.ensureTargetAccess({
      target: input.target,
      project: input.project,
      organization: input.organization,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const [project, latestSchemas] = await Promise.all([
      this.projectManager.getProject({
        organization: input.organization,
        project: input.project,
      }),
      this.schemaManager.getLatestSchemas({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
    ]);

    await this.schemaManager.completeGetStartedCheck({
      organization: project.orgId,
      step: 'checkingSchema',
    });

    const { validationResult, isInitial } =
      project.type === ProjectType.FEDERATION || project.type === ProjectType.STITCHING
        ? await this.composite.check({
            input,
            project,
            currentSchemas: latestSchemas.schemas,
            acceptBreakingChanges: false,
          })
        : project.type === ProjectType.SINGLE
        ? await this.single.check({
            input,
            project,
            currentSchemas: latestSchemas.schemas,
            acceptBreakingChanges: false,
          })
        : await Promise.reject(new Error(`Not implemented: ${project.type}`));

    if (input.github) {
      if (!project.gitRepository) {
        return {
          __typename: 'GitHubSchemaCheckError' as const,
          message: 'Git repository is not configured for this project',
        };
      }
      const [repositoryOwner, repositoryName] = project.gitRepository.split('/');

      try {
        let title: string;
        let summary: string;

        if (validationResult.isComposable && !validationResult.hasBreakingChanges) {
          if (validationResult.changes.length === 0) {
            title = 'No changes';
            summary = 'No changes detected';
          } else {
            title = 'No breaking changes';
            summary = this.changesToMarkdown(validationResult.changes);
          }
        } else {
          title = `Detected ${validationResult.errors.length} error${validationResult.errors.length === 1 ? '' : 's'}`;
          summary = [
            validationResult.errors ? this.errorsToMarkdown(validationResult.errors) : null,
            validationResult.changes ? this.changesToMarkdown(validationResult.changes) : null,
          ]
            .filter(Boolean)
            .join('\n\n');
        }

        await this.gitHubIntegrationManager.createCheckRun({
          name: 'GraphQL Hive - schema:check',
          conclusion: validationResult.isComposable && !validationResult.hasBreakingChanges ? 'success' : 'failure',
          sha: input.github.commit,
          organization: input.organization,
          repositoryOwner,
          repositoryName,
          output: {
            title,
            summary,
          },
        });
        return {
          __typename: 'GitHubSchemaCheckSuccess' as const,
          message: 'Check-run created',
        };
      } catch (error: any) {
        return {
          __typename: 'GitHubSchemaCheckError' as const,
          message: `Failed to create the check-run: ${error.message}`,
        };
      }
    }

    return {
      ...validationResult,
      valid: validationResult.isComposable && !validationResult.hasBreakingChanges,
      initial: isInitial,
    };
  }

  @sentry('SchemaPublisher.delete')
  async delete(input: DeleteInput) {
    this.logger.info('Deleting schema (input=%o)', lodash.omit(input, ['sdl']));

    await this.authManager.ensureTargetAccess({
      target: input.target,
      project: input.project,
      organization: input.organization,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    const [project, latestSchemas] = await Promise.all([
      this.projectManager.getProject({
        organization: input.organization,
        project: input.project,
      }),
      this.schemaManager.getLatestSchemas({
        organization: input.organization,
        project: input.project,
        target: input.target,
      }),
    ]);

    const isCompositeSchemaProject = project.type === ProjectType.FEDERATION || project.type === ProjectType.STITCHING;

    if (!isCompositeSchemaProject) {
      throw new HiveError(`Deleting schemas is not available for ${project.type}-type projects`);
    }

    if (project.isUsingLegacyRegistryModel) {
      throw new HiveError(`Deleting schemas is not available for the legacy registry model`);
    }

    const deletion = await this.composite.delete({
      input,
      project,
      currentSchemas: latestSchemas.schemas,
    });

    if (deletion.conclusion === Conclusion.Reject) {
      return {
        errors: deletion.errors,
      };
    }

    const { isComposable, service, baseSchema } = deletion;

    await this.schemaManager.deleteSchema({
      isComposable,
      serviceName: service.service_name,
      baseSchema,
      organization: input.organization,
      project: input.project,
      target: input.target,
    });

    return {
      ok: service,
    };
  }

  @sentry('SchemaPublisher.publish')
  async publish(input: PublishInput, span?: Span): Promise<PublishResult> {
    this.logger.debug('Schema publication (checksum=%s)', input.checksum);
    return this.idempotentRunner.run({
      identifier: `schema:publish:${input.checksum}`,
      executor: () => this.internalPublish(input),
      ttl: 60,
      span,
    });
  }

  @sentry('SchemaPublisher.sync')
  public async sync(selector: TargetSelector, span?: Span) {
    this.logger.info('Syncing CDN with DB (target=%s)', selector.target);
    await this.authManager.ensureTargetAccess({
      target: selector.target,
      project: selector.project,
      organization: selector.organization,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });
    try {
      const [latestVersion, project, target] = await Promise.all([
        this.schemaManager.getLatestValidVersion(selector),
        this.projectManager.getProject({
          organization: selector.organization,
          project: selector.project,
        }),
        this.targetManager.getTarget({
          organization: selector.organization,
          project: selector.project,
          target: selector.target,
        }),
      ]);

      const schemas = onlySchemasWithSDL(
        await this.schemaManager.getSchemasOfVersion({
          organization: selector.organization,
          project: selector.project,
          target: selector.target,
          version: latestVersion.id,
          includeMetadata: true,
        })
      );
      this.logger.info('Deploying version to CDN (version=%s)', latestVersion.id);
      await this.updateCDN(
        {
          target,
          project,
          supergraph:
            project.type === ProjectType.FEDERATION
              ? await this.schemaManager.matchOrchestrator(project.type).supergraph(
                  schemas.map(s => this.helper.createSchemaObject(s)),
                  project
                )
              : null,
          schemas,
        },
        span
      );
    } catch (error) {
      this.logger.error(`Failed to sync with CDN ` + String(error), error);
      throw error;
    }
  }

  public async updateVersionStatus(input: TargetSelector & { version: string; valid: boolean }) {
    const project = await this.projectManager.getProject({
      organization: input.organization,
      project: input.project,
    });

    if (!project.isUsingLegacyRegistryModel) {
      throw new Error('Updating version status is only supported for projects using the legacy registry model');
    }

    const updateResult = await this.schemaManager.updateSchemaVersionStatus(input);

    if (updateResult.isComposable === true) {
      // Now, when fetching the latest valid version, we should be able to detect
      // if it's the version we just updated or not.
      // Why?
      // Because we change its status to valid
      // and `getLatestValidVersion` calls for fresh data from DB
      const latestVersion = await this.schemaManager.getLatestValidVersion(input);

      // if it is the latest version, we should update the CDN
      if (latestVersion.id === updateResult.id) {
        this.logger.info('Version is now promoted to latest valid (version=%s)', latestVersion.id);
        const [target, schemas] = await Promise.all([
          this.targetManager.getTarget({
            organization: input.organization,
            project: input.project,
            target: input.target,
          }),
          this.schemaManager.getSchemasOfVersion({
            organization: input.organization,
            project: input.project,
            target: input.target,
            version: latestVersion.id,
            includeMetadata: true,
          }),
        ]);

        this.logger.info('Deploying version to CDN (version=%s)', latestVersion.id);
        await this.updateCDN({
          target,
          project,
          supergraph:
            project.type === ProjectType.FEDERATION
              ? await this.schemaManager.matchOrchestrator(project.type).supergraph(
                  ensureCompositeSchemas(schemas)
                    .filter(isAddedOrModified)
                    .map(s => this.helper.createSchemaObject(s)),
                  project
                )
              : null,
          schemas: onlySchemasWithSDL(schemas),
        });
      }
    }

    return updateResult;
  }

  private async internalPublish(input: PublishInput) {
    const [organizationId, projectId, targetId] = [input.organization, input.project, input.target];
    this.logger.info('Publishing schema (input=%o)', {
      ...lodash.omit(input, ['sdl', 'organization', 'project', 'target', 'metadata']),
      organization: organizationId,
      project: projectId,
      target: targetId,
      sdl: input.sdl.length,
      checksum: input.checksum,
      experimental_accept_breaking_changes: input.experimental_acceptBreakingChanges === true,
      metadata: !!input.metadata,
    });

    await this.authManager.ensureTargetAccess({
      target: targetId,
      project: projectId,
      organization: organizationId,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    const [organization, project, target, latest] = await Promise.all([
      this.organizationManager.getOrganization({
        organization: organizationId,
      }),
      this.projectManager.getProject({
        organization: organizationId,
        project: projectId,
      }),
      this.targetManager.getTarget({
        organization: organizationId,
        project: projectId,
        target: targetId,
      }),
      this.schemaManager.getLatestSchemas({
        // here we get an empty list of schemas
        organization: organizationId,
        project: projectId,
        target: targetId,
      }),
    ]);

    const currentSchemas = latest.schemas;

    await this.schemaManager.completeGetStartedCheck({
      organization: project.orgId,
      step: 'publishingSchema',
    });

    this.logger.debug(`Found ${currentSchemas.length} most recent schemas`);

    const publishResult =
      project.type === ProjectType.FEDERATION || project.type === ProjectType.STITCHING
        ? await this.composite.publish({
            input,
            project,
            target,
            currentSchemas,
            version: latest.version ?? null,
          })
        : project.type === ProjectType.SINGLE
        ? await this.single.publish({ input, project, target, currentSchemas, version: latest.version ?? null })
        : await Promise.reject(new Error(`Not implemented: ${project.type}`));

    if ('error' in publishResult) {
      if (input.github) {
        return this.createPublishCheckRun({
          force: false,
          initial: false,
          input,
          project,
          isComposable: false,
          changes: [],
          errors: [
            {
              message: publishResult.message!,
            },
          ],
        });
      }
      return {
        __typename:
          publishResult.error === 'MISSING_SERVICE_NAME'
            ? ('SchemaPublishMissingServiceError' as const)
            : ('SchemaPublishMissingUrlError' as const),
        message: publishResult.message,
      };
    }

    if (publishResult.conclusion === Conclusion.Neutral) {
      // if the schema is not modified, we don't need to do anything, just return the success
      this.logger.debug('Schema is not modified');

      if (input.github === true) {
        return this.createPublishCheckRun({
          force: input.force,
          initial: publishResult.isInitial,
          input,
          project,
          isComposable: true,
          changes: [],
          errors: [],
        });
      }

      return {
        __typename: 'SchemaPublishSuccess' as const,
        initial: publishResult.isInitial,
        valid: true,
        isComposable: true,
        errors: [],
        changes: [],
      };
    }

    const { changes, updates, errors, isComposable, schema, schemas, isInitial, cdn, conclusion, __typename } =
      publishResult;

    let newVersionId: string | null = null;

    if (conclusion === Conclusion.Publish) {
      // if the schema is valid or the user is forcing the publish, we can go ahead and publish it
      this.logger.debug('Publishing new version');
      // here
      const newVersion = await this.publishNewVersion({
        input,
        isComposable,
        schemas: schemas.after,
        newSchema: schema.after,
        organizationId,
        target,
        project,
        changes,
        errors,
        initial: isInitial,
        action: 'action' in schema.after ? schema.after.action : 'N/A',
        cdn,
      });

      newVersionId = newVersion.id;
    }

    if (input.github) {
      return this.createPublishCheckRun({
        force: input.force,
        initial: isInitial,
        input,
        project,
        isComposable,
        changes,
        errors,
        updates,
      });
    }

    const linkToWebsite =
      typeof this.schemaModuleConfig.schemaPublishLink === 'function' && typeof newVersionId === 'string'
        ? this.schemaModuleConfig.schemaPublishLink({
            organization: {
              cleanId: organization.cleanId,
            },
            project: {
              cleanId: project.cleanId,
            },
            target: {
              cleanId: target.cleanId,
            },
            version: isInitial
              ? undefined
              : {
                  id: newVersionId,
                },
          })
        : null;

    return {
      __typename,
      initial: isInitial,
      valid: isComposable,
      isComposable: isComposable,
      errors,
      changes,
      message: updates.length ? updates.join('\n') : null,
      linkToWebsite,
    };
  }

  @sentry('SchemaPublisher.publishNewVersion')
  private async publishNewVersion({
    isComposable,
    input,
    target,
    project,
    organizationId,
    newSchema,
    schemas,
    changes,
    errors,
    initial,
    action,
    cdn,
  }: {
    isComposable: boolean;
    input: PublishInput;
    target: Target;
    project: Project;
    organizationId: string;
    newSchema: Schema;
    schemas: readonly Schema[];
    changes: Types.SchemaChange[];
    errors: Types.SchemaError[];
    initial: boolean;
    action: 'ADD' | 'MODIFY' | 'N/A';
    cdn: {
      schemas: readonly Schema[];
      supergraph: string | null;
    } | null;
  }) {
    const commits = schemas
      .filter(s => s.id !== newSchema.id) // do not include the incoming schema
      .map(s => s.id);

    this.logger.debug(`Assigning ${commits.length} schemas to new version`);
    const baseSchema = await this.schemaManager.getBaseSchema({
      organization: input.organization,
      project: input.project,
      target: input.target,
    });
    const [schemaVersion, organization] = await Promise.all([
      this.schemaManager.createVersion({
        isComposable,
        organization: organizationId,
        project: project.id,
        target: target.id,
        commit: input.commit,
        commits,
        service: input.service,
        schema: input.sdl,
        author: input.author,
        url: input.url,
        base_schema: baseSchema,
        metadata: input.metadata ?? null,
        action,
      }),
      this.organizationManager.getOrganization({
        organization: organizationId,
      }),
    ]);

    if (cdn) {
      try {
        await this.updateCDN({
          target,
          project,
          ...cdn,
        });
      } catch (e) {
        this.logger.error(`Failed to publish to CDN!`, e);
      }
    }

    void this.alertsManager
      .triggerSchemaChangeNotifications({
        organization,
        project,
        target,
        schema: {
          ...schemaVersion,
          valid: schemaVersion.isComposable,
        },
        changes,
        errors,
        initial,
      })
      .catch(err => {
        this.logger.error('Failed to trigger schema change notifications', err);
      });

    return schemaVersion;
  }

  private async updateCDN(
    {
      target,
      project,
      supergraph,
      schemas,
    }: {
      target: Target;
      project: Project;
      schemas: readonly Schema[];
      supergraph?: string | null;
    },
    span?: Span
  ) {
    const metadata: Array<Record<string, any>> = [];
    for (const schema of schemas) {
      if ('metadata' in schema && schema.metadata) {
        metadata.push(schema.metadata);
      }
    }

    await Promise.all([
      this.cdn.publish(
        {
          targetId: target.id,
          resourceType: 'schema',
          value: JSON.stringify(
            schemas.length > 1 || project.type === ProjectType.FEDERATION || project.type === ProjectType.STITCHING
              ? schemas.map(s => ({
                  sdl: s.sdl,
                  url: 'service_url' in s ? s.service_url : null,
                  name: 'service_name' in s ? s.service_name : null,
                  date: s.date,
                }))
              : {
                  sdl: schemas[0].sdl,
                  date: schemas[0].date,
                }
          ),
        },
        span
      ),
      metadata.length > 0
        ? this.cdn.publish(
            {
              targetId: target.id,
              resourceType: 'metadata',
              value: JSON.stringify(metadata.length === 1 ? metadata[0] : metadata),
            },
            span
          )
        : null,
      supergraph
        ? this.cdn.publish(
            {
              targetId: target.id,
              resourceType: 'supergraph',
              value: supergraph,
            },
            span
          )
        : null,
    ]);
  }

  private async createPublishCheckRun({
    initial,
    force,
    input,
    project,
    isComposable,
    changes,
    errors,
    updates,
  }: {
    initial: boolean;
    force?: boolean | null;
    input: PublishInput;
    project: Project;
    isComposable: boolean;
    changes: readonly Types.SchemaChange[];
    errors: readonly Types.SchemaError[];
    updates?: string[];
  }) {
    if (!project.gitRepository) {
      return {
        __typename: 'GitHubSchemaPublishError' as const,
        message: 'Git repository is not configured for this project',
      };
    }
    const [repositoryOwner, repositoryName] = project.gitRepository.split('/');

    try {
      let title: string;
      let summary: string;

      if (isComposable) {
        if (initial) {
          title = 'Schema published';
          summary = 'Initial Schema published';
        } else if (changes.length === 0) {
          title = 'No changes';
          summary = 'No changes detected';
        } else {
          title = 'No breaking changes';
          summary = this.changesToMarkdown(changes);
        }
      } else {
        title = `Detected ${errors.length} error${errors.length === 1 ? '' : 's'}`;
        summary = [errors ? this.errorsToMarkdown(errors) : null, changes ? this.changesToMarkdown(changes) : null]
          .filter(Boolean)
          .join('\n\n');
      }

      if (updates?.length) {
        summary += `\n\n${updates.map(val => `- ${val}`).join('\n')}`;
      }

      if (isComposable === false && force === true) {
        title += ' (forced)';
      }

      await this.gitHubIntegrationManager.createCheckRun({
        name: 'GraphQL Hive - schema:publish',
        conclusion: isComposable ? 'success' : force ? 'neutral' : 'failure',
        sha: input.commit,
        organization: input.organization,
        repositoryOwner,
        repositoryName,
        output: {
          title,
          summary,
        },
      });
      return {
        __typename: 'GitHubSchemaPublishSuccess' as const,
        message: title,
      };
    } catch (error: any) {
      return {
        __typename: 'GitHubSchemaPublishError' as const,
        message: `Failed to create the check-run: ${error.message}`,
      };
    }
  }

  private errorsToMarkdown(errors: readonly Types.SchemaError[]): string {
    return ['', ...errors.map(error => `- ${bolderize(error.message)}`)].join('\n');
  }

  private changesToMarkdown(changes: readonly Types.SchemaChange[]): string {
    const breakingChanges = changes.filter(filterChangesByLevel('Breaking'));
    const dangerousChanges = changes.filter(filterChangesByLevel('Dangerous'));
    const safeChanges = changes.filter(filterChangesByLevel('Safe'));

    const lines: string[] = [`## Found ${changes.length} change${changes.length > 1 ? 's' : ''}`, ''];

    if (breakingChanges.length) {
      lines.push(`Breaking: ${breakingChanges.length}`);
    }

    if (dangerousChanges.length) {
      lines.push(`Dangerous: ${dangerousChanges.length}`);
    }

    if (safeChanges.length) {
      lines.push(`Safe: ${safeChanges.length}`);
    }

    if (breakingChanges.length) {
      writeChanges('Breaking', breakingChanges, lines);
    }

    if (dangerousChanges.length) {
      writeChanges('Dangerous', dangerousChanges, lines);
    }

    if (safeChanges.length) {
      writeChanges('Safe', safeChanges, lines);
    }

    return lines.join('\n');
  }
}

function filterChangesByLevel(level: Types.CriticalityLevel) {
  return (change: Types.SchemaChange) => change.criticality === level;
}

function writeChanges(type: string, changes: readonly Types.SchemaChange[], lines: string[]): void {
  lines.push(...['', `### ${type} changes`].concat(changes.map(change => ` - ${bolderize(change.message)}`)));
}
