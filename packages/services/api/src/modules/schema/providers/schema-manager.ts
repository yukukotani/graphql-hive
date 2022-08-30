import { Injectable, Scope } from 'graphql-modules';
import lodash from 'lodash';
import { RegistryVersion } from '../../../shared/mappers';
import { Orchestrator, ProjectType } from '../../../shared/entities';
import { atomic, stringifySelector } from '../../../shared/helpers';
import { HiveError } from '../../../shared/errors';
import { AuthManager } from '../../auth/providers/auth-manager';
import { Logger } from '../../shared/providers/logger';
import { Storage, TargetSelector, ProjectSelector, OrganizationSelector } from '../../shared/providers/storage';
import { CustomOrchestrator } from './orchestrators/custom';
import { FederationOrchestrator } from './orchestrators/federation';
import { SingleOrchestrator } from './orchestrators/single';
import { StitchingOrchestrator } from './orchestrators/stitching';
import { TargetAccessScope } from '../../auth/providers/target-access';
import { ProjectAccessScope } from '../../auth/providers/project-access';
import { CryptoProvider } from '../../shared/providers/crypto';
import { z } from 'zod';
import { ensureCompositeSchemas } from './schema-helper';
import { ProjectManager } from '../../project/providers/project-manager';

const ENABLE_EXTERNAL_COMPOSITION_SCHEMA = z.object({
  endpoint: z.string().url().nonempty(),
  secret: z.string().nonempty(),
});

interface VersionSelector extends TargetSelector {
  version: string;
}

type Paginated<T> = T & {
  after?: string | null;
  limit: number;
};

/**
 * Responsible for auth checks.
 * Talks to Storage.
 */
@Injectable({
  scope: Scope.Operation,
  global: true,
})
export class SchemaManager {
  private logger: Logger;

  constructor(
    logger: Logger,
    private authManager: AuthManager,
    private projectManager: ProjectManager,
    private storage: Storage,
    private singleOrchestrator: SingleOrchestrator,
    private stitchingOrchestrator: StitchingOrchestrator,
    private federationOrchestrator: FederationOrchestrator,
    private customOrchestrator: CustomOrchestrator,
    private crypto: CryptoProvider
  ) {
    this.logger = logger.child({ source: 'SchemaManager' });
  }

