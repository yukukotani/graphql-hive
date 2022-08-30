import { Injectable, Scope } from 'graphql-modules';
import { StitchingOrchestrator } from './../orchestrators/stitching';
import {
  GraphQLDocumentStringInvalidError,
  AddedCompositeSchema,
  ModifiedCompositeSchema,
  Schema,
  Target,
  Project,
  ProjectType,
} from './../../../../shared/entities';
import { HiveError } from '../../../../shared/errors';
import { FederationOrchestrator } from '../orchestrators/federation';
import { SchemaManager } from '../schema-manager';
import type { CheckInput, PublishInput, DeleteInput } from '../schema-publisher';
import { SchemaValidator } from './../schema-validator';
import { SchemaHelper, ensureCompositeSchemas, serviceExists, swapServices, isAddedOrModified } from '../schema-helper';
import { temp, Conclusion } from './shared';

@Injectable({
  scope: Scope.Operation,
})
export class CompositeModel {
  constructor(
    private schemaManager: SchemaManager,
    private schemaValidator: SchemaValidator,
    private federation: FederationOrchestrator,
    private stitching: StitchingOrchestrator,
    private helper: SchemaHelper
  ) {}

  private supportsMetadata(project: Project) {
    return project.type !== ProjectType.FEDERATION;
  }

  private supportsBaseSchema(project: Project) {
    return project.type !== ProjectType.FEDERATION;
  }

  private supportsSupergraph(project: Project) {
    return project.type === ProjectType.FEDERATION;
  }

  private requiresServiceUrl(project: Project) {
    return project.type === ProjectType.FEDERATION;
  }

