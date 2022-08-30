import { TargetAccessScope, ProjectType } from '@app/gql/graphql';
import {
  createOrganization,
  publishSchema,
  deleteSchema,
  createProject,
  createToken,
  fetchLatestComposableVersion,
  fetchLatestSchema,
} from '../../../testkit/flow';
import { authenticate } from '../../../testkit/auth';

test('cannot delete a schema without target:registry:write access', async () => {
  const { access_token: owner_access_token } = await authenticate('main');
  const orgResult = await createOrganization(
    {
      name: 'foo',
    },
    owner_access_token
  );

  const org = orgResult.body.data!.createOrganization.ok!.createdOrganizationPayload.organization;

  const projectResult = await createProject(
    {
      organization: org.cleanId,
      type: ProjectType.Federation,
      name: 'foo',
    },
    owner_access_token
  );

  const project = projectResult.body.data!.createProject.ok!.createdProject;
  const target = projectResult.body.data!.createProject.ok!.createdTargets[0];

  const tokenResult = await createToken(
    {
      name: 'test',
      organization: org.cleanId,
      project: project.cleanId,
      target: target.cleanId,
      organizationScopes: [],
      projectScopes: [],
      targetScopes: [TargetAccessScope.RegistryRead],
    },
    owner_access_token
  );
  expect(tokenResult.body.errors).not.toBeDefined();

  const token = tokenResult.body.data!.createToken.ok!.secret;
  const result = await deleteSchema(
    {
      serviceName: 'foo',
    },
    token
  );

  expect(result.body.errors).toHaveLength(1);
  expect(result.body.errors![0].message).toMatch('target:registry:write');
});

test('can delete a service with target:registry:write access', async () => {
  const { access_token: owner_access_token } = await authenticate('main');
  const orgResult = await createOrganization(
    {
      name: 'foo',
    },
    owner_access_token
  );

  // Join
  const org = orgResult.body.data!.createOrganization.ok!.createdOrganizationPayload.organization;

  const projectResult = await createProject(
    {
      organization: org.cleanId,
      type: ProjectType.Federation,
      name: 'foo',
    },
    owner_access_token
  );

  const project = projectResult.body.data!.createProject.ok!.createdProject;
  const target = projectResult.body.data!.createProject.ok!.createdTargets[0];

  const tokenResult = await createToken(
    {
      name: 'test',
      organization: org.cleanId,
      project: project.cleanId,
      target: target.cleanId,
      organizationScopes: [],
      projectScopes: [],
      targetScopes: [TargetAccessScope.RegistryRead, TargetAccessScope.RegistryWrite],
    },
    owner_access_token
  );

  expect(tokenResult.body.errors).not.toBeDefined();

  const token = tokenResult.body.data!.createToken.ok!.secret;

  let result = await publishSchema(
    {
      author: 'Kamil',
      commit: 'c1',
      sdl: `type Query { ping: Ping } type Ping @key(fields: "id") { id: ID! name: String }`,
      service: 'ping',
      url: 'https://ping.com',
    },
    token
  );

  expect(result.body.errors).not.toBeDefined();
  expect(result.body.data!.schemaPublish.__typename).toBe('SchemaPublishSuccess');

  result = await publishSchema(
    {
      author: 'Kamil',
      commit: 'c2',
      sdl: `type Query { pong: Pong } type Pong @key(fields: "id") { id: ID! name: String }`,
      service: 'pong',
      url: 'https://pong.com',
    },
    token
  );

  expect(result.body.errors).not.toBeDefined();
  expect(result.body.data!.schemaPublish.__typename).toBe('SchemaPublishSuccess');

  // Tries to delete a service, but it's a breaking change
  let deleteResult = await deleteSchema(
    {
      serviceName: 'ping',
    },
    token
  );

  // It should be rejected
  expect(deleteResult.body.errors).not.toBeDefined();
  expect(deleteResult.body.data!.schemaDelete.ok).toBeNull();
  expect(deleteResult.body.data!.schemaDelete.errors?.total).toEqual(2);

  let latestValidResult = await fetchLatestComposableVersion(token);

  expect(latestValidResult.body.errors).not.toBeDefined();
  // expect the latest valid schema to contain two services
  expect(latestValidResult.body.data!.latestComposableVersion.schemas.total).toEqual(2);

  // Now, it tries to delete a service, but with --force
  deleteResult = await deleteSchema(
    {
      serviceName: 'ping',
      force: true,
    },
    token
  );

  // It should be accepted
  expect(deleteResult.body.errors).not.toBeDefined();
  expect(deleteResult.body.data!.schemaDelete.ok?.__typename).toBe('DeletedSchema');
  expect(deleteResult.body.data!.schemaDelete.errors).toBeNull();

  latestValidResult = await fetchLatestComposableVersion(token);

  expect(latestValidResult.body.errors).not.toBeDefined();
  // expect the latest valid schema to contain one service
  expect(latestValidResult.body.data!.latestComposableVersion.schemas.total).toEqual(1);
  const firstSchema = latestValidResult.body.data!.latestComposableVersion.schemas.nodes[0];
  expect('sdl' in firstSchema && firstSchema.sdl).toMatch(/pong/);
});

