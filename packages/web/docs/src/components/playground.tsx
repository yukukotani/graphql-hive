import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import introspection from '../schema.json';
import 'graphiql/graphiql.css';

const GraphiQL = dynamic(() => import('graphiql').then(r => r.GraphiQL), {
  ssr: false,
});

export const GraphQLApiPlayground = () => {
  const [token, setToken] = useState<string>();
  const fetcher = useMemo(
    () =>
      createGraphiQLFetcher({
        url: 'https://app.graphql-hive.com/registry',
        fetch: (url, options) =>
          fetch(url, {
            ...options,
            headers: {
              'Content-Type': 'application/json',
              authorization: `Bearer ${token}`,
              'graphql-client-name': 'Hive Documentation',
              'graphql-client-version': '1',
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
        showPersistHeadersSettings={false}
        shouldPersistHeaders={false}
        isHeadersEditorEnabled={false}
        fetcher={fetcher}
      />
    </div>
  );
};
