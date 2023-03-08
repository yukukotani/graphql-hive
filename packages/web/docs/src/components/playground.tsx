import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import introspection from '../schema.json';
import 'graphiql/graphiql.css';

const defaultQuery = /* GraphQL */ `
  query myTokenInfo {
    tokenInfo {
      __typename
      ... on TokenInfo {
        token {
          name
        }
        organization {
          name
          cleanId
        }
        project {
          name
          type
          cleanId
        }
        target {
          name
          cleanId
        }
        canPublishSchema: hasTargetScope(scope: REGISTRY_WRITE)
        canCheckSchema: hasTargetScope(scope: REGISTRY_READ)
        canPublishOperations: hasProjectScope(scope: OPERATIONS_STORE_WRITE)
      }
      ... on TokenNotFoundError {
        message
      }
    }
  }
`;

const GraphiQL = dynamic(() => import('graphiql').then(r => r.GraphiQL), {
  ssr: false,
});

export const GraphQLApiPlayground = () => {
  const [token, setToken] = useState<string>();
  const fetcher = useMemo(
    () =>
      createGraphiQLFetcher({
        url: 'https://app.graphql-hive.com/graphql',
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
          }),
        schemaFetcher: () => ({ data: introspection }),
      }),
    [token],
  );

  return (
    <div>
      <style global jsx>{`
        .graphiql-container {
          --color-base: transparent !important;
          --color-primary: 40, 89%, 60% !important;
          height: 550px;
        }

        .nextra-toc {
          display: none;
        }
      `}</style>
      <div
        className="relative
        flex
        items-center
        gap-4
        rounded-sm
        bg-gray-800
        text-sm
        font-medium
        border
        border-gray-700
        focus-within:ring my-4"
      >
        <input
          placeholder="Hive Registry Access Token"
          type="password"
          className="p-2 rounded-sm w-full bg-transparent placeholder:text-gray-500 disabled:cursor-not-allowed"
          value={token}
          onChange={e => setToken(e.target.value)}
        />
      </div>
      <GraphiQL
        defaultQuery={defaultQuery}
        showPersistHeadersSettings={false}
        shouldPersistHeaders={false}
        isHeadersEditorEnabled={false}
        fetcher={fetcher}
      />
    </div>
  );
};
