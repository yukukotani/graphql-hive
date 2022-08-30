import { Flags, Errors } from '@oclif/core';
import { renderErrors } from '../../helpers/schema';
import { graphqlEndpoint } from '../../helpers/config';
import Command from '../../base-command';

export default class SchemaDelete extends Command {
  static description = 'deletes schema';
  static flags = {
    registry: Flags.string({
      description: 'registry address',
    }),
    token: Flags.string({
      description: 'api token',
    }),
    require: Flags.string({
      description: 'Loads specific require.extensions before running the codegen and reading the configuration',
      default: [],
      multiple: true,
    }),
  };

  static args = [
    {
      name: 'service' as const,
      required: true,
      description: 'service name',
      hidden: false,
    },
  ];

  async run() {
    try {
      const { flags, args } = await this.parse(SchemaDelete);

      await this.require(flags);

      const registry = this.ensure({
        key: 'registry',
        args: flags,
        defaultValue: graphqlEndpoint,
        env: 'HIVE_REGISTRY',
      });
      const service: string = args.service;
      const token = this.ensure({
        key: 'token',
        args: flags,
        env: 'HIVE_TOKEN',
      });

      const result = await this.registryApi(registry, token).schemaDelete({
        input: {
          serviceName: service,
        },
      });

      const errors = result.schemaDelete.errors;

      if (errors) {
        renderErrors.call(this, errors);
        this.info('Use --force to delete the composite schema and ignore breaking changes and composition errors');
        this.exit(1);
      } else {
        this.success(`${service} deleted`);
      }
    } catch (error) {
      if (error instanceof Errors.ExitError) {
        throw error;
      } else {
        this.fail('Failed to delete schema');
        this.handleFetchError(error);
      }
    }
  }
}
