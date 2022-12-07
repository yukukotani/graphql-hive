// eslint-disable-next-line import/no-extraneous-dependencies
import { ExecutionResult, print } from 'graphql';
import { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { createFetch } from '@whatwg-node/fetch';

// eslint-disable-next-line no-process-env
let registryUrl = process.env.SERVER_URL;

const { fetch } = createFetch({
  useNodeFetch: true,
});

export async function execute<TResult, TVariables>(
  params: {
    document: TypedDocumentNode<TResult, TVariables>;
    operationName?: string;
    authToken?: string;
    token?: string;
    legacyAuthorizationMode?: boolean;
  } & (TVariables extends Record<string, never>
    ? { variables?: never }
    : { variables: TVariables }),
) {
  if (!registryUrl) {
    const utils = await import('@n1ru4l/dockest/test-helper');
    registryUrl = `http://${utils.getServiceAddress('server', 3001)}`;
  }
  const response = await fetch(`${registryUrl}/graphql`, {
    method: 'POST',
    body: JSON.stringify({
      query: print(params.document),
      operationName: params.operationName,
      variables: params.variables,
    }),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(params.authToken
        ? {
            authorization: `Bearer ${params.authToken}`,
          }
        : {}),
      ...(params.token
        ? params.legacyAuthorizationMode
          ? {
              'x-api-token': params.token,
            }
          : {
              authorization: `Bearer ${params.token}`,
            }
        : {}),
    },
  });

  const body = (await response.json()) as ExecutionResult<TResult>;

  return {
    body,
    status: response.status,
  };
}