  async hasSchema(selector: TargetSelector) {
    this.logger.debug('Checking if schema is available (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.hasSchema(selector);
  }

  async getSchemasOfVersion(
    selector: {
      version: string;
      includeMetadata?: boolean;
    } & TargetSelector
  ) {
    this.logger.debug('Fetching schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getSchemasOfVersion(selector);
  }

  async getSchemasOfPreviousVersion(
    selector: {
      version: string;
    } & TargetSelector
  ) {
    this.logger.debug('Fetching schemas from the previous version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getSchemasOfPreviousVersion(selector);
  }

  async getLatestSchemas(selector: TargetSelector) {
    this.logger.debug('Fetching latest schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getLatestSchemas(selector);
  }

  async getMaybeLatestValidVersion(selector: TargetSelector) {
    this.logger.debug('Fetching latest valid version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const version = await this.storage.getMaybeLatestComposableVersion(selector);

    if (!version) {
      return null;
    }

    return {
      ...version,
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getLatestValidVersion(selector: TargetSelector) {
    this.logger.debug('Fetching latest valid version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return {
      ...(await this.storage.getLatestComposableVersion(selector)),
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getLatestVersion(selector: TargetSelector) {
    this.logger.debug('Fetching latest version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return {
      ...(await this.storage.getLatestVersion(selector)),
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getMaybeLatestVersion(selector: TargetSelector) {
    this.logger.debug('Fetching maybe latest version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });

    const latest = await this.storage.getMaybeLatestVersion(selector);

    if (!latest) {
      return null;
    }

    return {
      ...latest,
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
    };
  }

  async getSchemaVersion(selector: TargetSelector & { version: string }) {
    this.logger.debug('Fetching single schema version (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    const result = await this.storage.getVersion(selector);

    return {
      project: selector.project,
      target: selector.target,
      organization: selector.organization,
      ...result,
    };
  }

  async getSchemaVersions(selector: Paginated<TargetSelector>) {
    this.logger.debug('Fetching published schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    const result = await this.storage.getVersions(selector);

    return {
      nodes: result.versions.map(r => ({
        ...r,
        project: selector.project,
        target: selector.target,
        organization: selector.organization,
      })),
      hasMore: result.hasMore,
    };
  }

  async updateSchemaVersionStatus(
    input: TargetSelector & { version: string; valid: boolean }
  ): Promise<RegistryVersion> {
    this.logger.debug('Updating schema version status (input=%o)', input);
    await this.authManager.ensureTargetAccess({
      ...input,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    return {
      ...(await this.storage.updateVersionStatus(input)),
      organization: input.organization,
      project: input.project,
      target: input.target,
    };
  }

  async updateSchemaUrl(
    input: TargetSelector & {
      version: string;
      commit: string;
      url?: string | null;
    }
  ) {
    this.logger.debug('Updating schema version status (input=%o)', input);
    await this.authManager.ensureTargetAccess({
      ...input,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });
    await this.storage.updateSchemaUrlOfVersion(input);
  }

  async getCommit(selector: { commit: string } & TargetSelector) {
    this.logger.debug('Fetching schema (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getSchema({
      commit: selector.commit,
      target: selector.target,
    });
  }

  @atomic(stringifySelector)
  async getCommits(selector: VersionSelector) {
    this.logger.debug('Fetching schemas (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return this.storage.getSchemasOfVersion(selector);
  }

  async createVersion(
    input: {
      commit: string;
      schema: string;
      author: string;
      isComposable: boolean;
      service?: string | null;
      commits: string[];
      url?: string | null;
      base_schema: string | null;
      metadata: string | null;
      action: 'ADD' | 'MODIFY' | 'N/A';
    } & TargetSelector
  ) {
    this.logger.info('Creating a new version (input=%o)', lodash.omit(input, ['schema']));
    const { isComposable, project, organization, target, commit, schema, author, commits, url, metadata, action } =
      input;
    let service = input.service;

    await this.authManager.ensureTargetAccess({
      project,
      organization,
      target,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    const { isUsingLegacyRegistryModel } = await this.projectManager.getProject({
      organization,
      project,
    });

    // In case of the legacy registry model, we need to ensure that the service name is lowercased
    if (isUsingLegacyRegistryModel && service) {
      service = service.toLowerCase();
    }

    return this.storage.createVersion({
      isComposable,
      organization,
      project,
      target,
      schema: {
        sdl: schema,
        serviceName: service,
        commit,
        author,
        serviceUrl: url,
        metadata,
        base_schema: input.base_schema,
      },
    });
  }

  async deleteSchema(
    input: {
      serviceName: string;
      isComposable: boolean;
      baseSchema: string | null;
    } & TargetSelector
  ) {
    await this.authManager.ensureTargetAccess({
      target: input.target,
      project: input.project,
      organization: input.organization,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    return this.storage.deleteSchema({
      ...input,
      author: 'unknown',
      commit: 'unknown',
    });
  }

  matchOrchestrator(projectType: ProjectType): Orchestrator | never {
    switch (projectType) {
      case ProjectType.SINGLE: {
        return this.singleOrchestrator;
      }
      case ProjectType.STITCHING: {
        return this.stitchingOrchestrator;
      }
      case ProjectType.FEDERATION: {
        return this.federationOrchestrator;
      }
      case ProjectType.CUSTOM: {
        return this.customOrchestrator;
      }
      default: {
        throw new HiveError(`Couldn't find an orchestrator for project type "${projectType}"`);
      }
    }
  }

  // private async insertSchema(
  //   input: {
  //     schema: string;
  //     commit: string;
  //     author: string;
  //     service?: string | null;
  //     url?: string | null;
  //     metadata: string | null;
  //     action: 'ADD' | 'MODIFY' | 'N/A';
  //   } & TargetSelector
  // ) {
  //   this.logger.info('Inserting schema (input=%o)', lodash.omit(input, ['schema']));
  //   await this.authManager.ensureTargetAccess({
  //     ...input,
  //     scope: TargetAccessScope.REGISTRY_WRITE,
  //   });
  //   return this.storage.insertSchema(input);
  // }

  async getBaseSchema(selector: TargetSelector) {
    this.logger.debug('Fetching base schema (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    return await this.storage.getBaseSchema(selector);
  }
  async updateBaseSchema(selector: TargetSelector, newBaseSchema: string | null) {
    this.logger.debug('Updating base schema (selector=%o)', selector);
    await this.authManager.ensureTargetAccess({
      ...selector,
      scope: TargetAccessScope.REGISTRY_READ,
    });
    await this.storage.updateBaseSchema(selector, newBaseSchema);
  }

  async updateServiceName(
    input: TargetSelector & {
      version: string;
      name: string;
      newName: string;
      projectType: ProjectType;
      isUsingLegacyRegistryModel: boolean;
    }
  ) {
    this.logger.debug('Updating service name (input=%o)', input);
    await this.authManager.ensureTargetAccess({
      ...input,
      scope: TargetAccessScope.REGISTRY_WRITE,
    });

    if (!input.isUsingLegacyRegistryModel) {
      throw new HiveError('This operation is available only for projects using the legacy registry model');
    }

    if (input.projectType !== ProjectType.FEDERATION && input.projectType !== ProjectType.STITCHING) {
      throw new HiveError(`Project type "${input.projectType}" doesn't support service name updates`);
    }

    const schemas = ensureCompositeSchemas(
      await this.storage.getSchemasOfVersion({
        version: input.version,
        target: input.target,
        project: input.project,
        organization: input.organization,
      })
    );

    const schema = schemas.find(s => s.service_name === input.name);

    if (!schema) {
      throw new HiveError(`Couldn't find service "${input.name}"`);
    }

    if (input.newName.trim().length === 0) {
      throw new HiveError(`Service name can't be empty`);
    }

    const duplicatedSchema = schemas.find(s => s.service_name === input.newName);

    if (duplicatedSchema) {
      throw new HiveError(`Service "${input.newName}" already exists`);
    }

    await this.storage.updateServiceName({
      organization: input.organization,
      project: input.project,
      target: input.target,
      commit: schema.id,
      name: input.newName,
    });
  }

  completeGetStartedCheck(
    selector: OrganizationSelector & {
      step: 'publishingSchema' | 'checkingSchema';
    }
  ): Promise<void> {
    return this.storage.completeGetStartedStep(selector);
  }

  async disableExternalSchemaComposition(input: ProjectSelector) {
    this.logger.debug('Disabling external composition (input=%o)', input);
    await this.authManager.ensureProjectAccess({
      ...input,
      scope: ProjectAccessScope.SETTINGS,
    });

    await this.storage.disableExternalSchemaComposition(input);

    return {
      ok: true,
    };
  }

  async enableExternalSchemaComposition(
    input: ProjectSelector & {
      endpoint: string;
      secret: string;
    }
  ) {
    this.logger.debug('Enabling external composition (input=%o)', lodash.omit(input, ['secret']));
    await this.authManager.ensureProjectAccess({
      ...input,
      scope: ProjectAccessScope.SETTINGS,
    });

    const parseResult = ENABLE_EXTERNAL_COMPOSITION_SCHEMA.safeParse({
      endpoint: input.endpoint,
      secret: input.secret,
    });

    if (!parseResult.success) {
      return {
        error: {
          message: parseResult.error.message,
          inputErrors: {
            endpoint: parseResult.error.formErrors.fieldErrors.endpoint?.[0],
            secret: parseResult.error.formErrors.fieldErrors.secret?.[0],
          },
        },
      };
    }

    const encryptedSecret = this.crypto.encrypt(input.secret);

    await this.storage.enableExternalSchemaComposition({
      project: input.project,
      organization: input.organization,
      endpoint: input.endpoint.trim(),
      encryptedSecret,
    });

    return {
      ok: {
        endpoint: input.endpoint,
      },
    };
  }
}
