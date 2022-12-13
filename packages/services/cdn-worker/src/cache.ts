import { authHeaderName } from './common';

function createCacheKey(request: Request) {
  return JSON.stringify({
    url: request.url,
    headers: {
      [authHeaderName]: request.headers.get(authHeaderName),
      etag: request.headers.get('etag'),
    },
  });
}

export async function createCache(waitUntil: (promise: Promise<any>) => void) {
  const cache = await caches.open('cdn-cache');

  return {
    match(request: Request) {
      return cache.match(createCacheKey(request));
    },
    async wrap(request: Request, response: Response) {
      if (
        // 2XX
        (response.status >= 200 && response.status < 300) ||
        // 4XX
        (response.status >= 400 && response.status < 500)
      ) {
        response = new Response(response.body, response);

        // Cache for 5s
        response.headers.append('Cache-Control', 'public, s-max-age=5');
        // Scope it down to the auth header and ETag
        response.headers.append('Vary', `${authHeaderName}, ETag`);

        waitUntil(cache.put(createCacheKey(request), response.clone()));

        return response;
      }

      return response;
    },
  };
}

export type Cache = Awaited<ReturnType<typeof createCache>>;