  async check({
    input,
    acceptBreakingChanges,
    project,
    currentSchemas,
  }: {
    project: Project;
    acceptBreakingChanges: boolean;
    input: Pick<CheckInput, 'target' | 'sdl' | 'service' | 'organization' | 'project'>;
    currentSchemas: Schema[];
  }) {
    const orchestrator = project.type === ProjectType.FEDERATION ? this.federation : this.stitching;
    const schemas = ensureCompositeSchemas(currentSchemas);
    const action = serviceExists(schemas, input.service!) ? 'MODIFY' : 'ADD';
    const incoming: AddedCompositeSchema | ModifiedCompositeSchema = {
      id: temp,
      author: temp,
      commit: temp,
      target: input.target,
      date: Date.now(),
      sdl: input.sdl,
      service_name: input.service!,
      service_url: temp,
      action,
    };

    const baseSchema = this.supportsBaseSchema(project)
      ? await this.schemaManager.getBaseSchema({
          target: input.target,
          project: input.project,
          organization: input.organization,
        })
      : null;

    const { schemas: afterSchemas, existing } = swapServices(schemas, incoming);

    const schemaObjects = {
      before: schemas.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s)),
      after: afterSchemas.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s)),
    };

    const isInitial = schemas.length === 0;

    const validationResult = await this.schemaValidator.validate({
      orchestrator,
      isInitial,
      compare: {
        incoming: this.helper.createSchemaObject(incoming),
        existing: existing ? this.helper.createSchemaObject(existing) : null,
      },
      schemas: { baseSchema, before: schemaObjects.before, after: schemaObjects.after },
      selector: {
        organization: input.organization,
        project: input.project,
        target: input.target,
      },
      acceptBreakingChanges,
      project,
    });

    return {
      validationResult,
      isInitial,
      artifacts: {
        previousService: existing,
        schemaObjects,
        schemas: {
          before: schemas,
          after: afterSchemas,
        },
      },
    };
  }

  async publish({
    input,
    project,
    target,
    currentSchemas,
    version,
  }: {
    input: PublishInput;
    project: Project;
    target: Target;
    currentSchemas: Schema[];
    version: string | null;
  }) {
    const serviceName = input.service;
    const serviceUrl = input.url;
    const orchestrator = project.type === ProjectType.FEDERATION ? this.federation : this.stitching;

    if (!serviceName || typeof serviceName !== 'string' || serviceName.trim() === '') {
      return {
        error: 'MISSING_SERVICE_NAME' as const,
        message: `Can not publish schema for a '${project.type.toLowerCase()}' project without a service name.`,
      };
    }

    if (
      this.requiresServiceUrl(project) &&
      (!serviceUrl || typeof serviceUrl !== 'string' || serviceUrl.trim() === '')
    ) {
      return {
        error: 'MISSING_SERVICE_URL' as const,
        message: `Can not publish schema for a '${project.type.toLowerCase()}' project without a service url.`,
      };
    }

    const { validationResult, isInitial, artifacts } = await this.check({
      input: {
        organization: input.organization,
        project: input.project,
        target: input.target,
        sdl: input.sdl,
        service: serviceName,
      },
      // Decide if we should accept breaking changes or not
      acceptBreakingChanges: input.experimental_acceptBreakingChanges === true || !project.isUsingLegacyRegistryModel,
      project,
      currentSchemas,
    }).catch(async error => {
      if (error instanceof GraphQLDocumentStringInvalidError) {
        throw new HiveError(error.message);
      }
      throw error;
    });

    const previousService = artifacts.previousService;

    const incoming: AddedCompositeSchema | ModifiedCompositeSchema = {
      action: previousService ? 'MODIFY' : 'ADD',
      id: temp,
      author: input.author,
      sdl: input.sdl,
      service_name: serviceName,
      service_url: serviceUrl ?? null,
      commit: input.commit,
      target: target.id,
      date: Date.now(),
      metadata: this.supportsMetadata(project) ? this.helper.ensureJSONMetadata(input.metadata) : null,
    };

    const schemas = {
      before: artifacts.schemas.before,
      after: artifacts.schemas.after.map(s => {
        if (s.id === incoming.id) {
          return incoming;
        }
        return s;
      }),
    };
    const schemaObjects = {
      before: artifacts.schemaObjects.before,
      after: schemas.after.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s)),
    };

    const { changes, errors, isComposable, hasBreakingChanges } = validationResult;

    const hasNewUrl = version && previousService && previousService.service_url !== incoming.service_url;
    const hasSchemaChanges = changes.length > 0;
    const hasErrors = errors.length > 0;
    const isForced = input.force === true;
    let hasDifferentChecksum = false;

    if (!!version && !!previousService) {
      const before = this.helper
        .sortSchemas(schemas.before)
        .map(s => this.helper.createChecksum(s))
        .join(',');
      const after = this.helper
        .sortSchemas(schemas.after)
        .map(s => this.helper.createChecksum(s))
        .join(',');

      hasDifferentChecksum = before !== after;
    }

    const isModified = hasNewUrl || hasSchemaChanges || hasErrors || hasDifferentChecksum;

    if (!isModified && !isInitial) {
      return {
        conclusion: Conclusion.Neutral as const,
        valid: true,
        isInitial,
        isModified,
      };
    }

    const updates: string[] = [];

    if (hasNewUrl) {
      updates.push(`Updated: New service url: ${incoming.service_url} (previously: ${previousService.service_url})`);
    }

    if (project.isUsingLegacyRegistryModel) {
      const valid = isComposable && !hasBreakingChanges;
      const conclusion = valid || isForced ? Conclusion.Publish : Conclusion.Reject;
      const __typename =
        conclusion === Conclusion.Publish ? ('SchemaPublishSuccess' as const) : ('SchemaPublishError' as const);

      return {
        __typename,
        conclusion,
        isComposable: valid,
        changes,
        errors,
        updates,
        schema: {
          before: previousService,
          after: incoming,
        },
        schemas: {
          before: schemas.before.filter(isAddedOrModified),
          after: schemas.after.filter(isAddedOrModified),
        },
        cdn: valid
          ? {
              schemas: schemas.after.filter(isAddedOrModified),
              supergraph: this.supportsSupergraph(project)
                ? await orchestrator.supergraph(schemaObjects.after, project)
                : null,
            }
          : null,
        isInitial,
      };
    }

    const conclusion = isComposable ? Conclusion.Publish : Conclusion.Reject;
    const __typename =
      conclusion === Conclusion.Publish ? ('SchemaPublishSuccess' as const) : ('SchemaPublishError' as const);

    return {
      __typename,
      conclusion,
      isComposable,
      changes,
      errors,
      updates,
      schema: {
        before: previousService,
        after: incoming,
      },
      schemas: {
        before: schemas.before.filter(isAddedOrModified),
        after: schemas.after.filter(isAddedOrModified),
      },
      cdn:
        conclusion === Conclusion.Publish
          ? {
              schemas: schemas.after.filter(isAddedOrModified),
              supergraph: this.supportsSupergraph(project)
                ? await orchestrator.supergraph(schemaObjects.after, project)
                : null,
            }
          : null,
      isInitial,
    };
  }

  async delete({ input, project, currentSchemas }: { project: Project; input: DeleteInput; currentSchemas: Schema[] }) {
    const serviceName = input.serviceName;
    const allActiveServices = currentSchemas.filter(isAddedOrModified);
    const serviceToDelete = allActiveServices.find(s => s.service_name === serviceName);

    if (!serviceToDelete) {
      return {
        conclusion: Conclusion.Reject as const,
        errors: [
          {
            message: `Service '${serviceName}' not found.`,
          },
        ],
      };
    }

    const isForced = input.force === true;

    const futureServices = allActiveServices.filter(service => service.id !== serviceToDelete.id);
    const orchestrator = project.type === ProjectType.FEDERATION ? this.federation : this.stitching;

    const baseSchema = this.supportsBaseSchema(project)
      ? await this.schemaManager.getBaseSchema({
          target: input.target,
          project: input.project,
          organization: input.organization,
        })
      : null;

    const schemaObjects = {
      before: allActiveServices.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s)),
      after: futureServices.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s)),
    };

    const { isComposable, hasBreakingChanges, errors } = await this.schemaValidator.validate({
      orchestrator,
      isInitial: false,
      compare: false,
      schemas: {
        baseSchema,
        before: schemaObjects.before,
        after: schemaObjects.after,
      },
      selector: {
        organization: input.organization,
        project: input.project,
        target: input.target,
      },
      acceptBreakingChanges: isForced,
      project,
    });

    return {
      conclusion:
        isForced || (isComposable && !hasBreakingChanges)
          ? (Conclusion.Publish as const)
          : (Conclusion.Reject as const),
      isComposable,
      hasBreakingChanges,
      errors,
      service: serviceToDelete,
      baseSchema,
    };
  }
}