test('deleting a service should affect the composition status of the new version', async () => {
  const { access_token: owner_access_token } = await authenticate('main');
  const orgResult = await createOrganization(
    {
      name: 'foo',
    },
    owner_access_token
  );

  const org = orgResult.body.data!.createOrganization.ok!.createdOrganizationPayload.organization;

  const projectResult = await createProject(
    {
      organization: org.cleanId,
      type: ProjectType.Federation,
      name: 'foo',
    },
    owner_access_token
  );

  const project = projectResult.body.data!.createProject.ok!.createdProject;
  const target = projectResult.body.data!.createProject.ok!.createdTargets[0];

  const tokenResult = await createToken(
    {
      name: 'test',
      organization: org.cleanId,
      project: project.cleanId,
      target: target.cleanId,
      organizationScopes: [],
      projectScopes: [],
      targetScopes: [TargetAccessScope.RegistryRead, TargetAccessScope.RegistryWrite],
    },
    owner_access_token
  );

  expect(tokenResult.body.errors).not.toBeDefined();

  const token = tokenResult.body.data!.createToken.ok!.secret;

  let result = await publishSchema(
    {
      author: 'Kamil',
      commit: 'c1',
      sdl: `type Query { ping: Ping } type Ping @key(fields: "id") { id: ID! name: String }`,
      service: 'ping',
      url: 'https://ping.com',
    },
    token
  );

  expect(result.body.errors).not.toBeDefined();
  expect(result.body.data!.schemaPublish.__typename).toBe('SchemaPublishSuccess');

  result = await publishSchema(
    {
      author: 'Kamil',
      commit: 'c2',
      sdl: `
        type Query { pong: Pong }
        type Pong @key(fields: "id") {
          id: ID!
          name: String
        }
        
        extend type Ping @key(fields: "id") {
          id: ID! @external
          hasPong: Boolean
        }
        `,
      service: 'pong',
      url: 'https://pong.com',
    },
    token
  );

  expect(result.body.errors).not.toBeDefined();
  expect(result.body.data!.schemaPublish.__typename).toBe('SchemaPublishSuccess');

  // Tries to delete a service, but it's a breaking change
  const deleteResult = await deleteSchema(
    {
      serviceName: 'ping',
      force: true,
    },
    token
  );

  // It should be accepted
  expect(deleteResult.body.errors).not.toBeDefined();
  expect(deleteResult.body.data!.schemaDelete.ok?.__typename).toBe('DeletedSchema');
  expect(deleteResult.body.data!.schemaDelete.errors).toBeNull();

  const latestValidResult = await fetchLatestComposableVersion(token);
  expect(latestValidResult.body.errors).not.toBeDefined();
  expect(latestValidResult.body.data!.latestComposableVersion.schemas.total).toEqual(2);

  const latestResult = await fetchLatestSchema(token);
  expect(latestResult.body.errors).not.toBeDefined();
  expect(latestResult.body.data!.latestVersion.schemas.total).toEqual(1);
});

describe('legacy registry model', () => {
  test('cannot delete a service', async () => {
    const { access_token: owner_access_token } = await authenticate('main');
    const orgResult = await createOrganization(
      {
        name: 'foo',
      },
      owner_access_token
    );

    // Join
    const org = orgResult.body.data!.createOrganization.ok!.createdOrganizationPayload.organization;

    const projectResult = await createProject(
      {
        organization: org.cleanId,
        type: ProjectType.Federation,
        name: 'foo',
        useLegacyRegistryModel: true,
      },
      owner_access_token
    );

    const project = projectResult.body.data!.createProject.ok!.createdProject;
    const target = projectResult.body.data!.createProject.ok!.createdTargets[0];

    const tokenResult = await createToken(
      {
        name: 'test',
        organization: org.cleanId,
        project: project.cleanId,
        target: target.cleanId,
        organizationScopes: [],
        projectScopes: [],
        targetScopes: [TargetAccessScope.RegistryRead, TargetAccessScope.RegistryWrite],
      },
      owner_access_token
    );

    expect(tokenResult.body.errors).not.toBeDefined();

    const token = tokenResult.body.data!.createToken.ok!.secret;

    let result = await publishSchema(
      {
        author: 'Kamil',
        commit: 'c1',
        sdl: `type Query { ping: Ping } type Ping @key(fields: "id") { id: ID! name: String }`,
        service: 'ping',
        url: 'https://ping.com',
      },
      token
    );

    expect(result.body.errors).not.toBeDefined();
    expect(result.body.data!.schemaPublish.__typename).toBe('SchemaPublishSuccess');

    result = await publishSchema(
      {
        author: 'Kamil',
        commit: 'c2',
        sdl: `type Query { pong: Pong } type Pong @key(fields: "id") { id: ID! name: String }`,
        service: 'pong',
        url: 'https://pong.com',
      },
      token
    );

    expect(result.body.errors).not.toBeDefined();
    expect(result.body.data!.schemaPublish.__typename).toBe('SchemaPublishSuccess');

    const deleteResult = await deleteSchema(
      {
        serviceName: 'ping',
        force: true,
      },
      token
    );

    expect(deleteResult.body.errors).toHaveLength(1);
    expect(deleteResult.body.errors![0].message).toMatch(/not available/);
  });
});
