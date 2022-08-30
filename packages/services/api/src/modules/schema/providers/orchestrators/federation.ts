import { Injectable, Inject, Scope, CONTEXT } from 'graphql-modules';
import { parse, visit, print } from 'graphql';
import { Logger } from '../../../shared/providers/logger';
import { sentry } from '../../../../shared/sentry';
import { ProjectType } from '../../../../shared/entities';
import type { Orchestrator, SchemaObject, Project } from '../../../../shared/entities';
import { SchemaBuildError } from './errors';
import { SCHEMA_SERVICE_CONFIG } from './tokens';
import type { SchemaServiceConfig } from './tokens';
import { createTRPCClient } from '@trpc/client';
import { fetch } from '@whatwg-node/fetch';
import type { SchemaBuilderApi } from '@hive/schema';

const federationV1 = {
  directives: ['join__graph', 'join__field', 'join__owner', 'join__type', 'core'],
  enums: ['join__Graph', 'core__Purpose'],
  scalars: ['join__FieldSet'],
};

function removeFederationSpec(raw: string) {
  return visit(parse(raw), {
    SchemaDefinition(node) {
      return {
        ...node,
        directives: [],
      };
    },
    DirectiveDefinition(node) {
      if (federationV1.directives.includes(node.name.value)) {
        return null;
      }

      return node;
    },
    EnumTypeDefinition(node) {
      if (federationV1.enums.includes(node.name.value)) {
        return null;
      }

      return node;
    },
    ScalarTypeDefinition(node) {
      if (federationV1.scalars.includes(node.name.value)) {
        return null;
      }

      return node;
    },
  });
}

type ExternalComposition = {
  enabled: boolean;
  endpoint: string;
  encryptedSecret: string;
} | null;

type Config = {
  externalComposition: ExternalComposition;
  isUsingLegacyRegistryModel: boolean;
};

@Injectable({
  scope: Scope.Operation,
})
export class FederationOrchestrator implements Orchestrator {
  type = ProjectType.FEDERATION;
  private logger: Logger;
  private schemaService;

  constructor(
    logger: Logger,
    @Inject(SCHEMA_SERVICE_CONFIG) serviceConfig: SchemaServiceConfig,
    @Inject(CONTEXT) context: GraphQLModules.ModuleContext
  ) {
    this.logger = logger.child({ service: 'FederationOrchestrator' });
    this.schemaService = createTRPCClient<SchemaBuilderApi>({
      url: `${serviceConfig.endpoint}/trpc`,
      fetch,
      headers: {
        'x-request-id': context.requestId,
      },
    });
  }

  ensureConfig(project: Project): Config {
    if (!project) {
      throw new Error('Missing config for FederationOrchestrator');
    }

    if (typeof project.isUsingLegacyRegistryModel !== 'boolean') {
      throw new Error('Missing isUsingLegacyRegistryModel in config for FederationOrchestrator');
    }

    if (project.externalComposition && project.externalComposition.enabled) {
      if (!project.externalComposition.endpoint) {
        throw new Error('External composition error: endpoint is missing');
      }

      if (!project.externalComposition.encryptedSecret) {
        throw new Error('External composition error: encryptedSecret is missing');
      }
    }

    return {
      externalComposition: project.externalComposition.enabled
        ? {
            enabled: project.externalComposition.enabled,
            endpoint: project.externalComposition.endpoint,
            encryptedSecret: project.externalComposition.encryptedSecret,
          }
        : null,
      isUsingLegacyRegistryModel: project.isUsingLegacyRegistryModel,
    };
  }

  private externalCompositionFromConfig(config: Config) {
    return config.externalComposition?.enabled ? config.externalComposition : null;
  }

  @sentry('FederationOrchestrator.validate')
  async validate(schemas: readonly SchemaObject[], project: Project) {
    this.logger.debug('Validating Federated Schemas');
    const config = this.ensureConfig(project);

    const result = await this.schemaService.mutation('validate', {
      type: 'federation',
      schemas: schemas.map(s => ({
        raw: s.raw,
        source: s.source,
      })),
      external: this.externalCompositionFromConfig(config),
    });

    return result.errors;
  }

  @sentry('FederationOrchestrator.build')
  async build(schemas: readonly SchemaObject[], project: Project): Promise<SchemaObject> {
    this.logger.debug('Building Federated Schemas');
    const config = this.ensureConfig(project);

    try {
      const result = await this.schemaService.mutation('build', {
        type: 'federation',
        schemas: schemas.map(s => ({
          raw: s.raw,
          source: s.source,
        })),
        external: this.externalCompositionFromConfig(config),
      });

      if (config.isUsingLegacyRegistryModel) {
        return {
          document: parse(result.raw),
          raw: result.raw,
          source: result.source,
        };
      }

      const parsed = removeFederationSpec(result.raw);

      return {
        document: parsed,
        raw: print(parsed),
        source: result.source,
      };
    } catch (error) {
      throw new SchemaBuildError(error as Error);
    }
  }

  @sentry('FederationOrchestrator.supergraph')
  async supergraph(schemas: readonly SchemaObject[], project: Project): Promise<string | null> {
    this.logger.debug('Generating Federated Supergraph');
    const config = this.ensureConfig(project);

    const result = await this.schemaService.mutation('supergraph', {
      type: 'federation',
      schemas: schemas.map(s => ({
        raw: s.raw,
        source: s.source,
        url: s.url,
      })),
      external: this.externalCompositionFromConfig(config),
    });

    return result.supergraph;
  }
}
